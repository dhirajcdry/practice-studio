// Phase 3 route table. Wired into the router by the main agent — this module never
// touches app.mjs or index.mjs, per the contract's integration rule.
//
//   POST /api/coach/message   → SSE: token / tool / done / error
//   POST /api/sessions/event  → append one line to the session log
//   GET  /api/sessions/:slug  → every session for a problem
//
// Handlers take (req, res, ctx). From ctx we use, all optionally:
//   ctx.catalog        Phase 1 catalog, for the problem title/difficulty/track
//   ctx.params.slug    path parameter, if the router extracts one
//   ctx.paths.HOME_ROOT / ctx.homeRoot   workspace root override, for tests
//   ctx.coach          a pre-built CoachService, for tests
// Anything missing falls back to a sane default, so the table works against a bare ctx.

import path from 'node:path';
import fsp from 'node:fs/promises';

import { HttpError, sendJson, isSafeSlug } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readJsonBody, requireString } from './http.mjs';
import { SseStream } from './sse.mjs';
import { SessionLog, CoachSessionStore, EVENT_TYPES, isKnownEventType } from './sessions.mjs';
import { gatherContext, buildPrompt } from './context.mjs';
import { appendTurn, readThreads } from './transcript.mjs';
import { runCoachTurn } from './claude-cli.mjs';
import { CoachRuns } from './runs.mjs';

/** Everything Phase 3 needs, in one object so tests can point it at a temp workspace. */
export class CoachService {
  constructor({
    root = HOME_ROOT,
    // STUDIO_COACH_BINARY lets a browser check point this at a fake CLI, so the
    // reload-survival check can run without a token or a network call. Unset in normal
    // use, which is the real `claude`.
    binary = process.env.STUDIO_COACH_BINARY || 'claude',
    spawnFn, env, timeoutMs, log = console,
  } = {}) {
    this.root = root;
    this.binary = binary;
    this.spawnFn = spawnFn;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.sessionLog = new SessionLog({ root });
    this.coachSessions = new CoachSessionStore({ root });
    // Turns live here, not in the request that started them. See runs.mjs.
    this.runs = new CoachRuns();
  }
}

/**
 * One service per workspace root, for the life of the process.
 *
 * It used to be cached on `ctx` — and the router builds a fresh `ctx` for every request,
 * so that was a new CoachService per request. Nothing noticed while everything the
 * service owned lived on disk. The run registry does not: turns were filed into a
 * registry that was thrown away before the next request could read it, so
 * `GET /api/coach/runs` was empty even mid-answer and a reloaded page found nothing to
 * re-attach to.
 */
const servicesByRoot = new Map();

function serviceFor(ctx) {
  if (ctx?.coach instanceof CoachService) return ctx.coach;
  const root = ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
  let service = servicesByRoot.get(root);
  if (!service) {
    service = new CoachService({ root, log: ctx?.log ?? console });
    servicesByRoot.set(root, service);
  }
  return service;
}

function slugFrom(req, ctx) {
  let slug = ctx?.params?.slug;
  if (typeof slug !== 'string' || slug === '') {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    slug = pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      slug = decodeURIComponent(slug);
    } catch {
      slug = '';
    }
  }
  if (!isSafeSlug(slug)) {
    throw new HttpError(400, 'BAD_REQUEST', 'That problem address could not be understood.');
  }
  return slug;
}

function catalogEntryFor(ctx, slug) {
  try {
    return ctx?.catalog?.get?.(slug) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// POST /api/coach/message
// ---------------------------------------------------------------------------------------

export async function handleCoachMessage(req, res, ctx) {
  const svc = serviceFor(ctx);

  // Everything that can be rejected with a normal status code is rejected *before* the
  // SSE stream opens. Once headers are sent, a failure can only be an `error` event.
  const body = await readJsonBody(req);
  const slug = isSafeSlug(body.slug)
    ? body.slug
    : (() => {
        throw new HttpError(400, 'BAD_REQUEST', '"slug" is required and must be a problem slug.');
      })();
  // A review turn carries no typed question — pressing stop *is* the question — so the
  // message is optional there and the prompt is built from the attempt instead.
  const review = body.kind === 'attempt-review';
  const message = review
    ? String(body.message ?? '').slice(0, 32_000)
    : requireString(body, 'message', { maxLength: 32_000 });
  const includeCode = body.includeCode !== false;
  const attemptId = typeof body.attemptId === 'string' && body.attemptId ? body.attemptId : null;
  // Each attempt is its own conversation. Carrying the previous attempt's thread forward
  // would let the coach grade this run against reasoning it heard in the last one.
  const newThread = body.newThread === true;
  // Continue a specific past conversation, chosen from the history view. Without this,
  // "resume" could only ever mean the most recent thread.
  const resumeThread = typeof body.resumeSessionId === 'string' && body.resumeSessionId
    ? body.resumeSessionId
    : null;

  const stream = new SseStream(res);

  // Already thinking about this problem? Watch that turn rather than starting a second
  // one. Two turns on one problem resume the same CLI session twice and interleave two
  // answers into a single thread — and a reload that raced its own request would do
  // exactly that.
  const inFlight = svc.runs.liveFor(slug);
  if (inFlight) {
    const detach = svc.runs.attach(inFlight, stream);
    res.on('close', () => { stream.closed = true; detach(); });
    return;
  }

  const run = svc.runs.start({ slug, ask: message, kind: body.kind ?? null, review, title: body.title ?? '', lead: body.lead ?? null });
  const detach = svc.runs.attach(run, stream);

  let child = null;
  // A disconnect is one viewer leaving, not a decision. Reloading the page, closing the
  // tab, losing the network — none of those mean "stop thinking". Only the Stop button,
  // the CLI finishing, and the timeout end a turn.
  const onClose = () => {
    stream.closed = true;
    detach();
  };
  res.on('close', onClose);

  try {
    // The log is the server's, and asking the coach is a real signal about how the solve
    // went — record it before the answer exists, so a crashed turn still leaves a trace.
    if (!review) {
      await svc.sessionLog.appendEvent(slug, 'asked_coach', { message }).catch(() => {});
    }

    const context = await gatherContext({
      root: svc.root,
      slug,
      catalogEntry: catalogEntryFor(ctx, slug),
      sessionLog: svc.sessionLog,
      attemptId,
    });
    const { prompt } = buildPrompt({ context, message, includeCode, review });

    if (newThread) await svc.coachSessions.forget(slug).catch(() => {});
    const stored = newThread ? null : await svc.coachSessions.read(slug);
    const resumeSessionId = resumeThread ?? stored?.sessionId ?? null;

    // Accumulated so the turn can be filed after it finishes. The browser already has
    // the text; the point is that the workspace has it too, once the tab is gone.
    let answer = '';
    const toolLines = [];

    // Filed exactly once, on every exit path — finished, stopped, errored, tab closed.
    //
    // It used to be filed only from onDone, which fires only on a clean finish. Press
    // Stop halfway through a six-paragraph review, or close the tab, and the CLI is
    // killed with `settled = true` and no callback at all: the answer existed, was read,
    // and was then thrown away. The half you got is the half worth keeping.
    let filed = false;
    const fileTurn = async (id, stopped) => {
      if (filed) return;
      filed = true;
      await appendTurn({
        root: svc.root,
        slug,
        log: svc.log,
        turn: {
          sessionId: id,
          kind: review ? 'attempt-review' : 'question',
          attemptId,
          ask: message,
          answer,
          tools: toolLines,
          ...(stopped ? { stopped: true } : {}),
        },
      });
    };

    let finalSessionId = resumeSessionId;
    // Set by whichever callback runs, to the promise of the work it still has to do.
    // The process can close while that work is mid-await, and ending the response then
    // would cut the `done` event off the end of a stream the client is still reading.
    let finishing = null;
    await new Promise((resolve) => {
      child = runCoachTurn({
        root: svc.root,
        prompt,
        resumeSessionId,
        binary: svc.binary,
        env: svc.env,
        spawnFn: svc.spawnFn,
        ...(svc.timeoutMs ? { timeoutMs: svc.timeoutMs } : {}),
        onSessionId: (id) => {
          finalSessionId = id;
        },
        onToken: (text) => { answer += text; svc.runs.token(run, text); },
        onTool: (name, summary) => {
          toolLines.push(`${name} ${summary ?? ''}`.trim());
          svc.runs.tool(run, name, summary);
        },
        onDone: (sessionId, stoppedReason) => {
          finishing = (async () => {
            const id = sessionId ?? finalSessionId;
            if (id) await svc.coachSessions.remember(slug, id).catch(() => {});
            await fileTurn(id, false);
            svc.runs.finish(run, { status: 'done', sessionId: id, stoppedReason });
          })();
          finishing.then(resolve, resolve);
        },
        onError: (message) => {
          finishing = (async () => {
            // A session id that no longer resumes must not poison every future turn.
            if (/resume the earlier conversation/i.test(message)) {
              await svc.coachSessions.forget(slug).catch(() => {});
            }
            svc.log?.warn?.(`[coach] ${slug}: ${message}`);
            svc.runs.finish(run, { status: 'error', message });
          })();
          finishing.then(resolve, resolve);
        },
      });
      // A killed turn settles with neither callback — on purpose, since nobody is
      // listening any more. Something still has to end this promise, or the request
      // handler waits forever on a process that already exited.
      run.child = child;
      child.exited?.then(async () => { if (finishing) await finishing.catch(() => {}); resolve(); }, resolve);
    });
    // Stopped: onDone never ran, so this is the only chance to keep what arrived.
    await fileTurn(finalSessionId, true);
    svc.runs.finish(run, { status: 'stopped', sessionId: finalSessionId, stoppedReason: 'stopped' });
  } catch (err) {
    svc.log?.error?.('[coach] turn failed:', err);
    svc.runs.finish(run, {
      status: 'error',
      message: 'The coach could not be started because of an internal error. Everything else in Studio still works.',
    });
  } finally {
    res.off?.('close', onClose);
    stream.end();
  }
}

// ---------------------------------------------------------------------------------------
// GET  /api/coach/runs        — what is in flight, for a page that has just loaded
// GET  /api/coach/runs/:id    — watch one, from wherever it has got to
// POST /api/coach/stop        — the only thing besides finishing that ends a turn
// ---------------------------------------------------------------------------------------

export async function handleCoachRuns(req, res, ctx) {
  const svc = serviceFor(ctx);
  svc.runs.sweep();
  return sendJson(res, 200, { runs: svc.runs.summaries() });
}

export async function handleCoachRunStream(req, res, ctx) {
  const svc = serviceFor(ctx);
  const id = ctx?.params?.id;
  const run = typeof id === 'string' ? svc.runs.get(id) : null;
  if (!run) {
    // Before the stream opens, so this is an ordinary 404 rather than an error event.
    throw new HttpError(404, 'RUN_NOT_FOUND', 'That coach turn is no longer being held.');
  }
  const stream = new SseStream(res);
  const detach = svc.runs.attach(run, stream);
  res.on('close', () => { stream.closed = true; detach(); });
}

export async function handleCoachStop(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);
  const id = typeof body.runId === 'string' && body.runId ? body.runId : null;
  const slug = isSafeSlug(body.slug) ? body.slug : null;
  if (!id && !slug) {
    throw new HttpError(400, 'BAD_REQUEST', 'Stopping a turn needs either "runId" or "slug".');
  }
  return sendJson(res, 200, { stopped: svc.runs.stop({ id, slug }) });
}

// ---------------------------------------------------------------------------------------
// POST /api/sessions/event
// ---------------------------------------------------------------------------------------

export async function handleSessionEvent(req, res, ctx) {
  const svc = serviceFor(ctx);
  const body = await readJsonBody(req);

  if (!isSafeSlug(body.slug)) {
    throw new HttpError(400, 'BAD_REQUEST', '"slug" is required and must be a problem slug.');
  }
  if (!isKnownEventType(body.type)) {
    throw new HttpError(
      400,
      'BAD_REQUEST',
      `"type" must be one of: ${EVENT_TYPES.join(', ')}.`,
    );
  }
  if (body.data !== undefined && (typeof body.data !== 'object' || body.data === null)) {
    throw new HttpError(400, 'BAD_REQUEST', '"data", when given, must be an object.');
  }

  const { sessionId, event } = await svc.sessionLog.appendEvent(body.slug, body.type, body.data);
  return sendJson(res, 200, {
    sessionId,
    at: event.at,
    file: path.join('problems', body.slug, 'sessions', `${sessionId}.jsonl`),
  });
}

// ---------------------------------------------------------------------------------------
// GET /api/sessions/:slug
// ---------------------------------------------------------------------------------------

export async function handleGetSessions(req, res, ctx) {
  const svc = serviceFor(ctx);
  const slug = slugFrom(req, ctx);
  const sessions = await svc.sessionLog.readSessions(slug);
  return sendJson(res, 200, { sessions });
}

// ---------------------------------------------------------------------------------------
// GET /api/problems/:slug/history
// ---------------------------------------------------------------------------------------

/** Everything this problem remembers: what was submitted, and what was said about it. */
export async function handleHistory(req, res, ctx) {
  const svc = serviceFor(ctx);
  const slug = slugFrom(req, ctx);

  const [threads, meta] = await Promise.all([
    readThreads({ root: svc.root, slug }).catch(() => []),
    readMeta(svc.root, slug),
  ]);

  const submissions = Array.isArray(meta?.submissions) ? [...meta.submissions].reverse() : [];
  // The code goes with the verdict. A list of verdicts with nothing behind them cannot
  // answer the only question worth asking of it: what changed between these two.
  for (const entry of submissions) {
    entry.code = entry.codeFile ? await readCode(svc.root, slug, entry.codeFile) : null;
  }

  return sendJson(res, 200, { slug, submissions, threads });
}

/** Read one stored submission, confined to this problem's submissions directory. */
async function readCode(root, slug, codeFile) {
  const dir = path.join(root, 'problems', slug, 'submissions');
  const file = path.resolve(dir, path.basename(String(codeFile)));
  if (!file.startsWith(dir + path.sep)) return null; // never read outside where we wrote
  try {
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readMeta(root, slug) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, 'problems', slug, 'meta.json'), 'utf8'));
  } catch {
    return null; // never submitted, or a meta.json we must not "repair"
  }
}

export const routes = {
  'POST /api/coach/message': handleCoachMessage,
  'GET /api/coach/runs': handleCoachRuns,
  'GET /api/coach/runs/:id': handleCoachRunStream,
  'POST /api/coach/stop': handleCoachStop,
  'GET /api/problems/:slug/history': handleHistory,
  'POST /api/sessions/event': handleSessionEvent,
  'GET /api/sessions/:slug': handleGetSessions,
};

export default routes;
