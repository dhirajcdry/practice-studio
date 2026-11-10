// A stopwatch, not an interview deadline. Only explicit transitions write state;
// elapsed time is derived from the server clock, never from client tick counters.
export const TIMER_LEASE_MS = 30_000;
export const MAX_TIMER_RUN_MS = 12 * 60 * 60 * 1000;
function normalized(timer) {
  const elapsedMs = Number(timer?.elapsedMs);
  const runningSince = Number.isFinite(timer?.runningSince) && timer.runningSince >= 0 ? timer.runningSince : null;
  const leaseUntil = Number.isFinite(timer?.leaseUntil) ? timer.leaseUntil : null;
  return {
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
    runningSince,
    leaseUntil: runningSince !== null && leaseUntil !== null ? Math.min(leaseUntil, runningSince + MAX_TIMER_RUN_MS) : leaseUntil,
  };
}

export function elapsedPracticeTime(timer, now = Date.now()) {
  const { elapsedMs, runningSince, leaseUntil } = normalized(timer);
  return elapsedMs + (runningSince === null ? 0 : Math.max(0, Math.min(now, leaseUntil ?? now, runningSince + MAX_TIMER_RUN_MS) - runningSince));
}

export function setTimerRunning(timer, running, now = Date.now()) {
  const current = expireTimer(timer, now);
  if (running === (current.runningSince !== null)) return current;
  return running
    ? { elapsedMs: current.elapsedMs, runningSince: now, leaseUntil: now + TIMER_LEASE_MS }
    : { elapsedMs: elapsedPracticeTime(current, now), runningSince: null, leaseUntil: null };
}

export function expireTimer(timer, now = Date.now()) {
  const current = normalized(timer);
  return current.runningSince !== null && (current.leaseUntil === null || now >= current.leaseUntil)
    ? { elapsedMs: elapsedPracticeTime(current, now), runningSince: null, leaseUntil: null }
    : current;
}

// Renew only this still-active run, never past 12 uninterrupted hours. A tab left
// open cannot keep tracking forever; a delayed heartbeat cannot start or resume it.
export function renewTimer(timer, runningSince, now = Date.now()) {
  const current = expireTimer(timer, now);
  return current.runningSince !== null && current.runningSince === runningSince
    ? { ...current, leaseUntil: Math.min(now + TIMER_LEASE_MS, current.runningSince + MAX_TIMER_RUN_MS) }
    : current;
}
