// A stopwatch, not an interview deadline. Only explicit transitions write state;
// elapsed time is derived from the server clock, never from client tick counters.
function normalized(timer) {
  const elapsedMs = Number(timer?.elapsedMs);
  return {
    elapsedMs: Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0,
    runningSince: Number.isFinite(timer?.runningSince) && timer.runningSince >= 0 ? timer.runningSince : null,
  };
}

export function elapsedPracticeTime(timer, now = Date.now()) {
  const { elapsedMs, runningSince } = normalized(timer);
  return elapsedMs + (runningSince === null ? 0 : Math.max(0, now - runningSince));
}

export function setTimerRunning(timer, running, now = Date.now()) {
  const current = normalized(timer);
  if (running === (current.runningSince !== null)) return current;
  return running
    ? { elapsedMs: current.elapsedMs, runningSince: now }
    : { elapsedMs: elapsedPracticeTime(current, now), runningSince: null };
}
