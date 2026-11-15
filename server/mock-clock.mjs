// Attended time for every timed mock (coding, LLD, system design).
//
// The server owns elapsed time. A mock's clock counts only while the session is
// demonstrably attended: the open, visible page renews `lastSeenAt` with a light
// heartbeat (and every request that is itself attended renews it too). If nothing is
// heard for AWAY_AFTER_MS, the session is treated as paused from `lastSeenAt`, and the
// next server touch records that as an explicit `pause` with `reason: 'away'`. Only an
// explicit Resume starts it again; a heartbeat never restarts a stopped clock.
//
// Sessions recorded before heartbeats existed have no `lastSeenAt`. Their attended time
// is derived from evidence already in the record: on the active-time axis (the records'
// own pause-adjusted `elapsedMs`), any stretch longer than LEGACY_GAP_MS with nothing
// recorded counts as time away, from the last recorded activity. Raw lines are never
// rewritten: finished records are derived at read time, and an unfinished one that is
// picked up again gets one appended `clock_correction` record stating the basis.

export const HEARTBEAT_MS = 30_000;
export const AWAY_AFTER_MS = 90_000;
export const LEGACY_GAP_MS = 30 * 60_000;

/** Tracked by heartbeats: created, or picked up again, after this rule existed. */
export const isTracked = state => Number.isFinite(state?.lastSeenAt);

/** When a running, tracked session stopped being attended; null while it still is. */
export function lapseAt(state, running, now = Date.now()) {
  if (!running || !isTracked(state)) return null;
  return now - state.lastSeenAt > AWAY_AFTER_MS ? state.lastSeenAt : null;
}

/**
 * Stretches of the active-time axis, from 0 to `endMs`, longer than the threshold with
 * no recorded point inside them. Each one runs from the last recorded activity to the
 * next one (or to the end). Points outside [0, endMs] are ignored, never clamped in.
 */
export function silentGaps(points, endMs, thresholdMs = LEGACY_GAP_MS) {
  if (!Number.isFinite(endMs) || endMs <= 0) return [];
  const sorted = [...new Set(points.filter(p => Number.isFinite(p) && p >= 0 && p <= endMs))].sort((a, b) => a - b);
  const gaps = [];
  let previous = 0;
  for (const point of [...sorted, endMs]) {
    if (point - previous > thresholdMs) gaps.push({ fromMs: previous, toMs: point });
    previous = Math.max(previous, point);
  }
  return gaps;
}

export const gapsTotal = (gaps = []) => gaps.reduce((n, g) => n + Math.max(0, g.toMs - g.fromMs), 0);

/** A raw active-time stamp moved onto attended time: the away stretches before it removed. */
export function withoutGaps(ms, gaps = []) {
  if (!Number.isFinite(ms) || !gaps.length) return ms;
  let out = ms;
  for (const gap of gaps) if (ms > gap.fromMs) out -= Math.min(ms, gap.toMs) - gap.fromMs;
  return Math.max(0, out);
}

/**
 * Copies of the records with `attendedMs` beside their raw `elapsedMs`, for display. Only
 * records written before `beforeIndex` (the correction record, when there is one) are
 * moved: anything written after it was already measured on the corrected clock.
 */
export function attendedRecords(records = [], gaps = [], beforeIndex = records.length) {
  return records.map((record, index) => Number.isFinite(record?.elapsedMs)
    ? { ...record, attendedMs: index < beforeIndex ? withoutGaps(record.elapsedMs, gaps) : record.elapsedMs }
    : record);
}

/** The latest correction in a record, as { gaps, index }, or null. */
export function recordedCorrection(records = []) {
  const index = records.findLastIndex(r => r?.kind === 'clock_correction' && Array.isArray(r.gaps));
  return index < 0 ? null : { index, gaps: records[index].gaps };
}

/**
 * Points on the active-time axis where something was recorded. A pause the server made
 * on its own (another interview resumed, an away pause) and a clock correction are not
 * evidence that anybody was there.
 */
export function activityPoints(records = []) {
  return records.filter(r => r && Number.isFinite(r.elapsedMs) && r.elapsedMs >= 0
    && !(r.kind === 'pause' && r.reason) && r.kind !== 'clock_correction').map(r => r.elapsedMs);
}

/** The public clock reading. `elapsedMs` is attended time; `rawElapsedMs` is the old wall-clock count. */
export function clockReading({ elapsedMs, rawElapsedMs = elapsedMs, running, pauseReason = null, gaps = [], basis = null }) {
  const awayMs = gapsTotal(gaps);
  return {
    elapsedMs: Math.max(0, Math.round(elapsedMs)), rawElapsedMs: Math.max(0, Math.round(rawElapsedMs)), running: Boolean(running),
    pauseReason: running ? null : pauseReason, awayMs,
    // Present only when something was left out, so a screen can say so rather than show a smaller number silently.
    ...(awayMs > 0 ? { awayBasis: basis, legacyGapMs: LEGACY_GAP_MS } : {}),
    heartbeatMs: HEARTBEAT_MS, awayAfterMs: AWAY_AFTER_MS,
  };
}

/** "41 days", "3 h 12 min", "45 min": how much was left out, in words. */
export function awayText(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
  return `${Math.round(hours / 24)} days`;
}
