// Pure interview accounting. Times are active milliseconds since the wall-clock start.
// Elapsed time is attended time: see server/mock-clock.mjs for the heartbeat rule and
// how records from before it are read.
import { lapseAt, isTracked, silentGaps, activityPoints, gapsTotal, withoutGaps, recordedCorrection, clockReading, LEGACY_GAP_MS, AWAY_AFTER_MS } from '../mock-clock.mjs';
export const PHASES = Object.freeze(['clarify', 'approach', 'code', 'test', 'followup']);
export function newState({ slug, minutes = 45, mode = 'voice', startedAt = Date.now() }) {
  if (![30, 45, 60].includes(minutes)) throw Error('Choose 30, 45, or 60 minutes.');
  if (!['typed', 'voice'].includes(mode)) throw Error('Choose Typed or Voice.');
  return { slug, minutes, mode, startedAt, pausedAt: null, pausedMs: 0, endedAt: null,
    phase: 'clarify', phaseSinceMs: 0, phaseMs: Object.fromEntries(PHASES.map(p => [p, 0])),
    hints: [], turns: 0, lastSpeechAt: startedAt, lastTypingAt: startedAt,
    lastInterjectAt: null, pendingEvents: [], warningGiven: false, debriefed: false,
    lastCode: null, requests: {}, coachProvider: null, coachModel: null, claudeSessionId: null };
}
const clockRunning = state => state.pausedAt == null && state.endedAt == null && !state.debriefed;
export function elapsed(state, now = Date.now()) {
  // A tracked session nobody has attended for AWAY_AFTER_MS stopped at its last heartbeat.
  const end = Math.min(state.endedAt ?? now, state.pausedAt ?? lapseAt(state, clockRunning(state), now) ?? Infinity);
  return Math.max(0, end - state.startedAt - (state.pausedMs || 0));
}
/** An attended contact while the clock runs renews the lease; it never restarts a lapsed clock. */
export function touch(state, now = Date.now()) {
  if (!isTracked(state) || !clockRunning(state) || lapseAt(state, true, now) !== null) return false;
  state.lastSeenAt = Math.max(state.lastSeenAt, now);
  return true;
}
export function phaseTimes(state, now = Date.now()) {
  return { ...state.phaseMs, [state.phase]: state.phaseMs[state.phase] + elapsed(state, now) - state.phaseSinceMs };
}
export function advance(state, phase, now = Date.now()) {
  if (!PHASES.includes(phase) || phase === state.phase) return;
  state.phaseMs = phaseTimes(state, now);
  state.phaseSinceMs = elapsed(state, now);
  state.phase = phase;
}
export function pause(state, now = Date.now(), reason = 'pause') {
  if (state.pausedAt != null) return;
  const lapse = lapseAt(state, clockRunning(state), now);
  state.pausedAt = lapse ?? now;
  state.pauseReason = lapse === null ? reason : 'away';
}
export function resume(state, now = Date.now()) {
  if (state.pausedAt != null) { state.pausedMs += now - state.pausedAt; state.pausedAt = null; }
  state.pauseReason = null;
  state.lastSeenAt = now;
}

/**
 * Stretches of a record from before heartbeats with nothing recorded for longer than
 * LEGACY_GAP_MS. Points are the records' own active-time stamps, plus the candidate's
 * last speech and typing when they fall in the current run. Tracked sessions have none:
 * their correction, if any, is already in the clock.
 */
export function legacyGaps(state, turns = [], now = Date.now()) {
  if (isTracked(state)) return [];
  const end = elapsed(state, now);
  const points = activityPoints(turns);
  const last = points.length ? Math.max(...points) : 0;
  for (const at of [state.lastSpeechAt, state.lastTypingAt]) {
    if (!Number.isFinite(at)) continue;
    const ms = Math.min(at, state.pausedAt ?? Infinity, state.endedAt ?? Infinity) - state.startedAt - (state.pausedMs || 0);
    if (ms >= last && ms <= end) points.push(ms);
  }
  return silentGaps(points, end);
}
/** The gaps to take out of this record's stamps, and the records they apply to. */
export function clockGaps(state, turns = [], now = Date.now()) {
  if (!isTracked(state)) return { gaps: legacyGaps(state, turns, now), beforeIndex: turns.length };
  const correction = recordedCorrection(turns);
  return correction ? { gaps: correction.gaps, beforeIndex: correction.index } : { gaps: [], beforeIndex: 0 };
}
/** Phase times with each away stretch taken from the phase that was in force during it. */
export function attendedPhaseTimes(state, turns, gaps, now = Date.now()) {
  const times = phaseTimes(state, now);
  for (const gap of gaps) {
    const before = turns.findLast(t => Number.isFinite(t.elapsedMs) && t.elapsedMs <= gap.fromMs && PHASES.includes(t.phase));
    const phase = before?.phase || state.phase;
    times[phase] = Math.max(0, (times[phase] || 0) - (gap.toMs - gap.fromMs));
  }
  return times;
}
/** The clock as screens and reports read it: attended time, with what was left out. */
export function interviewClock(state, turns = null, now = Date.now()) {
  const running = clockRunning(state), lapse = lapseAt(state, running, now);
  const raw = elapsed(state, now);
  const { gaps } = turns ? clockGaps(state, turns, now) : { gaps: [] };
  const legacy = !isTracked(state);
  const away = legacy ? gapsTotal(gaps) : 0;
  const tailAway = legacy && gaps.length > 0 && gaps.at(-1).toMs >= raw;
  return clockReading({ elapsedMs: raw - away, rawElapsedMs: legacy ? raw : raw + gapsTotal(gaps), running: running && lapse === null && !tailAway,
    pauseReason: lapse !== null || tailAway ? 'away' : state.pauseReason || 'pause', gaps, basis: gaps.length ? 'recorded activity' : null });
}
/**
 * Brings an unfinished session's clock onto the rule, once. A tracked session that has
 * lapsed is paused at its last heartbeat; a session from before heartbeats has its silent
 * stretches taken out and starts being tracked. Returns the record to append, if any.
 */
export function settleClock(state, turns = [], now = Date.now()) {
  if (state.debriefed || state.endedAt != null) return null;
  if (isTracked(state)) {
    const lapse = lapseAt(state, clockRunning(state), now);
    if (lapse === null) return null;
    state.pausedAt = lapse; state.pauseReason = 'away';
    return { kind: 'pause', reason: 'away', basis: 'heartbeat', lastSeenAt: new Date(lapse).toISOString(), awayAfterMs: AWAY_AFTER_MS };
  }
  const gaps = legacyGaps(state, turns, now), raw = elapsed(state, now);
  state.lastSeenAt = now;
  if (!gaps.length) return null;
  const away = gapsTotal(gaps), tail = gaps.at(-1).toMs >= raw;
  const times = attendedPhaseTimes(state, turns, gaps, now);
  state.hints = (state.hints || []).map(h => ({ ...h, elapsedMs: withoutGaps(h.elapsedMs, gaps) }));
  if (state.pausedAt == null && tail) { state.pausedAt = now; state.pauseReason = 'away'; }
  state.pausedMs = (state.pausedMs || 0) + away;
  state.phaseMs = times; state.phaseSinceMs = elapsed(state, now);
  return { kind: 'clock_correction', basis: 'recorded activity', thresholdMs: LEGACY_GAP_MS, gaps, rawElapsedMs: raw, attendedMs: raw - away, inferredPause: tail };
}
export function recordHints(state, levels, now = Date.now()) {
  for (const level of levels) if (['nudge', 'narrow', 'explicit'].includes(level)) {
    state.hints.push({ level, elapsedMs: elapsed(state, now), phase: state.phase });
  }
}
export function clock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function observe(state, event, now = Date.now()) {
  // A fresh browser reports its actual idle ages. Unknown ages never grant permission
  // to interrupt; nor does repeatedly polling make a silent candidate seem to speak.
  for (const [field, age] of [['lastSpeechAt', event.secondsSinceSpeech], ['lastTypingAt', event.secondsSinceTyping]]) {
    if (Number.isFinite(age) && age >= 0) state[field] = now - age * 1000;
  }
  if (['verdict', 'run_result', 'phase_hint'].includes(event.type)) state.pendingEvents.push({ ...event, elapsedMs: Number.isFinite(event.elapsedMs) && event.elapsedMs >= 0 && event.elapsedMs <= elapsed(state, now) ? event.elapsedMs : elapsed(state, now) });
}
export const LOOK_EVERY_MS = 5 * 60000;
export function shouldInterject(state, event = {}, now = Date.now()) {
  if (state.debriefed || state.endedAt !== null || state.pausedAt !== null || event.speaking) return false;
  const speech = Number.isFinite(event.secondsSinceSpeech) ? event.secondsSinceSpeech : (now - state.lastSpeechAt) / 1000;
  const typing = Number.isFinite(event.secondsSinceTyping) ? event.secondsSinceTyping : (now - state.lastTypingAt) / 1000;
  if (speech < 20 || (state.lastInterjectAt !== null && now - state.lastInterjectAt < 120000)) return false;
  const events = [...state.pendingEvents, event];
  if (events.some(e => e.type === 'verdict')) return true;
  const remaining = state.minutes * 60000 - elapsed(state, now);
  if (!state.warningGiven && remaining <= 120000 && remaining > 0) return true;
  if (events.some(e => e.type === 'run_result' && (e.failed > 0 || e.error)) && speech > 30) return true;
  if (event.type !== 'idle') return false;
  // An LLD interviewer glances at the work every five minutes, typing or not, as one in the room would.
  if (state.discipline === 'lld' && now - Math.max(state.lastInterjectAt || 0, state.lastReplyAt || state.startedAt) >= LOOK_EVERY_MS) return true;
  const threshold = state.phase === 'code' ? 90 : ['clarify', 'approach'].includes(state.phase) ? 45 : Infinity;
  return speech >= threshold && typing >= threshold;
}
export function factBlock(state, now = Date.now()) {
  const times = Object.entries(phaseTimes(state, now)).map(([p, ms]) => `${p} ${clock(ms)}`).join(', ');
  return `Elapsed ${clock(elapsed(state, now))}; remaining ${clock(state.minutes * 60000 - elapsed(state, now))}.\nPhase ${state.phase}; phase time: ${times}.\nHints: ${state.hints.length} (${state.hints.map(h => `${h.level}@${clock(h.elapsedMs)}`).join(', ') || 'none'}).\nCandidate last spoke/typed ${Math.floor((now - state.lastSpeechAt) / 1000)}s/${Math.floor((now - state.lastTypingAt) / 1000)}s ago.`;
}
export function codeContext(previous, current, turns = 0, force = false) {
  if (typeof current !== 'string') return 'Buffer unavailable.';
  if (force || previous === null || turns % 5 === 0) return `Full buffer:\n${current}`;
  if (previous === current) return 'Buffer unchanged.';
  const a = previous.split('\n'), b = current.split('\n');
  let start = 0, tail = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (tail < a.length - start && tail < b.length - start && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const removed = a.slice(start, a.length - tail), added = b.slice(start, b.length - tail);
  const diff = `Replace lines ${start + 1}–${a.length - tail} with:\n${added.join('\n')}\nRemoved:\n${removed.join('\n')}`;
  return diff.length > current.length * .7 ? `Full buffer:\n${current}` : diff;
}
