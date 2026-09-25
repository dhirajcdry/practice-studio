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
import { runCoachTurn } from '../coach/claude-cli.mjs';
import { sceneToGraph } from './graph.mjs';
import { createNarrationFilter, salvageQuestion } from './narration.mjs';
import {
  newInterview, recordTurn, enterPhase, buildTurn, openingPrompt, systemPrompt,
  curveballDue, PHASE_IDS, DEFAULT_MINUTES, extractPhaseTag, createTagStripper, rehydratePrompt,
} from './interview.mjs';
import { DesignStore, newInterviewId, isSafeInterviewId } from './store.mjs';
import { writeInterviewDoc } from './render.mjs';

class DesignService {
  constructor({ root = HOME_ROOT, binary = process.env.STUDIO_COACH_BINARY || 'claude', log = console } = {}) {
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

function idFrom(body, ctx) {
  const id = ctx?.params?.id ?? body?.interviewId;
  if (!isSafeInterviewId(id)) {
    throw new HttpError(400, 'BAD_REQUEST', '"interviewId" is required and must be an interview id.');
  }
  return id;
}

/**
 * Run one model turn into an SSE stream, with the impersonation guard on the tokens.
 *
 * The guard sits here rather than after the fact because "after the fact" is too late:
 * a token that has reached the browser has been read, and in voice mode it has been
 * spoken. Cutting the stream is the only point at which the candidate can still be
 * prevented from seeing an answer they did not give.
 */
function streamTurn(svc, { id, prompt, system = null, resume = null, stream, onFinished }) {
  const filter = createNarrationFilter();
  let broke = false;
  let finished = false;
  let lastPhase = null;
  const tags = createTagStripper();

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
  async function finish(sessionId = null, stoppedReason = null) {
    if (finished) return;
    finished = true;
    svc.live.delete(id);
    if (!broke) {
      // Release anything the guard was still holding — a line that never became a
      // label must not cost the turn its last few words. The phase tag is held by the
      // same rule (it opens with a bracket), which is why stripping it here catches it
      // before a single character has been shown or spoken.
      const rest = tags.push(filter.flush()) + tags.flush();
      if (rest) stream.token(rest);
      if (tags.phase) { lastPhase = tags.phase; stream.send('phase', { phase: tags.phase }); }
    }
    if (sessionId) svc.sessions.set(id, sessionId);
    const asked = extractPhaseTag(
      broke ? (salvageQuestion(filter.text()) ?? '') : filter.text(),
    ).text;
    try {
      await onFinished(asked, { broke, phase: lastPhase });
    } catch (err) {
      svc.log?.warn?.(`[design] ${id}: ${err.message}`);
    }
    stream.send('done', { sessionId, stoppedReason, broke, asked });
    stream.end();
  }

  const child = runCoachTurn({
    root: svc.root,
    binary: svc.binary,
    prompt: system ? `${system}\n\n---\n\n${prompt}` : prompt,
    resumeSessionId: resume,
    onToken: (text) => {
      const { text: safe, tripped } = filter.push(text);
      // The phase tag rides the same pipe as speech, so it is pulled out here — before
      // a single character of it can be shown or spoken.
      const shown = tags.push(safe);
      if (shown) stream.token(shown);
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
        finish(svc.sessions.get(id) ?? resume, 'broke-character');
        child.kill();
      }
    },
    onTool: (name, summary) => stream.tool(name, summary),
    onSessionId: (sid) => { if (sid) svc.sessions.set(id, sid); },
    onError: (message) => {
      if (finished) return;
      finished = true;
      svc.live.delete(id);
      stream.error(message);
    },
    onDone: (sessionId, stoppedReason) => finish(sessionId, stoppedReason),
  });

  svc.live.set(id, child);
  stream.res.on('close', () => { /* a disconnect detaches a viewer; the turn continues */ });
  return child;
}

/** POST /api/design/start */
async function handleStart(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = newInterviewId();
  const now = Date.now();

  const state = newInterview({
    prompt: typeof body.prompt === 'string' && body.prompt.trim() ? body.prompt.trim() : null,
    level: typeof body.level === 'string' && body.level.trim() ? body.level.trim() : 'L4',
    minutes: Number.isFinite(body.minutes) ? Number(body.minutes) : DEFAULT_MINUTES,
    startedAt: now,
  });
  await svc.store.create(id, state);

  const stream = new SseStream(res);
  stream.send('interview', { id, startedAt: new Date(now).toISOString(), level: state.level, minutes: state.minutes });

  // Only the opening turn carries the character; every later turn resumes the session.
  const avoid = state.prompt ? [] : await svc.store.pastPrompts();
  streamTurn(svc, {
    id,
    system: systemPrompt({ level: state.level, minutes: state.minutes }),
    prompt: openingPrompt(state, { avoid }),
    resume: null,
    stream,
    onFinished: async (asked) => {
      state.claudeSessionId = svc.sessions.get(id) ?? null;
      // The model chose the problem; that choice is the interview's identity, so it is
      // recorded rather than re-derived later from the transcript.
      if (!state.prompt && asked) state.prompt = asked.trim().split('\n')[0].slice(0, 300);
      recordTurn(state, { asked, at: new Date().toISOString() });
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'opening', asked });
      await svc.store.writeState(id, state);
    },
  });
}

/** POST /api/design/turn */
async function handleTurn(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
  if (state.debriefed) throw new HttpError(409, 'CONFLICT', 'That interview is already finished.');

  const said = typeof body.said === 'string' ? body.said : '';
  if (PHASE_IDS.includes(body.phase)) enterPhase(state, body.phase);

  const graph = Array.isArray(body.elements) ? sceneToGraph(body.elements) : (state.graph ?? null);
  if (Array.isArray(body.elements)) {
    state.graph = graph;
    await svc.store.writeScene(id, (await svc.store.readScenes(id)).length, body.elements);
  }

  const now = Date.now();
  const due = curveballDue(state, now);
  const turn = buildTurn(state, {
    said, graph, previousGraph: svc.lastGraph.get(id) ?? null, now,
  });
  svc.lastGraph.set(id, graph);

  // A thread that was never saved is rebuilt here, once: the character, the record so
  // far, and then the turn. After this the new thread carries the interview normally.
  const resume = await threadFor(svc, id);
  let prompt = turn.text;
  let system = null;
  if (!resume && state.rehydrate) {
    system = systemPrompt({ level: state.level, minutes: state.minutes });
    prompt = `${rehydratePrompt(state, await svc.store.readTurns(id))}\n\n---\n\n${turn.text}`;
    state.rehydrate = false;
  }

  const stream = new SseStream(res);
  streamTurn(svc, {
    id,
    prompt,
    system,
    resume,
    stream,
    onFinished: async (asked, { phase } = {}) => {
      state.claudeSessionId = svc.sessions.get(id) ?? state.claudeSessionId ?? null;
      // The interviewer says which phase it has moved to; the candidate never has to.
      if (phase) enterPhase(state, phase);
      if (due) state.curveballDone = true;
      recordTurn(state, { said, asked, at: new Date().toISOString(), gap: body.gap ?? null });
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'turn', said, asked, phase: state.phase });
      await svc.store.writeState(id, state);
    },
  });
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
  const index = (await svc.store.readScenes(id)).length;
  await svc.store.writeScene(id, index, body.elements);
  state.graph = sceneToGraph(body.elements);
  await svc.store.writeState(id, state);
  return sendJson(res, 200, { ok: true, scenes: index + 1 });
}

/** POST /api/design/done */
async function handleDone(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');

  if (Array.isArray(body.elements)) {
    state.graph = sceneToGraph(body.elements);
    await svc.store.writeScene(id, (await svc.store.readScenes(id)).length, body.elements);
  }

  const stream = new SseStream(res);
  streamTurn(svc, {
    id,
    prompt: buildTurn(state, { now: Date.now(), done: true }).text,
    resume: await threadFor(svc, id),
    stream,
    onFinished: async (asked) => {
      state.claudeSessionId = svc.sessions.get(id) ?? state.claudeSessionId ?? null;
      state.debriefed = true;
      state.endedAt = Date.now();
      await svc.store.appendTurn(id, { at: new Date().toISOString(), kind: 'debrief', asked });
      await svc.store.writeState(id, state);
      // Derived, and written here so the file exists the moment the interview ends.
      await writeInterviewDoc({ root: svc.root, id }).catch((err) => {
        svc.log?.warn?.(`[design] could not write interview.md for ${id}: ${err.message}`);
      });
    },
  });
}

/** POST /api/design/stop — abandon the current turn, keep the interview. */
async function handleStop(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const child = svc.live.get(id);
  if (child) child.kill();
  svc.live.delete(id);
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
      prompt: state.prompt,
      level: state.level,
      startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
      debriefed: Boolean(state.debriefed),
      turns: state.turns?.length ?? 0,
    });
  }
  return sendJson(res, 200, { interviews });
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
    level: state.level,
    minutes: state.minutes,
    phase: state.phase,
    startedAt: state.startedAt ? new Date(state.startedAt).toISOString() : null,
    debriefed: Boolean(state.debriefed),
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
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
  if (state.debriefed) {
    throw new HttpError(409, 'CONFLICT', 'That interview has already been debriefed. Start a new one.');
  }
  const spent = state.spentMs ?? (state.startedAt ? (state.pausedAt ?? Date.now()) - state.startedAt : 0);
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
    level: state.level,
    minutes: state.minutes,
    phase: state.phase,
    startedAt: new Date(state.startedAt).toISOString(),
    resumed: true,
    thread: Boolean(await threadFor(svc, id)),
    rebuilt: Boolean(state.rehydrate),
    turns: await svc.store.readTurns(id),
    elements: scenes.length ? scenes[scenes.length - 1].elements : [],
  });
}

/** POST /api/design/pause — stop the clock so a day away is not 18 hours of interview. */
async function handlePause(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = idFrom(body, ctx);
  const state = await svc.store.readState(id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'No such interview.');
  state.pausedAt = Date.now();
  state.spentMs = state.startedAt ? state.pausedAt - state.startedAt : 0;
  await svc.store.writeState(id, state);
  return sendJson(res, 200, { ok: true, spentMs: state.spentMs });
}

export const routes = {
  'POST /api/design/start': handleStart,
  'POST /api/design/turn': handleTurn,
  'POST /api/design/scene': handleScene,
  'POST /api/design/done': handleDone,
  'POST /api/design/stop': handleStop,
  'POST /api/design/resume': handleResume,
  'POST /api/design/pause': handlePause,
  'GET /api/design': handleList,
  'GET /api/design/:id': handleGet,
};

export { DesignService };
export default routes;
