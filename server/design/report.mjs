// Adapter for existing design records. No raw history migration; phase durations are
// counted from the turns' own pause-adjusted elapsedMs, and anything without one stays
// unknown rather than being reconstructed from wall-clock times.
import { parseReport, DESIGN_DIMENSIONS } from '../interview/report.mjs';
import { PHASE_IDS } from './interview.mjs';

const REPLIES = new Set(['opening', 'turn', 'interviewer_silent', 'suppressed_filler']);

/**
 * Time spent in each phase, from the raw turns. A candidate turn carries the phase they
 * answered in, so the time leading up to it is theirs in that phase; an interviewer turn
 * carries the phase after its reply, so the time until the next turn is spent in it.
 * Time the record cannot place (no phase on either side, or after the last turn, which
 * would include the debrief's own writing time) is left out, never assigned to a guess.
 * Returns [] when no turn was timed at all, otherwise every phase, with `ms: null` for a
 * phase that has no recorded time.
 */
export function designPhaseTimes(turns = []) {
  const points = turns
    .filter(t => t && (t.kind === 'candidate' || REPLIES.has(t.kind) || t.kind === 'tool_action') && Number.isFinite(t.elapsedMs) && t.elapsedMs >= 0)
    .map(t => ({ ms: t.elapsedMs, candidate: t.kind === 'candidate', phase: PHASE_IDS.includes(t.phase) ? t.phase : null }));
  if (!points.length) return [];
  const totals = new Map();
  let previous = { ms: 0, candidate: false, phase: null };
  for (const point of points) {
    const span = point.ms - previous.ms;
    const phase = point.candidate && point.phase ? point.phase : previous.phase;
    if (span > 0 && phase) totals.set(phase, (totals.get(phase) || 0) + span);
    // A tool action names no phase; the phase in force carries on through it.
    previous = { ...point, phase: point.phase ?? previous.phase };
  }
  return PHASE_IDS.map(phase => ({ phase, ms: totals.has(phase) ? totals.get(phase) : null }));
}

export function buildDesignReport(state, turns) {
  const debrief = [...turns].reverse().find(t => t.kind === 'debrief');
  if (!state.debriefed || !debrief) return null;
  const durationMs = Math.max(0, state.pausedAt ? state.spentMs || 0 : (state.endedAt || state.startedAt) - state.startedAt);
  const count = text => String(text || '').match(/\S+/g)?.length || 0;
  const candidateWords = turns.reduce((n, t) => n + count(t.said), 0);
  const interviewerWords = turns.filter(t => t.kind !== 'debrief').reduce((n, t) => n + count(t.asked), 0);
  return { facts: { durationMs, plannedMs: (state.minutes || 45) * 60000, mode: state.mode || 'unknown', phases: designPhaseTimes(turns), hints: [], runs: [], verdicts: [], candidateWords, interviewerWords, candidateTurns: turns.filter(t => t.said?.trim()).length, talkShare: candidateWords + interviewerWords ? candidateWords / (candidateWords + interviewerWords) : null, finalCode: null, finalBoard: state.graph && (state.graph.nodes?.length || state.graph.notes?.length || state.graph.edges?.length || state.graph.unattached) ? state.graph : null }, judgement: parseReport(debrief.asked, turns, { dimensions: DESIGN_DIMENSIONS, durationMs }), ...(state.reportDifficulty ? { difficulty: state.reportDifficulty } : {}) };
}
