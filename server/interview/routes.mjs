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
import { systemPrompt, turnPrompt, rehydratePrompt, debriefPrompt } from './prompt.mjs';
import { createTagStripper } from './narration.mjs';
import { InterviewStore, validate } from './store.mjs';
import { writeInterviewDoc } from './render.mjs';

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
function publicState(state) {
  const { statement, lastCode, requests, claudeSessionId, ...rest } = state;
  return rest;
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
async function record(svc, state, id, entry) {
  await svc.store.append(state.slug, id, { at: new Date().toISOString(), elapsedMs: elapsed(state), phase: state.phase, ...entry });
}
async function persist(svc, state, id) {
  await svc.store.writeState(state.slug, id, state);
  await writeInterviewDoc({ root: svc.root, slug: state.slug, id });
}

async function generate(svc, state, id, body, kind, slot, stream) {
  const key = keyOf(state.slug, id);
  const choice = await readCoachChoice(svc.root, svc);
  let conversation = svc.conversations.get(key);
  const same = state.coachProvider === choice.provider && state.coachModel === choice.model;
  if (!same) { conversation?.close?.(); svc.conversations.delete(key); conversation = null; state.claudeSessionId = null; }
  if (choice.provider === 'codex' && !conversation) { conversation = {}; svc.conversations.set(key, conversation); }
  state.coachProvider = choice.provider; state.coachModel = choice.model;
  const turns = await svc.store.readTurns(state.slug, id);
  const continuation = choice.provider === 'claude' ? state.claudeSessionId : conversation?.ready;
  const build = recovering => {
    const next = kind === 'debrief' ? debriefPrompt(state, turns, Date.now()) : turnPrompt(state, {
      kind, said: body.said || '', code: body.code ?? state.lastCode, full: recovering,
    });
    return recovering && kind !== 'opening' ? `${rehydratePrompt(state, turns)}\n\n${next}` : next;
  };
  let tags = createTagStripper(), guard = createNarrationFilter(), asked = '', child, finished = false, retried = false, sessionId = null;
  const emit = text => { if (text) { asked += text; stream.token(text); } };
  const finish = async ({ failure = null, stopped = false } = {}) => {
    if (finished) return;
    finished = true;
    try {
      if (!failure && !stopped) {
        emit(guard.push(tags.flush()).text); emit(guard.flush());
      }
      if (asked) {
        if (tags.phase && kind !== 'debrief') advance(state, tags.phase);
        recordHints(state, tags.hints);
        await record(svc, state, id, { kind: failure || stopped ? 'partial' : kind, asked, requestId: body.requestId, provider: choice.provider, model: choice.model, stopped });
      }
      if (failure) await record(svc, state, id, { kind: 'error', message: failure, requestId: body.requestId });
      if (failure || stopped) {
        state.claudeSessionId = null; conversation?.close?.();
      } else {
        state.turns++;
        if (choice.provider === 'claude') state.claudeSessionId = sessionId;
        if (typeof body.code === 'string') state.lastCode = body.code;
        // Once a reply acknowledges the new events, later prompts need not repeat them.
        state.pendingEvents = [];
        if (kind === 'debrief') {
          state.debriefed = true; state.endedAt ??= Date.now();
          state.hireSignal = asked.match(/(?:Hire signal[^\n]*\n|Hire signal\s*[:—-])\s*(?:\*\*)?(Strong hire|Lean hire|Lean no|No hire|Hire)\b/i)?.[1] || null;
          conversation?.close?.(); svc.conversations.delete(key);
        }
      }
      if (body.requestId) state.requests[body.requestId] = { status: failure || stopped ? 'failed' : 'completed', kind, said: body.said || '' };
      await persist(svc, state, id);
      if (failure) stream.error(failure);
      else {
        stream.send('phase', { phase: state.phase });
        stream.send('done', { state: publicState(state), asked, stopped }); stream.end();
      }
    } catch (error) { stream.error(`The interview could not be saved: ${error.message}`); }
    finally { slot.release(); }
  };
  slot.stop = () => { child?.kill(); return finish({ stopped: true }); };
  const launch = recovering => {
    const system = recovering || kind === 'opening' ? systemPrompt() : '';
    child = svc.run({ choice, root: svc.root, binary: svc.binary, tools: '', conversation,
      systemPrompt: choice.provider === 'codex' ? system : '',
      prompt: choice.provider === 'claude' && system ? `${system}\n\n${build(recovering)}` : build(recovering),
      resumeSessionId: choice.provider === 'claude' && !recovering ? state.claudeSessionId : null,
      onSessionId: value => { sessionId = value; },
      onToken: text => {
        if (finished) return;
        const filtered = guard.push(tags.push(text)); emit(filtered.text);
        if (filtered.tripped) {
          stream.send('broke-character', {});
          child?.kill(); void finish({ stopped: true });
        }
      },
      onDone: sid => { sessionId = sid || sessionId; void finish(); },
      onError: message => {
        if (finished) return;
        // Only a lost native session gets one reconstruction attempt, never an
        // automatic retry after visible output or an ordinary provider failure.
        if (choice.provider === 'claude' && continuation && !retried && !asked && /session.*(not found|missing|invalid|no longer|could not)|no conversation|could not resume|cannot resume|can.t resume/i.test(message)) {
          retried = true; state.claudeSessionId = null; tags = createTagStripper(); guard = createNarrationFilter(); launch(true);
        } else void finish({ failure: String(message) });
      },
    });
  };
  launch(!continuation);
  return slot.completion;
}

async function start(req, res, ctx) {
  const body = await readJsonBody(req); validBody(body); validate(body.slug);
  const svc = service(ctx), key = `start/${body.slug}`, slot = reserve(svc, key);
  let stream;
  try {
    // A reload may lose the initial SSE before receiving the id. Reuse the durable
    // unfinished interview instead of starting a second timer/provider session.
    const ids = await svc.store.list(body.slug);
    for (const id of ids.reverse()) {
      const existing = await svc.store.readState(body.slug, id);
      if (existing && !existing.debriefed) return sendJson(res, 200, { existing: true, id, state: publicState(existing) });
    }
    let state;
    try { state = newState(body); } catch (error) { throw new HttpError(400, 'BAD_REQUEST', error.message); }
    state.statement = await readStatement(svc.root, body.slug);
    const choice = await readCoachChoice(svc.root, svc);
    state.coachProvider = choice.provider; state.coachModel = choice.model;
    const id = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await svc.store.create(body.slug, id, state);
    const liveSlot = reserve(svc, keyOf(body.slug, id));
    stream = new SseStream(res);
    stream.send('interview', { id, ...publicState(state) });
    try { await generate(svc, state, id, body, 'opening', liveSlot, stream); }
    catch (error) { liveSlot.release(); throw error; }
  } catch (error) { if (stream) stream.error(error.message); else throw error; }
  finally { slot.release(); }
}
async function action(req, res, ctx, kind) {
  const body = await readJsonBody(req); validBody(body); validate(body.slug, body.interviewId);
  const svc = service(ctx), id = body.interviewId, key = keyOf(body.slug, id), slot = reserve(svc, key);
  let stream;
  try {
    const state = await svc.store.readState(body.slug, id);
    if (!state) throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
    const existing = body.requestId && state.requests[body.requestId];
    if (existing?.status === 'completed') return sendJson(res, 200, { duplicate: true, state: publicState(state) });
    if (state.debriefed) throw new HttpError(409, 'FINISHED', 'This interview is already finished.');
    if (state.pausedAt !== null && !['resume', 'debrief'].includes(kind)) throw new HttpError(409, 'PAUSED', 'Resume the interview first.');
    if (kind === 'pause' || kind === 'resume') {
      (kind === 'pause' ? pause : resume)(state);
      await record(svc, state, id, { kind }); await persist(svc, state, id);
      return sendJson(res, 200, { state: publicState(state) });
    }
    if (kind === 'event') {
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
    if (!existing && body.said?.trim()) {
      state.lastSpeechAt = Date.now();
      await record(svc, state, id, { kind: 'candidate', said: body.said, requestId: body.requestId });
    }
    if (typeof body.code === 'string') await record(svc, state, id, { kind: 'buffer', code: body.code });
    if (body.requestId) state.requests[body.requestId] = { status: 'accepted', kind, said: body.said || '' };
    if (kind === 'debrief') state.endedAt ??= Date.now();
    await svc.store.writeState(body.slug, id, state);
    stream = new SseStream(res);
    stream.send('accepted', { requestId: body.requestId });
    await generate(svc, state, id, body, kind, slot, stream);
  } catch (error) { if (stream) stream.error(error.message); else throw error; }
  finally { slot.release(); }
}
async function get(req, res, ctx) {
  const svc = service(ctx), { slug, id } = ctx.params; validate(slug, id);
  await svc.live.get(keyOf(slug, id))?.completion;
  const state = await svc.store.readState(slug, id);
  if (!state) throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
  return sendJson(res, 200, { id, ...publicState(state), turns: await svc.store.readTurns(slug, id), busy: false });
}
async function list(req, res, ctx) {
  const svc = service(ctx), slug = new URL(req.url, 'http://localhost').searchParams.get('slug'); validate(slug);
  const interviews = [];
  for (const id of await svc.store.list(slug)) {
    const state = await svc.store.readState(slug, id);
    if (state) interviews.push({ id, ...publicState(state) });
  }
  return sendJson(res, 200, { interviews });
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
  'POST /api/interview/resume': (q, r, c) => action(q, r, c, 'resume'),
  'POST /api/interview/stop': stop,
  'GET /api/interview': list,
  'GET /api/interview/:slug/:id': get,
};
