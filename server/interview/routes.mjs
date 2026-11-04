import { runPythonScript } from '../runner/python-script.mjs';
import { createWorkspaceTools, readAgentMemory, INTERVIEW_POLICY } from '../coach/workspace-tools.mjs';
import { readLearningContext, refreshLearning } from '../learning/index.mjs';
import { readLearnerProfile, learnerContext } from '../learning/profile.mjs';
import { readProblem } from '../learning/selection.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HOME_ROOT } from '../paths.mjs';
import { HttpError, sendJson } from '../http-util.mjs';
import { readJsonBody } from '../coach/http.mjs';
import { SseStream } from '../coach/sse.mjs';
import { readCoachChoice, runProviderTurn } from '../coach/provider.mjs';
import { createNarrationFilter } from '../design/narration.mjs';
import { newState, pause, resume, elapsed, advance, recordHints, observe, shouldInterject } from './state.mjs';
import { data, systemPrompt, lldSystemPrompt, turnPrompt, rehydratePrompt, debriefPrompt } from './prompt.mjs';
import { createSessionContext } from '../coach/session-context.mjs';
import { contextPacket } from '../coach/context-packet.mjs';
import { handoffRecords, selectRecords, evidenceRecords } from '../coach/context-policy.mjs';
import { parseReport, buildReport } from './report.mjs';
import { createTagStripper } from './narration.mjs';
import { InterviewStore, validate } from './store.mjs';
import { writeInterviewDoc } from './render.mjs';
import { MAX_QUESTION, reviewSystemPrompt, reviewPrompt, pairFollowups } from './review.mjs';
import { filterTranscript, isFillerReply } from '../../web/js/transcript-filter.js';
import { scenario as lldScenario } from '../lld/scenarios.mjs';
import { problemDir, listProblemSlugs, disciplineForSlug } from '../storage-layout.mjs';
import { contextReader } from '../coach/context-policy.mjs';

export class InterviewService {
  constructor({ root = HOME_ROOT, binary = process.env.STUDIO_COACH_BINARY, run = runProviderTurn } = {}) {
    this.root = root; this.binary = binary; this.run = run;
    this.store = new InterviewStore({ root });
    this.live = new Map(); this.conversations = new Map();
  }
}
const services = new Map();
function service(ctx) {
  if (ctx?.interview) return ctx.interview;
  const root = ctx?.homeRoot ?? HOME_ROOT;
  if (!services.has(root)) services.set(root, new InterviewService({ root }));
  return services.get(root);
}
const keyOf = (slug, id) => `${slug}/${id}`;
function publicState(state, busy = false) {
  const { statement, scenario, lastCode, requests, claudeSessionId, ...rest } = state;
  const generation = Object.values(requests || {}).filter(r => ['accepted', 'failed', 'completed'].includes(r.status));
  const latest = generation.at(-1) || null;
  const latestCompleted = [...generation].reverse().find(r => r.status === 'completed');
  const needsAttention = !busy && Boolean(latest && ['accepted', 'failed'].includes(latest.status) && (!latestCompleted || generation.lastIndexOf(latest) > generation.lastIndexOf(latestCompleted)));
  return { ...rest, status: state.debriefed ? 'completed' : state.pausedAt !== null ? 'paused' : needsAttention ? 'needs_attention' : 'in_progress', needsAttention, lastRequestStatus: latest?.status || null };
}
function reserve(svc, key) {
  if (svc.live.has(key)) throw new HttpError(409, 'BUSY', 'The interviewer is still finishing a turn.');
  let resolve;
  const slot = { completion: new Promise(r => { resolve = r; }), stop: null };
  slot.release = () => { if (svc.live.get(key) === slot) svc.live.delete(key); resolve(); };
  // Reserve synchronously before a read can yield to another request.
  svc.live.set(key, slot);
  return slot;
}
async function readStatement(root, slug) {
  try {
    const cached = JSON.parse(await fs.readFile(path.join(root, 'cache', 'leetcode', `${slug}.json`), 'utf8'));
    const question = cached.question || cached.data?.question || cached;
    const content = cached.content || {};
    const description = question.content || content.descriptionHtml || cached.descriptionHtml;
    if (typeof description !== 'string' || !description.trim()) throw new HttpError(409, 'NO_STATEMENT', 'This problem has no cached statement for the interviewer.');
    return `${question.title || content.title || slug}\n${description}`;
  } catch (error) {
    if (error.code === 'ENOENT') throw new HttpError(409, 'NO_STATEMENT', 'Open a problem with a cached statement before starting an interview.');
    throw error;
  }
}
function validBody(body) {
  if (body.said !== undefined && (typeof body.said !== 'string' || body.said.length > 80000)) throw new HttpError(400, 'BAD_REQUEST', 'Answer is too long.');
  if (body.code !== undefined && (typeof body.code !== 'string' || body.code.length > 200000)) throw new HttpError(400, 'BAD_REQUEST', 'Buffer is too long.');
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[\w-]{1,100}$/.test(body.requestId))) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request identity.');
}
async function pauseOtherInterviews(svc, slug, exceptId) {
  const slugs = await listProblemSlugs(svc.root);
  const targets = [];
  for (const candidate of slugs) {
    let ids;
    try { ids = await svc.store.list(candidate); } catch { continue; }
    for (const id of ids) {
      if (candidate === slug && id === exceptId) continue;
      const state = await svc.store.readState(candidate, id);
      if (state && !state.debriefed && state.endedAt === null && state.pausedAt === null) targets.push({ slug: candidate, id, state });
    }
  }
  // Check every target before changing any state, then reserve every target so a
  // concurrent turn cannot write over a paused snapshot.
  if (targets.some(({ slug: targetSlug, id }) => svc.live.has(keyOf(targetSlug, id)))) {
    throw new HttpError(409, 'BUSY', 'Another interview is still finishing a turn.');
  }
  const slots = [];
  try {
    for (const { slug: targetSlug, id } of targets) slots.push(reserve(svc, keyOf(targetSlug, id)));
    for (const target of targets) {
      const { slug: targetSlug, id } = target;
      const state = await svc.store.readState(targetSlug, id);
      // A turn may have completed between discovery and reservation. Preserve
      // the newer durable state and only pause sessions still running.
      if (!state || state.debriefed || state.endedAt !== null || state.pausedAt !== null) continue;
      pause(state);
      await record(svc, state, id, { kind: 'pause', reason: 'another interview resumed' });
      await persist(svc, state, id);
    }
  } finally { for (const slot of slots) slot.release(); }
}
async function record(svc, state, id, entry) {
  await svc.store.append(state.slug, id, { at: new Date().toISOString(), elapsedMs: elapsed(state), phase: state.phase, ...entry });
}
async function persist(svc, state, id) {
  await svc.store.writeState(state.slug, id, state);
  await writeInterviewDoc({ root: svc.root, slug: state.slug, id });
  if (state.debriefed && state.discipline === 'lld') await refreshLearning(svc.root, state.slug);
}

async function generate(svc, state, id, body, kind, slot, stream) {
  const key = keyOf(state.slug, id);
  const choice = await readCoachChoice(svc.root, svc);
  let conversation = svc.conversations.get(key);
  const same = state.coachProvider === choice.provider && state.coachModel === choice.model;
  if (!same) { conversation?.close?.(); svc.conversations.delete(key); conversation = null; state.claudeSessionId = null; }
  if (choice.provider === 'codex' && !conversation) { conversation = {}; svc.conversations.set(key, conversation); }
  state.coachProvider = choice.provider; state.coachModel = choice.model; state.coachReasoningEffort = choice.reasoningEffort || null;
  const turns = await svc.store.readTurns(state.slug, id);
  const learningNotes = '';
  const learner = learnerContext(await readLearnerProfile(svc.root, { excludeInterviewId: id,discipline:state.discipline||'coding' }),{discipline:state.discipline||'coding',slug:state.slug,query:body.said});
  const agentMemory = await readAgentMemory(svc.root, state.slug,{query:body.said});
  const sessionRecords=()=>svc.store.readTurns(state.slug,id);
  const sessionContext=createSessionContext({root:svc.root,target:`interview:${state.slug}:${id}`,records:sessionRecords});
  const sessionRecord=await sessionContext.read(body.said || '');
  const readWork = async () => {
    const file = state.discipline === 'lld' ? path.join(svc.store.dir(state.slug, id), 'code.py') : path.join(problemDir(svc.root,state.slug), 'solution.py');
    try { return await fs.readFile(file, 'utf8'); } catch (e) { if (e.code !== 'ENOENT') throw e; return body.code ?? state.lastCode ?? ''; }
  };
  const agentTools = await createWorkspaceTools({ root: svc.root, slug: state.slug, target: `interview:${state.slug}:${id}`, req: stream.res.req, stream, kind: kind === 'debrief' ? 'review' : state.discipline === 'lld' ? 'code' : 'coding',
    getState: async () => ({ code: await readWork(), phase: state.phase, discipline: state.discipline || 'coding', note: 'Latest saved work; editor changes may be newer.' }),
    readContext:contextReader({session:()=>svc.store.readTurns(state.slug,id)}),
    sessionContext, sessionRecords,
    runCode: state.discipline === 'lld' && kind !== 'debrief' ? async () => {
      const code = await readWork(), result = await runPythonScript(code);
      await record(svc, state, id, { kind: 'coach_run', code, result, requestId: body.requestId });
      return result;
    } : null, onAction: action => record(svc, state, id, { kind: 'tool_action', action: structuredClone(action), requestId: body.requestId }),
  });
  const currentContext = [
    ['Problem',state.statement],['Agent memory',agentMemory],['Cross-problem learner history',learner],
    ['Session decisions and unresolved questions',sessionRecord],
    ...(kind === 'debrief' ? [] : [['Current workspace',{code:await readWork()}]]),
    ['Current interview metadata',{phase:state.phase,mode:state.mode,minutes:state.minutes,gaps:state.gaps,curveballDone:state.curveballDone}],
  ];
  const message = kind === 'debrief' ? debriefPrompt(state, turns, Date.now()) : turnPrompt(state, {
    kind, said:body.said || '', code:body.code ?? state.lastCode, full:true, includeWorkspace:false,
  });
  const prompt = contextPacket({instructions:INTERVIEW_POLICY,
    sections:[...currentContext,...(kind === 'debrief' ? [] : [['Full saved interview record',handoffRecords(evidenceRecords(turns),{query:body.said||''})]])]})+'\n\n'+message;
  let tags = createTagStripper(), guard = createNarrationFilter(), asked = '', buffered = '', child, finished = false, sessionId = null;
  const emit = text => {
    if (!text) return;
    buffered += text;
    // Debriefs are long-form content, not short replies eligible for filler
    // suppression. Stream their guarded text as it arrives.
    if (kind === 'debrief') stream.token(text);
  };
  const finish = async ({ failure = null, stopped = false, commit } = {}) => {
    if (finished) return;
    finished = true;
    try {
      await agentTools.dispose();
      if (!failure && !stopped) {
        emit(guard.push(tags.flush()).text); emit(guard.flush());
      }
      if (!failure && !stopped && kind !== 'debrief') {
        const clean = filterTranscript(buffered);
        if (clean && !isFillerReply(clean)) { asked = buffered; stream.token(asked); }
        else if (buffered.trim()) await record(svc, state, id, { kind: 'suppressed_filler', raw: buffered, requestId: body.requestId, provider: choice.provider, model: choice.model });
      } else if (!failure && !stopped) { asked = buffered; }
      // Short replies wait for filler classification. Even when the provider
      // fails, retain and show the guarded text instead of losing its evidence.
      if ((failure || stopped) && buffered.trim()) {
        asked = buffered;
        if (kind !== 'debrief') stream.token(asked);
      }
      if (asked) {
        if (!failure && !stopped) {
          if (tags.phase && kind !== 'debrief') advance(state, tags.phase);
          recordHints(state, tags.hints);
          if (state.discipline === 'lld') {
            if (tags.gap) { state.gaps ||= {}; state.gaps[tags.gap] = (state.gaps[tags.gap] || 0) + 1; }
            if (tags.curveball) state.curveballDone = true;
          }
        }
        await record(svc, state, id, { kind: failure || stopped ? 'partial' : kind, replyKind: kind, asked, requestId: body.requestId, provider: choice.provider, model: choice.model, stopped });
      }
      if (!failure && !stopped && kind === 'debrief' && !asked.trim()) {
        failure = 'The interviewer returned an empty debrief.';
      }
      if (stopped && !asked) await record(svc, state, id, { kind: 'partial', replyKind: kind, asked: '', requestId: body.requestId, stopped: true });
      if (failure) await record(svc, state, id, { kind: 'error', replyKind: kind, message: failure, requestId: body.requestId });
      if (failure || stopped) {
        state.claudeSessionId = null; conversation?.close?.();
      } else {
        if (asked) state.turns++;
        if (choice.provider === 'claude') state.claudeSessionId = sessionId;
        if (agentTools.actions.some(a => a.tool === 'edit_code' && a.ok)) state.lastCode = await readWork();
        else if (typeof body.code === 'string') state.lastCode = body.code;
        // Once a substantive reply acknowledges the new events, later prompts need not repeat them.
        if (asked) state.pendingEvents = [];
        if (kind === 'debrief') {
          state.debriefed = true; state.endedAt ??= Date.now();
          state.hireSignal = parseReport(asked)?.signal || asked.match(/(?:Hire signal[^\n]*\n|Hire signal\s*[:—-])\s*(?:\*\*)?(Strong hire|Lean hire|Lean no|No hire|Hire)\b/i)?.[1] || null;
          conversation?.close?.(); svc.conversations.delete(key);
        }
      }
      if (body.requestId) state.requests[body.requestId] = { status: failure || stopped ? 'failed' : 'completed', kind, said: body.said || '' };
      await persist(svc, state, id);
      if (!failure && !stopped) await commit?.();
      if (failure) stream.error(failure);
      else {
        stream.send('phase', { phase: state.phase });
        stream.send('done', { state: publicState(state), asked, stopped }); stream.end();
      }
    } catch (error) { stream.error(`The interview could not be saved: ${error.message}`); throw error; }
    finally { slot.release(); }
  };
  slot.stop = () => { child?.kill(); return finish({ stopped: true }); };
  const launch = () => {
    const system = state.discipline === 'lld' ? lldSystemPrompt(state) : systemPrompt();
    child = svc.run({ choice, root: svc.root, discipline:state.discipline||'coding', binary: svc.binary, tools: '', ...agentTools.options,
      systemPrompt: system, coachingMode: kind === 'debrief' ? 'review' : 'mock',
      prompt,
      conversation:{key:`interview:${state.slug}:${id}`,requestId:body.requestId,bootstrapPrompt:prompt,message,context:currentContext},
      resumeSessionId: null,
      onSessionId: value => { sessionId = value; },
      onToken: text => {
        if (finished) return;
        const filtered = guard.push(tags.push(text)); emit(filtered.text);
        if (filtered.tripped) {
          stream.send('broke-character', {});
          child?.kill(); void finish({ stopped: true });
        }
      },
      onDone: (sid, _reason, commit) => { sessionId = sid || sessionId; return finish({ commit }); },
      onError: message => finish({ failure:String(message) }),
    });
  };
  try { launch(); } catch (error) { await agentTools.dispose(); throw error; }
  await slot.completion;
  await child?.exited;
}

async function start(req, res, ctx) {
  const body = await readJsonBody(req); validBody(body); if (body.discipline === 'lld' && typeof body.slug === 'string' && !body.slug.startsWith('lld-')) body.slug = `lld-${body.slug}`; validate(body.slug);
  const svc = service(ctx), key = `start/${body.slug}`, slot = reserve(svc, key);
  let lifecycle = null;
  let stream;
  try {
    if (body.fresh) lifecycle = reserve(svc, '__interview-lifecycle__');
    // A reload may lose the initial SSE before receiving the id. A repeated request
    // identity always returns its original record, including when fresh was asked.
    const ids = await svc.store.list(body.slug);
    for (const id of ids.reverse()) {
      const existing = await svc.store.readState(body.slug, id);
      if (existing?.requests?.[body.requestId]) return sendJson(res, 200, { existing: true, id, state: publicState(existing) });
      if (!body.fresh && existing && !existing.debriefed) return sendJson(res, 200, { existing: true, id, state: publicState(existing) });
    }
    let state;
    try { state = newState(body); } catch (error) { throw new HttpError(400, 'BAD_REQUEST', error.message); }
    state.discipline = body.discipline === 'lld' ? 'lld' : 'coding';
    if (state.discipline === 'lld') state.lastCode = '';
    const preferences = (await readLearnerProfile(svc.root)).preferences;
    state.targetLevel = /^L[3-6]$/.test(body.targetLevel || '') ? body.targetLevel : preferences?.targetLevel?.[state.discipline] || preferences?.targetLevel?.default || 'L4';
    if (state.discipline === 'lld') {
      state.scenario = await readProblem(svc.root, body.slug);
      if (!state.scenario) throw new HttpError(404, 'NOT_FOUND', 'Unknown LLD scenario.');
      state.title = state.scenario.title;
      state.statement = `${state.title}\n${state.scenario.statement}`;
    } else state.statement = await readStatement(svc.root, body.slug);
    const choice = await readCoachChoice(svc.root, svc);
    state.coachProvider = choice.provider; state.coachModel = choice.model; state.coachReasoningEffort = choice.reasoningEffort || null;
    if (body.fresh) await pauseOtherInterviews(svc, body.slug, null);
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    if (body.requestId) state.requests[body.requestId] = { status: 'accepted', kind: 'opening', said: '' };
    await svc.store.create(body.slug, id, state);
    const liveSlot = reserve(svc, keyOf(body.slug, id));
    stream = new SseStream(res);
    stream.send('interview', { id, ...publicState(state, true) });
    if (state.discipline === 'lld') {
      const asked = state.scenario.statement;
      try {
        await record(svc, state, id, { kind: 'opening', asked, requestId: body.requestId });
        if (body.requestId) state.requests[body.requestId] = { status: 'completed', kind: 'opening', said: '' };
        state.lastCode = '';
        await persist(svc, state, id);
        stream.token(asked); stream.send('done', { state: publicState(state), asked }); stream.end();
      } finally { liveSlot.release(); }
      return;
    }
    try { await generate(svc, state, id, state.discipline === 'lld' ? { ...body, code: '' } : body, 'opening', liveSlot, stream); }
    catch (error) { liveSlot.release(); throw error; }
  } catch (error) { if (stream) stream.error(error.message); else throw error; }
  finally { lifecycle?.release(); slot.release(); }
}
async function action(req, res, ctx, kind) {
  const body = await readJsonBody(req); validBody(body); validate(body.slug, body.interviewId);
  const svc = service(ctx), id = body.interviewId, key = keyOf(body.slug, id), slot = reserve(svc, key);
  let stream;
  try {
    const state = await svc.store.readState(body.slug, id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
    if (state.discipline === 'lld' && kind === 'turn' && /^(?:done|i(?:'m| am) done)[.!]?$/i.test(String(body.said || '').trim())) kind = 'debrief';
    const existing = body.requestId && state.requests[body.requestId];
    const retrying = kind === 'retry';
    if (retrying) {
      if (!existing || !['opening', 'turn', 'debrief', 'event'].includes(existing.kind)) {
        throw new HttpError(409, 'NOT_RETRYABLE', 'No saved reply is available to retry.');
      }
      kind = existing.kind;
      body.said = existing.said || '';
    }
    if (existing && existing.kind && existing.kind !== kind) {
      throw new HttpError(409, 'REQUEST_REUSED', 'This request identity was already used for another interview action.');
    }
    if (existing?.status === 'completed' || existing?.status === 'skipped') return sendJson(res, 200, { duplicate: true, skipped: existing.status === 'skipped', state: publicState(state) });
    if (state.endedAt !== null && kind !== 'debrief') throw new HttpError(409, 'ENDED', 'The interview has ended. Finish its debrief first.');
    if (state.debriefed) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
    if (state.pausedAt !== null && !['resume', 'debrief', 'mode'].includes(kind)) throw new HttpError(409, 'PAUSED', 'Resume the interview first.');
    if (kind === 'mode') {
      if (!['typed', 'voice'].includes(body.mode)) throw new HttpError(400, 'BAD_REQUEST', 'Choose Typed or Voice.');
      if (state.mode !== body.mode) {
        state.mode = body.mode;
        await record(svc, state, id, { kind: 'mode', mode: body.mode });
        await persist(svc, state, id);
      }
      return sendJson(res, 200, { state: publicState(state) });
    }
    if (kind === 'pause' || kind === 'resume') {
      const lifecycle = kind === 'resume' ? reserve(svc, '__interview-lifecycle__') : null;
      try {
        if (kind === 'resume') await pauseOtherInterviews(svc, body.slug, id);
        (kind === 'pause' ? pause : resume)(state);
        await record(svc, state, id, { kind }); await persist(svc, state, id);
        return sendJson(res, 200, { state: publicState(state) });
      } finally { lifecycle?.release(); }
    }
    if (kind === 'event' && !retrying && !['failed', 'accepted'].includes(existing?.status)) {
      const event = body.event;
      if (!event || !['idle', 'run_result', 'verdict', 'phase_hint'].includes(event.type) || JSON.stringify(event).length > 20000) throw new HttpError(400, 'BAD_REQUEST', 'Invalid interview event.');
      if (event.requestId && state.requests[event.requestId]?.status === 'recorded') return sendJson(res, 200, { interjected: false, state: publicState(state) });
      observe(state, event);
      if (event.requestId) state.requests[event.requestId] = { status: 'recorded' };
      if (event.type !== 'idle') await record(svc, state, id, { kind: 'event', event, elapsedMs: state.pendingEvents.at(-1)?.elapsedMs ?? elapsed(state) });
      if (!shouldInterject(state, event)) {
        await svc.store.writeState(body.slug, id, state);
        return sendJson(res, 200, { interjected: false, state: publicState(state) });
      }
      state.lastInterjectAt = Date.now();
      if (!state.warningGiven && state.minutes * 60000 - elapsed(state) <= 120000) {
        state.pendingEvents.push({ type: 'time_warning', message: 'Two minutes remaining.', elapsedMs: elapsed(state) });
        state.warningGiven = true;
      }
    }
    if (body.events !== undefined) {
      if (!Array.isArray(body.events) || body.events.length > 100 || JSON.stringify(body.events).length > 100000) throw new HttpError(400, 'BAD_REQUEST', 'Too many pending results.');
      for (const event of body.events) {
        if (!event || !['run_result', 'verdict', 'phase_hint'].includes(event.type)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid result.');
        if (event.requestId && state.requests[event.requestId]?.status === 'recorded') continue;
        observe(state, event);
        await record(svc, state, id, { kind: 'event', event, elapsedMs: state.pendingEvents.at(-1).elapsedMs });
        if (event.requestId) state.requests[event.requestId] = { status: 'recorded' };
      }
    }
    const cleanSaid = body.said === undefined ? '' : filterTranscript(body.said);
    if (kind === 'turn' && !cleanSaid) {
      await record(svc, state, id, { kind: 'skipped_noise', raw: body.said, requestId: body.requestId });
      if (body.requestId) state.requests[body.requestId] = { status: 'skipped', kind, raw: body.said };
      await persist(svc, state, id);
      return sendJson(res, 200, { skipped: true, state: publicState(state) });
    }
    body.said = cleanSaid;
    if (!existing && cleanSaid) {
      state.lastSpeechAt = Date.now();
      await record(svc, state, id, { kind: 'candidate', said: cleanSaid, requestId: body.requestId });
    }
    if (typeof body.code === 'string') await record(svc, state, id, { kind: 'buffer', code: body.code });
    if (body.requestId) state.requests[body.requestId] = { status: 'accepted', kind, said: body.said || '' };
    if (kind === 'debrief') { state.endedAt ??= Date.now(); if (typeof body.code === 'string') state.lastCode = body.code; }
    await svc.store.writeState(body.slug, id, state);
    stream = new SseStream(res);
    stream.send('accepted', { requestId: body.requestId, said: body.said || '', state: publicState(state, true) });
    if (kind === 'debrief') {
      const turns = await svc.store.readTurns(body.slug, id);
      const responded = turns.some(turn => turn.kind === 'candidate' && typeof turn.said === 'string' && turn.said.trim());
      if (!responded && !(state.discipline === 'lld' && state.lastCode?.trim())) {
        state.debriefed = true;
        state.completionReason = 'no-response';
        state.endedAt ??= Date.now();
        await record(svc, state, id, { kind: 'completion', completionReason: 'no-response' });
        if (body.requestId) state.requests[body.requestId] = { status: 'completed', kind, said: body.said || '' };
        await persist(svc, state, id);
        stream.send('phase', { phase: state.phase });
        stream.send('done', { state: publicState(state), asked: '', stopped: false }); stream.end();
        return;
      }
    }
    await generate(svc, state, id, body, kind, slot, stream);
  } catch (error) { if (stream) stream.error(error.message); else throw error; }
  finally { slot.release(); }
}
async function get(req, res, ctx) {
  const svc = service(ctx), { slug, id } = ctx.params; validate(slug, id);
  await svc.live.get(keyOf(slug, id))?.completion;
  const state = await svc.store.readState(slug, id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
  const turns = await svc.store.readTurns(slug, id);
  // A question still being answered is `pending`, so a reopened sheet waits for it.
  const answering = svc.live.get(`review/${keyOf(slug, id)}`)?.requestId;
  const followups = pairFollowups(await svc.store.readFollowups(slug, id))
    .map(f => f.requestId === answering ? { ...f, pending: true } : f);
  return sendJson(res, 200, { id, ...publicState(state), turns, report: svc.buildReport ? svc.buildReport(state, turns) : buildReport(state, turns), followups, busy: false });
}
async function list(req, res, ctx) {
  const svc = service(ctx), slug = new URL(req.url, 'http://localhost').searchParams.get('slug'); validate(slug);
  const interviews = [];
  for (const id of await svc.store.list(slug)) {
    const state = await svc.store.readState(slug, id);
    if (state) {
      interviews.push({ id, ...publicState(state, Boolean(svc.live.get(keyOf(slug, id)))) });
    }
  }
  return sendJson(res, 200, { interviews });
}
/**
 * A follow-up question about a finished interview, answered as a stream. The question is
 * saved before the provider runs, so it survives a failure; resending the same
 * `requestId` returns a finished answer, or asks again after a failed one.
 */
async function ask(req, res, ctx) {
  const body = await readJsonBody(req); validate(body.slug, body.interviewId);
  return askRecordedInterview(body, res, service(ctx));
}
export async function askRecordedInterview(body, res, svc) {
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!question || question.length > MAX_QUESTION) throw new HttpError(400, 'BAD_REQUEST', 'Ask a question of at most 4000 characters.');
  if (typeof body.requestId !== 'string' || !/^[\w-]{1,100}$/.test(body.requestId)) throw new HttpError(400, 'BAD_REQUEST', 'Invalid request identity.');
  const { slug } = body, id = body.interviewId;
  const slot = reserve(svc, `review/${keyOf(slug, id)}`);
  slot.requestId = body.requestId;
  let stream, agentTools;
  try {
    const state = await svc.store.readState(slug, id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
    if (!state.debriefed) throw new HttpError(409, 'NOT_FINISHED', 'Finish the interview before asking about it.');
    const turns = await svc.store.readTurns(slug, id);
    const followups = pairFollowups(await svc.store.readFollowups(slug, id));
    const existing = followups.find(f => f.requestId === body.requestId);
    if (existing && existing.question !== question) throw new HttpError(409, 'REQUEST_REUSED', 'This request identity belongs to a different question.');
    if (existing?.answer && !existing.failed) return sendJson(res, 200, { duplicate: true, followup: existing });
    if (!existing) await svc.store.appendFollowup(slug, id, { kind: 'question', requestId: body.requestId, question, at: new Date().toISOString() });
    const choice = await readCoachChoice(svc.root, svc);
    const topic = state.topicSlug || state.slug;
    state.learningNotes = learnerContext(await readLearnerProfile(svc.root, { excludeInterviewId: id,discipline:state.discipline||'coding' }),{discipline:disciplineForSlug(topic),slug:topic,query:question}) + '\n' + await readAgentMemory(svc.root, topic,{query:question});
    const reviewContext = reviewPrompt({
      state, turns: turns.filter(t=>t.kind==='debrief'), report: svc.buildReport ? svc.buildReport(state, turns) : buildReport(state, turns),
      followups: [], question: '',
    });
    const prompt = reviewContext + '\n\n' + data('The learner asks',question) + '\n\n' + data('Full saved interview record',handoffRecords(evidenceRecords(turns),{query:question}))
      + (followups.some(f=>f.requestId!==body.requestId) ? '\n\n' + data('Earlier questions and your answers (full saved follow-up conversation)',handoffRecords(evidenceRecords(followups.filter(f=>f.requestId!==body.requestId)),{query:question})) : '');
    stream = new SseStream(res);
    stream.send('accepted', { requestId: body.requestId });
    agentTools = await createWorkspaceTools({ root: svc.root, slug: topic, target: `review:${topic}:${id}`, req: res.req, stream, kind: 'review',
      readContext:contextReader({session:turns,followups}),
      onAction: action => svc.store.appendFollowup(slug, id, { kind: 'tool_action', requestId: body.requestId, action: structuredClone(action), at: new Date().toISOString() }),
    });
    let answer = '', finished = false, providerChild;
    await new Promise(resolve => {
      const finish = async (failure = null, commit) => {
        if (finished) return;
        finished = true;
        if (!failure && !answer.trim()) failure = 'The interviewer returned an empty answer.';
        try {
          await svc.store.appendFollowup(slug, id, { kind: 'answer', requestId: body.requestId, answer, failed: Boolean(failure), provider: choice.provider, model: choice.model, at: new Date().toISOString() });
          if (!failure) await commit?.();
          if (failure) stream.error(failure);
          else { stream.send('done', { requestId: body.requestId, answer }); stream.end(); }
        } catch (error) { stream.error(`The answer could not be saved: ${error.message}`); throw error; }
        finally { resolve(); }
      };
      providerChild = svc.run({ choice, root: svc.root, discipline: disciplineForSlug(topic), binary: svc.binary, tools: '', ...agentTools.options,
        systemPrompt: reviewSystemPrompt(), coachingMode:'review', prompt:reviewSystemPrompt()+'\n\n'+prompt,
        conversation:{key:`review:${slug}:${id}:followups`,requestId:body.requestId,bootstrapPrompt:prompt,message:question,context:[['Review context',reviewContext]]},
        onToken: text => { if (finished || !text) return; answer += text; stream.token(text); },
        onDone: (_id, _reason, commit) => finish(null, commit),
        onError: message => finish(String(message)),
      });
    });
    await providerChild?.exited;
  } catch (error) { if (stream) stream.error(error.message); else throw error; }
  finally { await agentTools?.dispose(); slot.release(); }
}
async function stop(req, res, ctx) {
  const body = await readJsonBody(req); validate(body.slug, body.interviewId);
  const slot = service(ctx).live.get(keyOf(body.slug, body.interviewId));
  if (slot?.stop) await slot.stop();
  return sendJson(res, 200, { stopped: Boolean(slot?.stop) });
}
export const interviewRoutes = {
  'POST /api/interview/start': start,
  'POST /api/interview/turn': (q, r, c) => action(q, r, c, 'turn'),
  'POST /api/interview/event': (q, r, c) => action(q, r, c, 'event'),
  'POST /api/interview/done': (q, r, c) => action(q, r, c, 'debrief'),
  'POST /api/interview/pause': (q, r, c) => action(q, r, c, 'pause'),
  'POST /api/interview/mode': (q, r, c) => action(q, r, c, 'mode'),
  'POST /api/interview/resume': (q, r, c) => action(q, r, c, 'resume'),
  'POST /api/interview/stop': stop,
  'POST /api/interview/retry': (q, r, c) => action(q, r, c, 'retry'),
  'POST /api/interview/ask': ask,
  'GET /api/interview': list,
  'GET /api/interview/:slug/:id': get,
};

// Kept public for feature profiles (LLD) that share this service and lifecycle.
export { start as startInterview };
export { service, reserve };
