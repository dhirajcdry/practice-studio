// Adapter for existing design records. No raw history migration; unknown phase
// durations stay unknown rather than being reconstructed from shifted resume clocks.
import { parseReport, DESIGN_DIMENSIONS } from '../interview/report.mjs';
export function buildDesignReport(state, turns) {
  const debrief = [...turns].reverse().find(t => t.kind === 'debrief');
  if (!state.debriefed || !debrief) return null;
  const durationMs = Math.max(0, state.pausedAt ? state.spentMs || 0 : (state.endedAt || state.startedAt) - state.startedAt);
  const count = text => String(text || '').match(/\S+/g)?.length || 0;
  const candidateWords = turns.reduce((n, t) => n + count(t.said), 0);
  const interviewerWords = turns.filter(t => t.kind !== 'debrief').reduce((n, t) => n + count(t.asked), 0);
  return { facts: { durationMs, plannedMs: (state.minutes || 45) * 60000, mode: state.mode || 'unknown', phases: [], hints: [], runs: [], verdicts: [], candidateWords, interviewerWords, candidateTurns: turns.filter(t => t.said?.trim()).length, talkShare: candidateWords + interviewerWords ? candidateWords / (candidateWords + interviewerWords) : null, finalCode: null, finalBoard: state.graph && (state.graph.nodes?.length || state.graph.notes?.length || state.graph.edges?.length || state.graph.unattached) ? state.graph : null }, judgement: parseReport(debrief.asked, turns, { dimensions: DESIGN_DIMENSIONS, durationMs }), ...(state.reportDifficulty ? { difficulty: state.reportDifficulty } : {}) };
}
