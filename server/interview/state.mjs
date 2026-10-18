// Pure interview accounting. Times are active milliseconds since the wall-clock start.
export const PHASES = Object.freeze(['clarify', 'approach', 'code', 'test', 'followup']);
export function newState({ slug, minutes = 45, mode = 'typed', startedAt = Date.now() }) {
  if (![30, 45, 60].includes(minutes)) throw Error('Choose 30, 45, or 60 minutes.');
  if (!['typed', 'voice'].includes(mode)) throw Error('Choose Typed or Voice.');
  return { slug, minutes, mode, startedAt, pausedAt: null, pausedMs: 0, endedAt: null,
    phase: 'clarify', phaseSinceMs: 0, phaseMs: Object.fromEntries(PHASES.map(p => [p, 0])),
    hints: [], turns: 0, lastSpeechAt: startedAt, lastTypingAt: startedAt,
    lastInterjectAt: null, pendingEvents: [], warningGiven: false, debriefed: false,
    lastCode: null, requests: {}, coachProvider: null, coachModel: null, claudeSessionId: null };
}
export function elapsed(state, now = Date.now()) {
  const end = Math.min(state.endedAt ?? now, state.pausedAt ?? Infinity);
  return Math.max(0, end - state.startedAt - state.pausedMs);
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
export function pause(state, now = Date.now()) { state.pausedAt ??= now; }
export function resume(state, now = Date.now()) {
  if (state.pausedAt !== null) { state.pausedMs += now - state.pausedAt; state.pausedAt = null; }
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
