// The system design mock's clock, on the attended-time rule in server/mock-clock.mjs.
//
// A design interview keeps its clock as `startedAt` (shifted forward on resume, so
// `now - startedAt` is time spent) plus `pausedAt`/`spentMs` while paused. Records
// carry the pause-adjusted `elapsedMs`; scenes carry only their wall time.
import {
  lapseAt, isTracked, silentGaps, activityPoints, gapsTotal, recordedCorrection, clockReading,
  AWAY_AFTER_MS, LEGACY_GAP_MS,
} from '../mock-clock.mjs';

const running = state => !state.pausedAt && !state.endedAt && !state.debriefed;

/** Time spent by the old rule: everything since the (shifted) start that was not an explicit pause. */
export function rawDesignElapsed(state, now = Date.now()) {
  if (!state?.startedAt) return 0;
  if (state.pausedAt) return Math.max(0, Number.isFinite(state.spentMs) ? state.spentMs : state.pausedAt - state.startedAt);
  return Math.max(0, (state.endedAt ?? now) - state.startedAt);
}

/** Time spent, stopping at the last heartbeat of a tracked session nobody is attending. */
export function designElapsed(state, now = Date.now()) {
  const lapse = lapseAt(state, running(state), now);
  return lapse === null ? rawDesignElapsed(state, now) : Math.max(0, lapse - state.startedAt);
}

/**
 * Drawing is activity too. A scene has only its wall time, so it is placed on the active
 * axis from the record before it (its `elapsedMs` plus the wall time since), and never
 * later than the next record or the current run's own reading of that moment.
 */
function scenePoints(turns, scenes, state) {
  const timed = turns.filter(t => Number.isFinite(t.elapsedMs) && Number.isFinite(Date.parse(t.at)))
    .map(t => ({ at: Date.parse(t.at), ms: t.elapsedMs })).sort((a, b) => a.at - b.at);
  const points = [];
  for (const scene of scenes) {
    const at = Date.parse(scene.at);
    if (!Number.isFinite(at)) continue;
    const before = timed.findLast(t => t.at <= at), after = timed.find(t => t.at > at);
    if (!before) continue;
    const current = state.startedAt ? at - state.startedAt : -1;
    const upper = after ? after.ms : current >= before.ms ? current : before.ms;
    points.push(Math.min(before.ms + (at - before.at), upper));
  }
  return points;
}

/** Silent stretches of a record from before heartbeats (none for a tracked one). */
export function legacyDesignGaps(state, turns = [], scenes = [], now = Date.now()) {
  if (isTracked(state)) return [];
  return silentGaps([...activityPoints(turns), ...scenePoints(turns, scenes, state)], rawDesignElapsed(state, now));
}

/** The gaps to take out of this record's stamps, and the records they apply to. */
export function designClockGaps(state, turns = [], scenes = [], now = Date.now()) {
  if (!isTracked(state)) return { gaps: legacyDesignGaps(state, turns, scenes, now), beforeIndex: turns.length };
  const correction = recordedCorrection(turns);
  return correction ? { gaps: correction.gaps, beforeIndex: correction.index } : { gaps: [], beforeIndex: 0 };
}

/** The clock as screens and reports read it: attended time, with what was left out. */
export function designClock(state, turns = null, scenes = [], now = Date.now()) {
  const live = running(state), lapse = lapseAt(state, live, now), raw = designElapsed(state, now);
  const { gaps } = turns ? designClockGaps(state, turns, scenes, now) : { gaps: [] };
  const legacy = !isTracked(state);
  const away = legacy ? gapsTotal(gaps) : 0;
  const tailAway = legacy && gaps.length > 0 && gaps.at(-1).toMs >= raw;
  return clockReading({ elapsedMs: raw - away, rawElapsedMs: legacy ? raw : raw + gapsTotal(gaps), running: live && lapse === null && !tailAway,
    pauseReason: lapse !== null || tailAway ? 'away' : state.pauseReason || 'pause', gaps, basis: gaps.length ? 'recorded activity' : null });
}

/**
 * Brings an unfinished interview's clock onto the rule, once (see settleClock in
 * server/interview/state.mjs, which this mirrors). Mutates `state`; returns the record to
 * append, or null.
 */
export function settleDesignClock(state, turns = [], scenes = [], now = Date.now()) {
  if (state.debriefed || state.endedAt) return null;
  if (isTracked(state)) {
    const lapse = lapseAt(state, running(state), now);
    if (lapse === null) return null;
    state.pausedAt = lapse; state.spentMs = Math.max(0, lapse - state.startedAt); state.pauseReason = 'away';
    return { kind: 'pause', reason: 'away', basis: 'heartbeat', lastSeenAt: new Date(lapse).toISOString(), awayAfterMs: AWAY_AFTER_MS, elapsedMs: state.spentMs };
  }
  const gaps = legacyDesignGaps(state, turns, scenes, now), raw = rawDesignElapsed(state, now);
  state.lastSeenAt = now;
  if (!gaps.length) return null;
  const away = gapsTotal(gaps), tail = gaps.at(-1).toMs >= raw;
  if (state.pausedAt) { state.spentMs = raw - away; if (tail) state.pauseReason = 'away'; }
  else if (tail) { state.pausedAt = now; state.spentMs = raw - away; state.pauseReason = 'away'; }
  else state.startedAt += away;
  return { kind: 'clock_correction', basis: 'recorded activity', thresholdMs: LEGACY_GAP_MS, gaps, rawElapsedMs: raw, attendedMs: raw - away, inferredPause: tail, elapsedMs: raw - away };
}

/** Pause and resume, as the explicit controls and the away rule both use them. */
export function pauseDesign(state, now = Date.now(), reason = 'pause') {
  if (state.pausedAt) return false;
  const lapse = lapseAt(state, running(state), now);
  state.pausedAt = lapse ?? now;
  state.spentMs = state.startedAt ? Math.max(0, state.pausedAt - state.startedAt) : 0;
  state.pauseReason = lapse === null ? reason : 'away';
  return true;
}
/** An attended contact while the clock runs renews the lease; it never restarts a lapsed clock. */
export function touchDesign(state, now = Date.now()) {
  if (!isTracked(state) || !running(state) || lapseAt(state, true, now) !== null) return false;
  state.lastSeenAt = Math.max(state.lastSeenAt, now);
  return true;
}
export function resumeDesign(state, now = Date.now()) {
  const spent = rawDesignElapsed(state, now);
  state.startedAt = now - spent;
  state.pausedAt = null; state.pauseReason = null;
  state.lastSeenAt = now;
  return spent;
}
