// Presentation only: these helpers never change the interview's raw record.
export function elapsedInterview(record, now = Date.now()) {
  if (!Number.isFinite(record.startedAt)) return 0;
  return Math.max(0, Math.min(record.endedAt ?? now, record.pausedAt ?? Infinity) - record.startedAt - (record.pausedMs || 0));
}
export function interviewDuration(record, now = Date.now()) {
  const ms = elapsedInterview(record, now);
  return !Number.isFinite(record.startedAt) ? 'Not started' : ms < 60000 ? 'Less than a minute' : `${Math.floor(ms / 60000)} min`;
}
export function relativeInterviewDate(value, now = Date.now()) {
  if (!value || !Number.isFinite(new Date(value).getTime())) return 'Starting…';
  const date = new Date(value), today = new Date(now), yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = other => date.toDateString() === other.toDateString();
  if (sameDay(today)) return `Today, ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  if (sameDay(yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}
export function ratingTone(value = '') {
  return /^(strong|solid|.*hire$)/i.test(value) && !/no hire/i.test(value) ? 'success'
    : /^(mixed|lean no)/i.test(value) ? 'warn' : /^(weak|no hire)/i.test(value) ? 'danger' : 'neutral';
}
export const REPORT_DIFFICULTIES = [
  { id: 'beginner', label: 'Beginner' },
  { id: 'amazon-sde-2', label: 'Amazon SDE II' },
];
/** The name of a saved report's difficulty; '' for an older report that has none. */
export function reportDifficultyLabel(difficulty) {
  return REPORT_DIFFICULTIES.find(option => option.id === difficulty)?.label || '';
}
/** A signal as display text. Display only: tone and logic stay on the raw signal. */
export function signalLabel(signal, difficulty) {
  return signal && difficulty === 'beginner' ? `${signal} (Beginner)` : signal;
}
export function interviewOutcome(record) {
  if (record.completionReason === 'no-response') return { label: 'No response', tone: 'neutral' };
  if (record.debriefed) return { label: signalLabel(record.hireSignal, record.reportDifficulty) || 'Completed', tone: ratingTone(record.hireSignal) };
  if (record.endedAt || record.needsAttention) return { label: 'Needs feedback', tone: 'warn' };
  if (record.pausedAt || record.status === 'paused') return { label: 'Paused', tone: 'neutral' };
  return { label: 'In progress', tone: 'accent' };
}
export function debriefSections(text) {
  const sections = [];
  let current = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^#{1,4}\s+(.+?)\s*#*$/);
    if (heading) { current = { heading: heading[1], text: '' }; sections.push(current); }
    else if (current) current.text += `${line}\n`;
    else if (line.trim()) { current = { heading: '', text: `${line}\n` }; sections.push(current); }
  }
  return sections.map(section => ({ ...section, text: section.text.trim() }));
}
export function recordedPhaseTimes(state, now = Date.now()) {
  if (!state.phaseMs) return [];
  const values = { ...state.phaseMs };
  if (state.phase in values) values[state.phase] += Math.max(0, elapsedInterview(state, now) - (state.phaseSinceMs || 0));
  return Object.entries(values).map(([phase, ms]) => ({ phase, ms: Math.max(0, ms) }));
}
// "claude"/"default" → "Claude Code"; "codex"/"gpt-6-astra" → "GPT-6 Astra".
export function modelLabel(provider, model) {
  if (!provider) return '';
  if (provider === 'claude') return !model || model === 'default' ? 'Claude Code' : `Claude ${model[0].toUpperCase()}${model.slice(1)}`;
  if (!model) return 'Codex';
  return model.replace(/^gpt/i, 'GPT').replace(/-([a-z])([a-z]*)$/i, (_, a, b) => ` ${a.toUpperCase()}${b}`);
}
