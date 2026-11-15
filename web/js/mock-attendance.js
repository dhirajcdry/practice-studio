// Attended time for every timed mock, on the page side. The server owns elapsed time
// (server/mock-clock.mjs); this keeps it told that someone is here, cheaply:
//
// - a heartbeat at most every 30 s, only while the mock runs, the page is visible and
//   someone has touched it (key, pointer, wheel, speech) in the last 10 minutes; any other
//   request the screen makes counts as contact and pushes the next heartbeat back;
// - one more on returning (visible, focus, input after a long quiet), and a keepalive one
//   when the page is hidden or closed, so an absence starts exactly when it began;
// - a check every 5 s, never per second, and no work at all while the page is hidden.
//
// The clock on screen is a local reading: the server's attended time plus the time since
// that answer arrived, measured on the monotonic clock, so a skewed or jumping wall clock
// cannot move it. If nothing has been confirmed for AWAY_AFTER_MS, the reading stops where
// the server will stop it, and a wall-clock jump (sleep) asks the server before ticking on.

export const HEARTBEAT_MS = 30_000;
export const AWAY_AFTER_MS = 90_000;
export const IDLE_AFTER_MS = 10 * 60_000;
const CHECK_MS = 5_000;
const INPUTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'];

export function createMockClock() {
  let base = { elapsedMs: 0, running: false, pauseReason: null, awayMs: 0, at: performance.now() };
  let contactAt = performance.now(), verifyAt = null;
  const lapsed = () => base.running && performance.now() - contactAt > AWAY_AFTER_MS;
  return {
    /** A clock reading from the server (`clock` in its responses). */
    set(clock) {
      if (!clock || !Number.isFinite(clock.elapsedMs)) return;
      base = { ...clock, at: performance.now() }; contactAt = base.at; verifyAt = null;
    },
    /** Any successful request to this session is contact. */
    contact() { contactAt = performance.now(); },
    contactAt: () => contactAt,
    /** Hold the reading where it is until the server answers (after a sleep). */
    verify() { verifyAt ??= performance.now(); },
    get running() { return base.running && !lapsed() && verifyAt === null; },
    get away() { return base.running ? lapsed() : base.pauseReason === 'away'; },
    get pauseReason() { return base.pauseReason; },
    get awayMs() { return base.awayMs || 0; },
    get reading() { return base; },
    /** Attended milliseconds now, as the server will count them. */
    elapsed() {
      if (!base.running) return base.elapsedMs;
      let until = performance.now();
      if (verifyAt !== null) until = Math.min(until, verifyAt);
      if (lapsed()) until = Math.min(until, contactAt);
      return base.elapsedMs + Math.max(0, until - base.at);
    },
    lapsed,
  };
}

/**
 * `running()` says whether the mock's clock is meant to be counting here; `beat()` sends a
 * heartbeat and resolves once its reading is applied; `beacon()` sends the keepalive one.
 */
export function createAttendance({ running, beat, beacon, clock }) {
  let lastInput = performance.now(), wall = Date.now(), perf = performance.now(), inFlight = false, gone = false;
  const sinceContact = () => performance.now() - clock.contactAt();
  async function send() {
    if (gone || inFlight || !running()) return;
    inFlight = true;
    try { await beat(); clock.contact(); } catch { /* the next check tries again; nothing is retried in a loop */ }
    finally { inFlight = false; }
  }
  const onInput = () => {
    const quiet = performance.now() - lastInput;
    lastInput = performance.now();
    // Back after a long quiet: ask now, so a stopped clock shows as stopped at once.
    if (running() && (clock.lapsed() || quiet > HEARTBEAT_MS)) void send();
  };
  const leave = () => {
    if (!gone && running() && performance.now() - lastInput < IDLE_AFTER_MS) beacon();
  };
  const onVisibility = () => { if (document.hidden) leave(); else { lastInput = performance.now(); void send(); } };
  const onFocus = () => { lastInput = performance.now(); if (clock.lapsed() || sinceContact() > HEARTBEAT_MS) void send(); };
  for (const type of INPUTS) window.addEventListener(type, onInput, { capture: true, passive: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  window.addEventListener('pagehide', leave);
  let lastBeat = performance.now();
  const timer = setInterval(() => {
    const p = performance.now(), w = Date.now();
    // The wall clock moved much further than the monotonic one: the machine slept.
    const slept = (w - wall) - (p - perf) > 15_000;
    wall = w; perf = p;
    if (gone || !running() || document.hidden) return;
    if (slept) { clock.verify(); void send(); return; }
    if (p - lastInput > IDLE_AFTER_MS) return;   // nobody here: let the lease lapse
    if (p - Math.max(lastBeat, clock.contactAt()) >= HEARTBEAT_MS) { lastBeat = p; void send(); }
  }, CHECK_MS);
  return {
    /** Speech counts as being here, as a key or pointer does. */
    noteActivity() { lastInput = performance.now(); },
    /** Ask now (after mounting, or after resuming). */
    now: () => send(),
    dispose() {
      if (gone) return;
      leave(); gone = true; clearInterval(timer);
      for (const type of INPUTS) window.removeEventListener(type, onInput, { capture: true });
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pagehide', leave);
    },
  };
}
