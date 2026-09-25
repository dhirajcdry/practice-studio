// Coach turns that outlive the connection that started them.
//
// The browser already keeps a turn alive across navigation — ask a question, move to
// another problem, come back and the answer is there. That only worked because the run
// lived in the tab. Reload the tab and it died: the fetch aborted, `res.on('close')`
// killed the CLI mid-sentence, and the half-written answer went to the transcript as
// `stopped`. A refresh is not a decision to stop.
//
// So the run lives here instead, on the server, and an HTTP response is just something
// watching it. Disconnecting detaches a viewer; it does not touch the process. The only
// things that stop a turn are the Stop button, the CLI finishing, and the timeout.
//
// What is kept per run is deliberately the same shape the browser keeps: the answer so
// far as one string, and the tool lines as a list. Replaying is then "here is the text,
// here are the tools", not a recording of every token that ever arrived.

/** A finished run stays adoptable this long, so a reload right after it lands still sees it. */
export const RETAIN_MS = 10 * 60 * 1000;

/** A ceiling on what one run holds for replay. The transcript keeps the real record. */
export const MAX_TEXT = 1_000_000;
export const MAX_TOOLS = 500;

/** A cap on the whole registry, so a pathological session cannot grow without bound. */
export const MAX_RUNS = 24;

let counter = 0;

function nextId(now) {
  counter += 1;
  return `coach-${now.toString(36)}-${counter}`;
}

export class CoachRuns {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.bySlug = new Map();
    this.byId = new Map();
  }

  /** The live run for a problem, or null. One at a time: two would resume one CLI session
   *  twice and interleave two answers into a single thread. */
  liveFor(slug) {
    const run = this.bySlug.get(slug);
    return run && run.status === 'running' ? run : null;
  }

  get(id) {
    return this.byId.get(id) ?? null;
  }

  start({ slug, ask = '', kind = null, review = false, title = '', lead = null }) {
    const startedAt = this.now();
    const run = {
      id: nextId(startedAt),
      slug,
      ask,
      kind,
      review,
      title,
      lead,
      startedAt: new Date(startedAt).toISOString(),
      text: '',
      tools: [],
      truncated: false,
      status: 'running',
      sessionId: null,
      stoppedReason: null,
      errorMessage: null,
      finishedAt: null,
      child: null,
      subscribers: new Set(),
    };
    this.bySlug.set(slug, run);
    this.byId.set(run.id, run);
    this.sweep();
    return run;
  }

  token(run, text) {
    if (run.text.length + text.length <= MAX_TEXT) run.text += text;
    else run.truncated = true;
    for (const stream of run.subscribers) stream.token(text);
  }

  tool(run, name, summary) {
    if (run.tools.length < MAX_TOOLS) run.tools.push({ name, summary: summary ?? null });
    for (const stream of run.subscribers) stream.tool(name, summary);
  }

  finish(run, { status, sessionId = null, stoppedReason = null, message = null }) {
    if (run.status !== 'running') return;
    run.status = status;
    run.sessionId = sessionId;
    run.stoppedReason = stoppedReason;
    run.errorMessage = message;
    run.finishedAt = this.now();
    run.child = null;
    for (const stream of run.subscribers) {
      if (status === 'error') stream.error(message ?? 'The coach stopped without a reason.');
      else { stream.done(sessionId, stoppedReason); stream.end(); }
    }
    run.subscribers.clear();
    this.sweep();
  }

  /**
   * Point one SSE stream at a run: what has already arrived, then the rest as it comes.
   *
   * A run that has already finished gets the whole thing and an immediate terminal event,
   * which is what makes reloading after it lands show the answer rather than nothing.
   */
  attach(run, stream) {
    stream.send('run', {
      id: run.id,
      slug: run.slug,
      ask: run.ask,
      kind: run.kind,
      review: run.review,
      startedAt: run.startedAt,
      status: run.status,
    });
    if (run.text) stream.token(run.text);
    for (const t of run.tools) stream.tool(t.name, t.summary);
    if (run.truncated) {
      stream.tool('note', 'This answer was too long to hold for replay in full; the transcript has all of it.');
    }

    if (run.status === 'running') {
      run.subscribers.add(stream);
      return () => run.subscribers.delete(stream);
    }
    if (run.status === 'error') stream.error(run.errorMessage ?? 'The coach stopped without a reason.');
    else { stream.done(run.sessionId, run.stoppedReason); stream.end(); }
    return () => {};
  }

  /** Stop a turn on purpose. Keeps whatever arrived — that half is worth having. */
  stop({ slug = null, id = null }) {
    const run = id ? this.byId.get(id) : this.bySlug.get(slug);
    if (!run || run.status !== 'running') return false;
    try {
      run.child?.kill();
    } catch {
      /* already gone */
    }
    return true;
  }

  /** What a freshly loaded page should know about. */
  summaries() {
    return [...this.byId.values()].map((run) => ({
      id: run.id,
      slug: run.slug,
      ask: run.ask,
      kind: run.kind,
      review: run.review,
      title: run.title,
      lead: run.lead,
      startedAt: run.startedAt,
      status: run.status,
      // Enough to paint the chip without opening a stream for every one of them.
      chars: run.text.length,
    }));
  }

  /** Drop finished runs once nothing could reasonably still want them. */
  sweep() {
    const cutoff = this.now() - RETAIN_MS;
    for (const [id, run] of this.byId) {
      const stale = run.status !== 'running' && (run.finishedAt ?? 0) < cutoff;
      if (!stale) continue;
      this.byId.delete(id);
      if (this.bySlug.get(run.slug) === run) this.bySlug.delete(run.slug);
    }
    // Hard ceiling, oldest finished first. Running turns are never evicted.
    if (this.byId.size <= MAX_RUNS) return;
    const finished = [...this.byId.values()]
      .filter((r) => r.status !== 'running')
      .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
    for (const run of finished) {
      if (this.byId.size <= MAX_RUNS) break;
      this.byId.delete(run.id);
      if (this.bySlug.get(run.slug) === run) this.bySlug.delete(run.slug);
    }
  }
}
