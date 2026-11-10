import { createWorkspaceTools, readAgentMemory, INTERVIEW_POLICY, LIVE_MOCK_POLICY } from '../coach/workspace-tools.mjs';
import { createSessionContext } from '../coach/session-context.mjs';
import { buildConversation } from '../coach/native-sessions.mjs';
import { readLearningContext, refreshLearning } from '../learning/index.mjs';
import { readLearnerProfile, learnerContext } from '../learning/profile.mjs';
import { handoffRecords, contextReader, excerpt, evidenceRecords } from '../coach/context-policy.mjs';
import { readProblem } from '../learning/selection.mjs';
import { DESIGN_TOPICS, topicFor } from './topics.mjs';
import { buildDesignReport } from './report.mjs';
import { askRecordedInterview } from '../interview/routes.mjs';
import { pairFollowups, reviewSystemPrompt, reviewConversationKey, reviewTarget, reviewContextSections, reviewWorkspace } from '../interview/review.mjs';
import { data, debriefPrompt as structuredDebrief } from '../interview/prompt.mjs';
import { readReportDifficulty } from '../interview/report-difficulty.mjs';
import { newState as codingState } from '../interview/state.mjs';
// The system design interview, over HTTP.
//
//   POST /api/design/start   → SSE: the one-line problem statement
//   POST /api/design/turn    → SSE: the next question
//   POST /api/design/scene   → store the canvas (no model call, no answer)
//   POST /api/design/done    → SSE: the debrief
//   GET  /api/design         → past interviews
//   GET  /api/design/:id     → one interview, for replay
//
// The scene is posted separately from the turn on purpose. Drawing is not speaking: the
// canvas changes constantly and almost none of it deserves a reply, so scene posts are
// cheap writes that never wake the model. The interviewer sees the drawing on the next
// turn the candidate actually takes. That is also how a real interview works — the
// interviewer watches you draw and responds when you stop.

import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readJsonBody } from '../coach/http.mjs';
import { SseStream } from '../coach/sse.mjs';
import { readCoachChoice, runProviderTurn, stoppedProviderExit } from '../coach/provider.mjs';
import { readCoachMemory } from '../coach/provider-context.mjs';
import { upkeepQueue } from '../coach/upkeep.mjs';
import { isFillerReply } from '../../web/js/transcript-filter.js';
import { sceneToGraph } from './graph.mjs';
import { createNarrationFilter, salvageQuestion } from './narration.mjs';
import {
  newInterview, recordTurn, enterPhase, buildTurn, openingPrompt, systemPrompt,
  curveballDue, PHASE_IDS, DEFAULT_MINUTES, extractPhaseTag, createTagStripper, rehydratePrompt,
} from './interview.mjs';
import { DesignStore, newInterviewId, isSafeInterviewId } from './store.mjs';
import { writeInterviewDoc } from './render.mjs';

class DesignService {
  constructor({ root = HOME_ROOT, binary = process.env.STUDIO_COACH_BINARY || null, log = console } = {}) {
    this.root = root;
    this.binary = binary;
    this.log = log;
    this.store = new DesignStore({ root });
    // The claude session id per interview, so every turn continues one conversation.
    // Backed by interview.json as well as memory: an interview picked up next week has
    // outlived this process, and a thread that only exists in a Map is not resumable.
    this.sessions = new Map();
    // The graph as the interviewer last saw it, so an unchanged canvas is not re-sent.
    this.lastGraph = new Map();
    this.live = new Map();
    this.reviewLive = new Map();
    this.startRequests = new Set();
    this.clockWrites = new Map();
  }
}

const servicesByRoot = new Map();

function serviceFor(ctx) {
  if (ctx?.design instanceof DesignService) return ctx.design;
  const root = ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
  let service = servicesByRoot.get(root);
  if (!service) {
    service = new DesignService({ root, log: ctx?.log ?? console });
    servicesByRoot.set(root, service);
  }
  return service;
}

/** The CLI thread for an interview, from memory or from where it was last written. */
async function threadFor(svc, id) {
  if (svc.sessions.has(id)) return svc.sessions.get(id);
  const state = await svc.store.readState(id);
  const sid = state?.claudeSessionId ?? null;
  if (sid) svc.sessions.set(id, sid);
  return sid;
}

function rememberProvider(state, svc, id, choice) {
  state.coachProvider = choice.provider;
  state.coachModel = choice.model;
  state.coachReasoningEffort = choice.reasoningEffort || null;
  if (choice.provider === 'claude') state.claudeSessionId = svc.sessions.get(id) ?? state.claudeSessionId ?? null;
}

function idFrom(body, ctx) {
  const id = ctx?.params?.id ?? body?.interviewId;
  if (!isSafeInterviewId(id)) {
    throw new HttpError(400, 'BAD_REQUEST', '"interviewId" is required and must be an interview id.');
  }
  return id;
}
function extensionMinutes(body) {
  if (!Number.isInteger(body.minutes) || body.minutes < 1 || body.minutes > 240) throw new HttpError(400, 'BAD_REQUEST', 'Minutes must be a positive integer from 1 to 240.');
  if (typeof body.requestId !== 'string' || !/^[\w-]{1,100}$/.test(body.requestId)) throw new HttpError(400, 'BAD_REQUEST', 'A valid request identity is required.');
}

/**
 * Run one model turn into an SSE stream, with the impersonation guard on the tokens.
 *
 * The guard sits here rather than after the fact because "after the fact" is too late:
 * a token that has reached the browser has been read, and in voice mode it has been
 * spoken. Cutting the stream is the only point at which the candidate can still be
 * prevented from seeing an answer they did not give.
 */
async function streamTurn(svc, { id, choice, prompt, message = prompt, requestId = null, system = null, resume = null, stream, onFinished, kind = 'turn' }) {
  const reservation = svc.live.get(id);
  const savedState = await svc.store.readState(id);
  const debriefing = kind === 'debrief';
  const notes = debriefing && !savedState?.topicSlug ? excerpt((await readCoachMemory(svc.root,null,{files:[`design/${id}/NOTES.md`],cap:8000}))[0]?.text,4000) : '';
  const topic = savedState?.topicSlug || topicFor(savedState?.prompt || '').slug;
  const sessionRecords = () => svc.store.readTurns(id);
  const records = await sessionRecords();
  const query = records.findLast(t => t.said)?.said || '';
  const sessionContext = createSessionContext({root:svc.root,target:`design:${id}`,records:sessionRecords});
  const latestScene = await svc.store.readLatestScene(id);
  const graph = latestScene ? sceneToGraph(latestScene.elements || []) : savedState.graph || sceneToGraph([]);
  const reviewState = {...savedState,graph,statement:savedState.prompt,discipline:'design'};
  const agentMemory = debriefing ? await readAgentMemory(svc.root,topic,{query}) : null;
  const learner = debriefing ? learnerContext(await readLearnerProfile(svc.root,{excludeInterviewId:id,discipline:'design'}),{discipline:'design',slug:topic,query}) : null;
  const currentContext = debriefing
    ? reviewContextSections({state:reviewState,turns:records,agentMemory,learnerHistory:learner,notes})
    : [['Problem',savedState.prompt],['Private scenario facts',savedState.problem],
      ['Session decisions and unresolved questions',await sessionContext.delivery(query)],
      ['Current whiteboard',graph],
      ['Interview metadata',{mode:savedState.mode,phase:savedState.phase,minutes:savedState.minutes,gaps:savedState.gaps,curveballDone:savedState.curveballDone}],
      ['Recorded agent assistance',records.filter(t => t.kind === 'tool_action' && t.action.status === 'done').map(t => ({at:t.at,tool:t.action.tool,summary:t.action.summary}))]];
  const conversation = buildConversation({key:debriefing ? reviewConversationKey('design',id) : `design:${id}`,requestId,message,context:currentContext,
    bootstrap:{instructions:debriefing ? '' : LIVE_MOCK_POLICY,sessionTools:!debriefing,
      sections:debriefing ? [] : [['Full saved interview record',handoffRecords(evidenceRecords(records.filter(t => !requestId || t.requestId !== requestId)),{query})]]}});
  prompt = conversation.bootstrapPrompt;
  const agentTools = await createWorkspaceTools({root:svc.root,slug:topic,target:debriefing ? reviewTarget('design',id) : `design:${id}`,req:stream.res.req,stream,kind:debriefing ? 'review' : 'board',liveMock:!debriefing,
    getState:debriefing ? async () => reviewWorkspace(reviewState) : async () => ({elements:(await svc.store.readLatestScene(id))?.elements || []}),
    readContext:contextReader(debriefing ? {session:sessionRecords,followups:()=>svc.store.readFollowups(id)} : {session:sessionRecords,scenes:()=>svc.store.readScenes(id)}),
    ...(!debriefing ? {sessionContext} : {}),sessionRecords,
    onAction:action => svc.store.appendTurn(id,{kind:'tool_action',...(debriefing ? {reviewActivity:true} : {}),at:new Date().toISOString(),action:structuredClone(action),elapsedMs:Math.max(0,Date.now()-savedState.startedAt)}),
  });
  const started = Date.now();
  let first = null;
  let tools = 0;
  let timed = false;
  const timing = () => {
    if (timed) return;
    timed = true;
    svc.log?.info?.(`[coach] timing design:${id} ${kind} provider=${choice.provider} model=${choice.model} first=${first ?? '-'} total=${Date.now() - started} tools=${tools}`);
  };
  const sessionKey = choice.provider === 'claude' ? id : `codex:${id}`;
  const filter = createNarrationFilter();
  let broke = false;
  let finished = false;
  let lastPhase = null;
  const tags = createTagStripper();
  // A filler reply cannot be taken back once spoken, so an answer waits until its first
  // complete sentence proves otherwise. Speech starts on that sentence anyway.
  let held = '', released = kind !== 'turn';
  const show = (text) => {
    if (!text) return;
    if (released) { stream.token(text); return; }
    held += text;
    const sentences = held.match(/^[\s\S]*[.?!](?=\s|$)/)?.[0];
    if (sentences && !isFillerReply(sentences)) { released = true; stream.token(held); held = ''; }
  };

  /**
   * End the turn exactly once.
   *
   * This cannot be left to runCoachTurn's onDone. That callback is deliberately skipped
   * when the caller killed the child — "we killed it on purpose, nobody is listening" —
   * which is true for the coach's Stop button, where the run is detached from any
   * response. Here the opposite holds: the guard kills the child while an SSE response
   * is still open, so relying on onDone left the stream unclosed and the browser waiting
   * on a turn that had already ended.
   */
  async function finish(sessionId = null, stoppedReason = null, failure = null, commit) {
    if (finished) return;
    finished = true;
    await agentTools.dispose();
    if (['success', 'end_turn', 'completed'].includes(stoppedReason)) stoppedReason = null;
    timing();
    if (!broke) {
      // Release anything the guard was still holding — a line that never became a
      // label must not cost the turn its last few words. The phase tag is held by the
      // same rule (it opens with a bracket), which is why stripping it here catches it
      // before a single character has been shown or spoken.
      show(tags.push(filter.flush()) + tags.flush());
    }
    const filler = !broke && !failure && !stoppedReason && held.trim() && isFillerReply(held) ? held : null;
    if (held && !filler) stream.token(held);
    if (!broke && !filler && tags.phase) { lastPhase = tags.phase; stream.send('phase', { phase: tags.phase }); }
    if (sessionId) svc.sessions.set(sessionKey, sessionId);
    const finalTags = createTagStripper();
    const asked = filler ? '' : (finalTags.push(broke ? (salvageQuestion(filter.text()) ?? '') : filter.text()) + finalTags.flush()).trim();
    try {
      await onFinished(asked, { broke: broke || Boolean(stoppedReason), phase: lastPhase, gap: tags.gap, curveball: tags.curveball, filler, tagged: tags.tagged });
      if (!failure && !broke && !stoppedReason) await commit?.();
    } catch (err) {
      svc.log?.warn?.(`[design] ${id}: ${err.message}`);
      svc.live.delete(id); settle(); stream.error('Could not save the interview response. Your recorded input is preserved.'); throw err;
    }
    svc.live.delete(id);
    settle();
    if (failure) stream.error(failure);
    else { stream.send('done', { sessionId, stoppedReason, broke, asked, silent: kind === 'turn' && !asked && !broke && !stoppedReason && Boolean(filler || tags.tagged) }); stream.end(); }
    timing();
  }

  let settle;
  const completion = new Promise(resolve => { settle = resolve; });
  if (reservation?.settle) completion.then(reservation.settle);
  const child = runProviderTurn({
    choice,
    root: svc.root,
    discipline:'design', coachingMode: kind === 'debrief' ? 'review' : 'mock',
    binary: svc.binary,
    systemPrompt:debriefing ? reviewSystemPrompt() : system || systemPrompt({level:savedState.level,minutes:savedState.originalMinutes || savedState.minutes}), prompt,
    conversation,
    resumeSessionId: resume,
    tools: '', ...agentTools.options,
    onToken: (text) => {
      first ??= Date.now() - started;
      const { text: safe, tripped } = filter.push(text);
      // The phase tag rides the same pipe as speech, so it is pulled out here — before
      // a single character of it can be shown or spoken.
      const shown = tags.push(safe);
      show(shown);
      if (tripped && !broke) {
        broke = true;
        // Said plainly rather than hidden. The candidate is about to see a turn end
        // early, and "the model started answering for you" is the honest reason.
        stream.send('broke-character', {
          kept: Boolean(salvageQuestion(filter.text())),
        });
        svc.log?.warn?.(`[design] ${id}: cut the turn — the interviewer began writing the candidate's answer`);
        // Close the books here, then kill. Killing first would race the child's own
        // exit for who gets to end the stream, and on the branch where we win, nobody
        // ends it at all.
        finish(svc.sessions.get(sessionKey) ?? resume, 'broke-character');
        child.kill();
      }
    },
    onTool: (name, summary) => { tools++; stream.tool(name, summary); },
    onSessionId: (sid) => { if (sid) svc.sessions.set(sessionKey, sid); },
    onError: async (message) => {
      if (finished) return;
      return finish(null, 'provider-error', message);
    },
    onDone: (sessionId, stoppedReason, commit) => finish(sessionId, stoppedReason, null, commit),
  });

  child.exited?.then(timing, timing);
  child.completion = completion.then(() => child.exited);
  child.detachWaiters = settle;
  svc.live.set(id, child);
  stream.res.on('close', () => { /* a disconnect detaches a viewer; the turn continues */ });
  return child;
}

/** POST /api/design/start */
async function handleStart(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const requestId = body.requestId;
  if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(requestId))) throw new HttpError(400, 'BAD_REQUEST', 'Invalid start request.');
  if (requestId && svc.startRequests.has(requestId)) throw new HttpError(409, 'BUSY', 'This mock is already starting.');
  if (requestId) svc.startRequests.add(requestId);
  let pending = false;
  try {
    const child = await startDesign(svc, body, res);
    if (requestId && child?.completion) { pending = true; void child.completion.finally(() => svc.startRequests.delete(requestId)); }
  } finally { if (requestId && !pending) svc.startRequests.delete(requestId); }
}
async function startDesign(svc, body, res) {
  const choice = await readCoachChoice(svc.root, svc);
  let prior = null;
  if (body.requestId) for (const id of await svc.store.list()) {
    const saved = await svc.store.readState(id);
    if (saved?.startRequestId === body.requestId) { prior = { id, state: saved }; break; }
  }
  let problem = null;
  if (body.problemSlug) {
    problem = await readProblem(svc.root, body.problemSlug);
    if (!problem || problem.discipline !== 'design' || problem.statement !== body.prompt) throw new HttpError(400, 'BAD_REQUEST', 'Prepared problem does not match this interview.');
  }
  const id = prior?.id || newInterviewId();
  const now = Date.now();

  const config = { prompt: body.prompt || null, level: body.level || 'L4', minutes: body.minutes || DEFAULT_MINUTES, problemSlug: body.problemSlug || null };
  if (prior && JSON.stringify(prior.state.startConfig) !== JSON.stringify(config)) throw new HttpError(409, 'REQUEST_REUSED', 'This start request belongs to different interview settings.');
  const state = prior?.state || newInterview({
    prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null,
    level: typeof body.level === 'string' && body.level.trim() ? body.level.trim() : 'L4',
    minutes: Number.isFinite(body.minutes) ? Number(body.minutes) : DEFAULT_MINUTES,
    startedAt: now,
  });
  if (!prior) {
    if (state.prompt) state.topicSlug = topicFor(state.prompt).slug;
    if (problem) { state.topicSlug = problem.slug; state.problem = problem; }
    state.mode = body.mode === 'typed' ? 'typed' : 'voice';
    state.startRequestId = body.requestId || null; state.startConfig = config;
    await svc.store.create(id, state);
  }

  const stream = new SseStream(res);
  stream.send('interview', { id, startedAt: new Date(state.startedAt).toISOString(), level: state.level, minutes: state.minutes, mode: state.mode, topicSlug: state.topicSlug });

  if (prior) {
    const opening = (await svc.store.readTurns(id)).find(t => t.kind === 'opening' && t.asked);
    if (opening) { stream.token(opening.asked); stream.send('done', { asked: opening.asked, replayed: true }); stream.end(); return; }
  }
  if (state.problem) {
    const asked = state.problem.statement, at = new Date().toISOString();
    rememberProvider(state, svc, id, choice);
    recordTurn(state, { asked, at });
    await svc.store.appendTurn(id, { at, kind: 'opening', elapsedMs: 0, asked });
    await svc.store.writeState(id, state);
    stream.token(asked); stream.send('done', { asked }); stream.end(); return;
  }
  // Only the opening turn carries the character; every later turn resumes the session.
  const avoid = state.prompt ? [] : await svc.store.pastPrompts();
  const child = await streamTurn(svc, {
    id,
    choice,
    system: systemPrompt({ level: state.level, minutes: state.originalMinutes || state.minutes }),
    prompt: openingPrompt(state, { avoid }),
    kind: 'opening',
    resume: null,
    stream,
    onFinished: async (asked) => {
      rememberProvider(state, svc, id, choice);
      // The model chose the problem; that choice is the interview's identity, so it is
      // recorded rather than re-derived later from the transcript.
      if (!state.prompt && asked) state.prompt = asked.trim().split('\n')[0].slice(0, 300);
      recordTurn(state, { asked, at: new Date().toISOString() });
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'opening', elapsedMs: Math.max(0, Date.now() - state.startedAt), provider: choice.provider, model: choice.model, asked });
      const current = await svc.store.readState(id);
      for (const key of ['pausedAt', 'spentMs', 'startedAt']) {
        if (current && key in current) state[key] = current[key];
      }
      await svc.store.writeState(id, state);
    },
  });
  return child;
}

function reserveTurn(svc, id) {
  if (svc.live.has(id)) throw new HttpError(409, 'BUSY', 'The interviewer is still finishing a turn.');
  let settle;
  const completion = new Promise(resolve => { settle = resolve; });
  const marker = { reservation: true, completion, settle, kill() {}, detachWaiters: settle };
  svc.live.set(id, marker);
  return () => { if (svc.live.get(id) === marker) { svc.live.delete(id); settle(); } };
}

/** POST /api/design/turn */
async function handleTurn(req, res, ctx) {
  const svc = serviceFor(ctx), body = await readJsonBody(req), id = idFrom(body, ctx);
  const release = reserveTurn(svc, id);
  try {
    const state = await svc.store.readState(id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
    if (state.debriefed) throw new HttpError(409, 'CONFLICT', 'That interview is already finished.');
    const choice = await readCoachChoice(svc.root, svc);
    const requestId = typeof body.requestId === 'string' && body.requestId.length > 0 && body.requestId.length <= 100 ? body.requestId : null;
    const said = typeof body.said === 'string' ? body.said.trim() : '';
    if (said.length > 40000) throw new HttpError(400, 'BAD_REQUEST', 'This answer is too long.');
    const history = await svc.store.readTurns(id);
    const accepted = requestId && history.find(t => t.kind === 'candidate' && t.requestId === requestId);
    if (accepted && accepted.said !== said) throw new HttpError(409, 'CONFLICT', 'This request belongs to a different answer.');
    const completed = requestId && history.find(t => ['turn', 'interviewer_silent', 'suppressed_filler'].includes(t.kind) && t.requestId === requestId && !t.interrupted);
    if (completed) {
      const stream = new SseStream(res);
      stream.send('accepted', { requestId, said, replayed: true });
      if (completed.asked) stream.token(completed.asked);
      stream.send('done', { asked: completed.asked ?? '', replayed: true, silent: completed.kind !== 'turn' }); stream.end(); return;
    }
    if (PHASE_IDS.includes(body.phase)) enterPhase(state, body.phase);
    if (['typed', 'voice'].includes(body.mode)) state.mode = body.mode;
    const savedScenes = await svc.store.readScenes(id);
    const graph = Array.isArray(body.elements) ? sceneToGraph(body.elements) : savedScenes.length ? sceneToGraph(savedScenes.at(-1).elements) : (state.graph ?? null);
    if (Array.isArray(body.elements)) { state.graph = graph; await svc.store.appendScene(id, body.elements); }
    const now = Date.now();
    // The candidate's answer survives CLI failure, a disconnected viewer and a server restart.
    if (requestId && !accepted) {
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'candidate', requestId, said, phase: state.phase, elapsedMs: Math.max(0, now - state.startedAt) });
    }
    await svc.store.writeState(id, state);
    const turn = buildTurn(state, { said, graph, previousGraph: svc.lastGraph.get(id) ?? null, now, includeWorkspace:false });
    const resume = null;
    const prompt = turn.text;
    const stream = new SseStream(res);
    if (requestId) stream.send('accepted', { requestId, said });
    await streamTurn(svc, {
      id, choice, prompt, message:turn.text, requestId, system: resume ? null : systemPrompt({ level: state.level, minutes: state.originalMinutes || state.minutes }), resume, stream,
      onFinished: async (asked, { phase, broke, gap, curveball, filler, tagged } = {}) => {
        rememberProvider(state, svc, id, choice);
        state.rehydrate = false;
        if (phase) enterPhase(state, phase);
        if (!broke && curveball) state.curveballDone = true;
        recordTurn(state, { said: accepted ? '' : said, asked, at: new Date().toISOString(), gap: gap ?? null });
        // Tags alone mean the interviewer chose silence; the candidate's words stay on record.
        const replyKind = filler ? 'suppressed_filler' : !asked && !broke && tagged ? 'interviewer_silent' : 'turn';
        await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: replyKind, elapsedMs: Math.max(0, Date.now() - state.startedAt), provider: choice.provider, model: choice.model, ...(requestId ? { requestId, interrupted: Boolean(broke) } : { said }), ...(filler ? { raw: filler } : { asked }), phase: state.phase });
        const current = await svc.store.readState(id);
        for (const key of ['pausedAt', 'spentMs', 'startedAt', 'graph']) { if (current && key in current) state[key] = current[key]; }
        const durable = await svc.store.readTurns(id);
        const count = text => String(text || '').match(/\S+/g)?.length || 0;
        state.words = { candidate: durable.reduce((n, t) => n + count(t.said), 0), interviewer: durable.filter(t => t.kind !== 'debrief').reduce((n, t) => n + count(t.asked), 0) };
        await svc.store.writeState(id, state);
        svc.lastGraph.set(id, graph);
      },
    });
  } finally { release(); }
}

/** POST /api/design/scene — a write, never a turn. */
async function handleScene(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
  if (!Array.isArray(body.elements)) {
    throw new HttpError(400, 'BAD_REQUEST', '"elements" must be the scene array.');
  }
  if (state.debriefed) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
  const index = await svc.store.appendScene(id, body.elements);
  // Scenes are canonical. Avoid an autosave overwriting a concurrently completed turn's state.
  return sendJson(res, 200, { ok: true, scenes: index + 1 });
}

/** POST /api/design/done */
async function handleDone(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const release = reserveTurn(svc, id);
  try {
  const choice = await readCoachChoice(svc.root, svc);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');

  if (state.debriefed) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
  if (Array.isArray(body.elements)) {
    state.graph = sceneToGraph(body.elements);
    await svc.store.appendScene(id, body.elements);
  }

  const resume = null;
  await svc.store.writeState(id, state);
  const said = typeof body.said === 'string' ? body.said.trim() : '';
  if (said.length > 40000) throw new HttpError(400, 'BAD_REQUEST', 'This answer is too long.');
  const requestId = typeof body.requestId === 'string' && body.requestId.length <= 100 ? body.requestId : null;
  const earlier = await svc.store.readTurns(id);
  const accepted = requestId && earlier.find(t => t.kind === 'candidate' && t.requestId === requestId);
  if (accepted && accepted.said !== said) throw new HttpError(409, 'CONFLICT', 'This request belongs to a different answer.');
  if (said && !accepted) await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'candidate', requestId, said, phase: state.phase, elapsedMs: Math.max(0, Date.now() - state.startedAt) });
  const savedScenes = await svc.store.readScenes(id);
  if (savedScenes.length) state.graph = sceneToGraph(savedScenes.at(-1).elements);
  const evidence = await svc.store.readTurns(id);
  // Saved with the finished report below; a failed attempt saves nothing, so trying again reads the current setting.
  state.reportDifficulty = await readReportDifficulty(svc.root);
  const reportState = { ...codingState({ slug: 'system-design', startedAt: state.startedAt }), statement: state.prompt, discipline: 'design', targetLevel: state.level, minutes: state.minutes, endedAt: Date.now(), reportDifficulty: state.reportDifficulty };
  const turn = structuredDebrief(reportState, evidence, Date.now(), {includeEvidence:false});
  const prompt = turn; // The structured debrief already includes the timestamped record.
  const stream = new SseStream(res);
  if (requestId) stream.send('accepted', { requestId, said });
  await streamTurn(svc, {
    id,
    choice,
    prompt,
    system: resume ? null : systemPrompt({ level: state.level, minutes: state.originalMinutes || state.minutes }),
    kind: 'debrief',
    message: turn, requestId,
    resume,
    stream,
    onFinished: async (asked, { broke }) => {
      if (broke || !asked.trim()) {
        await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'partial', replyKind: 'debrief', asked });
        return;
      }
      rememberProvider(state, svc, id, choice);
      state.debriefed = true;
      state.endedAt = Date.now();
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'debrief', elapsedMs: Math.max(0, Date.now() - state.startedAt), provider: choice.provider, model: choice.model, asked });
      const current = await svc.store.readState(id);
      for (const key of ['pausedAt', 'spentMs', 'startedAt']) {
        if (current && key in current) state[key] = current[key];
      }
      await svc.store.writeState(id, state);
      await refreshLearning(svc.root, state.topicSlug || topicFor(state.prompt).slug);
      // Derived, and written here so the file exists the moment the interview ends.
      await writeInterviewDoc({ root: svc.root, id }).catch((err) => {
        svc.log?.warn?.(`[design] could not write interview.md for ${id}: ${err.message}`);
      });
    },
  });
  } finally { release(); }
}

/** POST /api/design/stop — abandon the current turn, keep the interview. */
async function handleStop(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const child = svc.live.get(id);
  if (child) { child.kill(); child.detachWaiters?.(); }
  svc.live.delete(id);
  await stoppedProviderExit(child);
  return sendJson(res, 200, { stopped: Boolean(child) });
}

/** GET /api/design */
async function handleList(req, res, ctx) {
  const svc = serviceFor(ctx);
  const ids = await svc.store.list();
  const interviews = [];
  for (const id of ids) {
    const state = await svc.store.readState(id);
    if (!state) continue;
    interviews.push({
      id,
      topicSlug: state.topicSlug || topicFor(state.prompt).slug,
      prompt: state.prompt,
      level: state.level,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      debriefed: Boolean(state.debriefed),
      reportDifficulty: state.reportDifficulty,
      turns: state.turns?.length ?? 0,
    });
  }
  return sendJson(res, 200, { interviews, topics: DESIGN_TOPICS });
}

/**
 * GET /api/design/:id — everything needed to pick an interview back up.
 *
 * Returns the board as it was last left, not a list of snapshots: resuming means
 * finding the room exactly as you walked out of it. `resumable` is false once the
 * debrief has been given, because an interview that has been graded is a record, and
 * reopening it to ask another question would make the grade a lie.
 */
async function handleGet(req, res, ctx) {
  const svc = serviceFor(ctx);
  const id = idFrom({}, ctx);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
  const scenes = await svc.store.readScenes(id);
  const turns = await svc.store.readTurns(id);
  return sendJson(res, 200, {
    id,
    prompt: state.prompt,
    topicSlug: state.topicSlug || topicFor(state.prompt).slug,
    level: state.level,
    minutes: state.minutes,
    phase: state.phase,
    mode: state.mode || 'typed',
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    debriefed: Boolean(state.debriefed),
    reportDifficulty: state.reportDifficulty,
    // Resumable whenever it is unfinished. A missing CLI thread is not the end of the
    // interview — the questions and answers are all in turns.jsonl, so a fresh thread
    // can be handed the transcript and carry on. What is lost is the model's own
    // memory of its reasoning, not the interview.
    resumable: !state.debriefed,
    // True when continuing will start a new thread from the written record, which is
    // worth saying out loud rather than pretending nothing happened.
    rebuilt: !state.debriefed && !state.claudeSessionId,
    elapsedMs: state.startedAt ? (state.endedAt ?? Date.now()) - state.startedAt : null,
    turns,
    elements: scenes.length ? scenes[scenes.length - 1].elements : [],
    scenes: scenes.length,
    report: buildDesignReport(state, turns),
    followups: pairFollowups(await svc.store.readFollowups(id)).map(f => ({ ...f, pending: svc.reviewLive.get(`review/design/${id}`)?.requestId === f.requestId })),
  });
}

/**
 * POST /api/design/resume — carry on where you left off.
 *
 * The clock is the interesting part. An interview resumed the next day has an elapsed
 * time of eighteen hours, which would put the phase machine past the end and fire the
 * debrief nudge immediately. So the start time is shifted forward to keep the *time
 * spent* intact: pick it up tomorrow and you have as many minutes left as you did when
 * you closed the tab.
 */
async function handleResume(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  // Returning during generation waits for the recorded question, without a new turn.
  await svc.live.get(id)?.completion;
  return withClockWrite(svc, id, async () => {
    const state = await svc.store.readState(id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
    if (state.debriefed) {
      throw new HttpError(409, 'CONFLICT', 'That interview has already been debriefed. Start a new one.');
    }
    const spent = state.pausedAt && Number.isFinite(state.spentMs) ? state.spentMs
      : (state.startedAt ? (state.pausedAt ?? Date.now()) - state.startedAt : 0);
    state.startedAt = Date.now() - spent;
    state.pausedAt = null;
    // No thread to resume: the next turn rebuilds one from the transcript instead of
    // refusing. Flagged rather than done here, because it only costs anything on the
    // turn that actually needs it.
    if (!(await threadFor(svc, id))) state.rehydrate = true;
    await svc.store.writeState(id, state);
    svc.lastGraph.delete(id);   // re-show the board on the first turn back

    const scenes = await svc.store.readScenes(id);
    return sendJson(res, 200, {
      id,
      prompt: state.prompt,
      topicSlug: state.topicSlug || topicFor(state.prompt).slug,
      level: state.level,
      minutes: state.minutes,
      phase: state.phase,
      startedAt: new Date(state.startedAt).toISOString(),
      resumed: true,
      mode: state.mode || 'typed',
      thread: Boolean(await threadFor(svc, id)),
      rebuilt: Boolean(state.rehydrate),
      turns: await svc.store.readTurns(id),
      elements: scenes.length ? scenes[scenes.length - 1].elements : [],
    });
  });
}

/** POST /api/design/pause — stop the clock so a day away is not 18 hours of interview. */
async function handlePause(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  return withClockWrite(svc, id, async () => {
    const state = await svc.store.readState(id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
    if (state.debriefed) throw new HttpError(409, 'CONFLICT', 'This interview is already complete.');
    if (!state.pausedAt) {
      state.pausedAt = Date.now();
      state.spentMs = state.startedAt ? Math.max(0, state.pausedAt - state.startedAt) : 0;
    }
    await svc.store.writeState(id, state);
    return sendJson(res, 200, { ok: true, spentMs: state.spentMs });
  });
}

// Pause can arrive on navigation while a turn runs. Serialize clock mutations so
// a pause/resume snapshot cannot overwrite an extension accepted at the same time.
async function withClockWrite(svc, id, operation) {
  const previous = svc.clockWrites.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  svc.clockWrites.set(id, current);
  try { return await current; }
  finally { if (svc.clockWrites.get(id) === current) svc.clockWrites.delete(id); }
}

/** POST /api/design/extend — change the advisory budget without a model turn. */
async function handleExtend(req, res, ctx) {
  const svc = serviceFor(ctx), body = await readJsonBody(req); extensionMinutes(body);
  const id = idFrom(body, ctx), release = reserveTurn(svc, id);
  try { return await withClockWrite(svc, id, async () => {
    const state = await svc.store.readState(id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
    state.extensions ??= {};
    const prior = state.extensions[body.requestId];
    if (prior) {
      if (prior.minutes !== body.minutes) throw new HttpError(409, 'REQUEST_REUSED', 'This request identity was already used for another extension.');
      return sendJson(res, 200, { duplicate: true, state: { ...state } });
    }
    if (state.debriefed || state.endedAt != null) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
    state.originalMinutes ??= state.minutes;
    state.minutes += body.minutes;
    state.extensions[body.requestId] = { minutes: body.minutes };
    await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'time_extended', minutes: body.minutes, requestId: body.requestId });
    await svc.store.writeState(id, state);
    return sendJson(res, 200, { state: { ...state } });
  }); } finally { release(); }
}

async function handleAsk(req, res, ctx) {
  const body = await readJsonBody(req), svc = serviceFor(ctx), id = idFrom(body, ctx);
  return askRecordedInterview({ ...body, slug: 'design', interviewId: id }, res, {
    root: svc.root, binary: svc.binary, run: runProviderTurn, live: svc.reviewLive,
    buildReport: buildDesignReport,
    store: {
      readState: async (_, id) => {
        const state = await svc.store.readState(id);
        if (!state) return null;
        const learningNotes = !state.topicSlug ? excerpt((await readCoachMemory(svc.root,null,{files:[`design/${id}/NOTES.md`],cap:8000}))[0]?.text,4000) : '';
        return {...state,statement:state.prompt,discipline:'design',topicSlug:state.topicSlug || topicFor(state.prompt).slug,learningNotes};
      },
      readTurns: (_, id) => svc.store.readTurns(id),
      readFollowups: (_, id) => svc.store.readFollowups(id),
      appendFollowup: (_, id, entry) => svc.store.appendFollowup(id, entry),
    },
  });
}

export const routes = {
  'POST /api/design/mode': async (req, res, ctx) => {
    const svc = serviceFor(ctx), body = await readJsonBody(req), id = idFrom(body, ctx);
    if (!['typed', 'voice'].includes(body.mode)) throw new HttpError(400, 'BAD_REQUEST', 'Choose Typed or Voice.');
    const release = reserveTurn(svc, id);
    try {
      const state = await svc.store.readState(id);
      if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
      if (state.debriefed) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
      if (state.mode !== body.mode) {
        state.mode = body.mode;
        await svc.store.appendTurn(id, { kind: 'mode', mode: body.mode, at: new Date().toISOString() });
        await svc.store.writeState(id, state);
      }
      return sendJson(res, 200, { mode: state.mode });
    } finally { release(); }
  },
  'POST /api/design/ask': handleAsk,
  'POST /api/design/start': handleStart,
  'POST /api/design/turn': handleTurn,
  'POST /api/design/scene': handleScene,
  'POST /api/design/done': handleDone,
  'POST /api/design/stop': handleStop,
  'POST /api/design/resume': handleResume,
  'POST /api/design/pause': handlePause,
  'POST /api/design/extend': handleExtend,
  'GET /api/design': handleList,
  'GET /api/design/:id': handleGet,
};

export { DesignService };
export default routes;
