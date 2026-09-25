// Coach turns that outlive the panel that started them — and now the page too.
//
// A turn used to belong to the panel: ask a question, navigate to another problem, and
// the panel was disposed, the fetch aborted, and the CLI killed mid-sentence. So asking
// anything long pinned you to that screen until it finished — the one thing you should
// never have to wait for is the tutor.
//
// A run belongs to the app instead. The panel is a view onto it: it attaches when it
// mounts, paints whatever has arrived so far, and detaches without touching the stream.
// Come back two problems later and the answer is there, finished or still arriving.
//
// The run itself lives on the SERVER (see server/coach/runs.mjs), which is what makes a
// reload survivable. This registry is the browser's view of that: `adopt()` asks what is
// still in flight and re-attaches to it, and a connection that drops mid-answer
// re-attaches rather than reporting a failure — the server replays what already arrived,
// so recovery gives back the whole answer rather than the tail.
//
// One run per problem at a time. Two concurrent turns on the same problem would resume
// the same CLI session twice and interleave two answers into one thread.

import { streamCoachMessage, attachCoachRun, listCoachRuns, stopCoachRun } from './api.js';

/** @type {Map<string, object>} slug → run */
const runs = new Map();
const globalListeners = new Set();

/** A view that drops is worth re-opening a few times; a server that is gone is not. */
const RECOVERABLE = new Set(['offline', 'truncated', 'timeout']);
const MAX_RECOVERIES = 3;
const RECOVERY_DELAY_MS = 600;

function announce() {
  for (const fn of globalListeners) {
    try { fn(); } catch { /* a broken indicator must not break the stream */ }
  }
}

function emit(run, event) {
  for (const fn of run.listeners) {
    try { fn(event, run); } catch { /* same */ }
  }
}

export function runFor(slug) {
  return runs.get(slug) || null;
}

/** Runs that are still going, or finished and not yet looked at, for OTHER problems. */
export function runsElsewhere(currentSlug = null) {
  return [...runs.values()]
    .filter((r) => r.slug !== currentSlug && !r.dismissed && (!r.done || !r.seen));
}

/**
 * Take the standing note away without touching the turn behind it.
 *
 * Only the note. The coach keeps writing, the answer is still filed in the problem's
 * transcript, and going to that problem still shows it — this silences an indicator, it
 * does not cancel anything. Stopping is Stop, and it is somewhere else on purpose.
 */
export function dismissRun(slug) {
  const run = runs.get(slug);
  if (!run || run.dismissed) return;
  run.dismissed = true;
  announce();
}

/** Called whenever a run starts, finishes, or is cleared. For the indicator. */
export function onRunsChange(fn) {
  globalListeners.add(fn);
  return () => globalListeners.delete(fn);
}

/**
 * Watch one problem's run. The callback fires for 'token', 'tool' and 'done'.
 * @returns {() => void} detach — this does NOT stop the run
 */
export function watch(slug, fn) {
  const run = runs.get(slug);
  if (!run) return () => {};
  run.listeners.add(fn);
  return () => run.listeners.delete(fn);
}

/** The panel has shown this run to a human; it no longer needs holding onto. */
export function markSeen(slug) {
  const run = runs.get(slug);
  if (!run) return;
  run.seen = true;
  if (run.done) runs.delete(slug);
  announce();
}

/**
 * Stop button, or a new attempt starting. Deliberate, and it keeps what arrived.
 *
 * This has to reach the server. Aborting the fetch used to be enough because the server
 * killed the CLI when the connection dropped — but that is exactly the behaviour that
 * made a page reload kill a turn, so now nothing but this ends one early.
 */
export function stopRun(slug) {
  const run = runs.get(slug);
  if (!run || run.done) return;
  run.stopping = true;
  stopCoachRun({ slug, runId: run.serverId ?? null }).catch(() => {});
  // Also drop the view, so the panel stops painting the moment you press it rather than
  // when the CLI notices.
  try { run.controller.abort(); } catch { /* already gone */ }
}

function newRun({ slug, title, message, kind, lead, startedAt = new Date().toISOString() }) {
  return {
    slug,
    title: title || slug,
    ask: message,
    kind,
    lead,
    review: kind === 'attempt-review',
    startedAt,
    text: '',
    tools: [],
    done: false,
    seen: false,
    dismissed: false,   // the note was waved away; the turn itself is untouched
    stopping: false,
    result: null,
    serverId: null,
    recoveries: 0,
    controller: new AbortController(),
    listeners: new Set(),
  };
}

/** Wire one stream's events into a run, and decide what a failure means. */
function consume(run, open) {
  const handlers = {
    signal: run.controller.signal,
    onRun: (info) => { run.serverId = info.id; },
    onToken: (chunk) => { run.text += chunk; emit(run, 'token'); },
    onTool: (name, summary) => { run.tools.push({ name, summary }); emit(run, 'tool'); },
  };

  open(handlers).then((result) => {
    // The view dropped, not the turn. The server is still thinking and still holding
    // every token; re-attaching replays them, so nothing is lost and nothing is doubled
    // (the replay REPLACES what we have rather than appending to it).
    const recoverable =
      !result.ok && RECOVERABLE.has(result.kind) && run.serverId && !run.stopping
      && run.recoveries < MAX_RECOVERIES;

    if (recoverable) {
      run.recoveries += 1;
      run.controller = new AbortController();
      run.text = '';
      run.tools = [];
      emit(run, 'token');
      setTimeout(() => {
        consume(run, (h) => attachCoachRun(run.serverId, h));
      }, RECOVERY_DELAY_MS);
      return;
    }

    run.result = result;
    run.done = true;
    emit(run, 'done');
    // Nobody is watching: the answer waits in the registry until the panel comes back,
    // and the indicator says where it is. Watched runs are dropped by markSeen.
    if (run.listeners.size === 0) run.seen = false;
    announce();
  });
}

/**
 * Start a turn for one problem.
 *
 * Returns the run immediately — the caller paints from `run.text` and subscribes with
 * `watch`. Refuses to start a second run for the same problem while one is live.
 */
export function startRun({
  slug, title = '', message = '', kind = null, attemptId = null,
  newThread = false, resumeSessionId = null, lead = null,
}) {
  const existing = runs.get(slug);
  if (existing && !existing.done) return existing;

  const run = newRun({ slug, title, message, kind, lead });
  runs.set(slug, run);
  announce();

  consume(run, (handlers) => streamCoachMessage(slug, message, {
    ...handlers, kind, attemptId, newThread, resumeSessionId,
  }));

  return run;
}

/**
 * Pick up whatever the server is still holding. Called once, on load.
 *
 * This is what makes a refresh survivable: the turn never stopped, so the page simply
 * finds it again and carries on painting it.
 */
export async function adopt() {
  const { ok, runs: found } = await listCoachRuns();
  if (!ok || found.length === 0) return 0;

  let adopted = 0;
  for (const summary of found) {
    // A run this tab already knows about — it started it, and is still streaming it.
    if (runs.has(summary.slug)) continue;

    const run = newRun({
      slug: summary.slug,
      title: summary.title,
      message: summary.ask ?? '',
      kind: summary.kind,
      lead: summary.lead,
      startedAt: summary.startedAt,
    });
    run.serverId = summary.id;
    // Adopted rather than watched from the start: it has not been on screen in this tab,
    // so the indicator should offer it.
    run.seen = false;
    runs.set(summary.slug, run);
    adopted += 1;
    consume(run, (handlers) => attachCoachRun(summary.id, handlers));
  }

  if (adopted) announce();
  return adopted;
}
