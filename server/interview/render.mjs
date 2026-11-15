import fs from 'node:fs/promises';
import path from 'node:path';
import { InterviewStore } from './store.mjs';
import { clock } from './state.mjs';
import { buildReport, reportMarkdown, reportFacts, timedTurns } from './report.mjs';
import { awayText } from '../mock-clock.mjs';
// Stamps and phase times are attended time (server/mock-clock.mjs); the record is untouched.
export function renderInterview({ state, turns: raw }) {
  const turns = timedTurns(state, raw), facts = reportFacts(state, raw);
  const out = [`# Coding interview · ${state.slug}`, '', `Started: ${new Date(state.startedAt).toISOString()}`, '', '## Transcript', ''];
  if (!turns.some(t => t.said)) out.push('— said nothing —', '');
  const actions = new Map(turns.filter(t => t.kind === 'tool_action').map(t => [t.action.id, t]));
  for (const t of turns) {
    if (t.kind === 'tool_action') {
      if (actions.get(t.action.id) === t) out.push(`### ${clock(t.elapsedMs)} · Agent action`, '', `${t.action.status === 'done' ? 'Applied' : 'Not confirmed'}: ${t.action.summary}`, '', t.action.message || '', '');
      continue;
    }
    if (t.kind === 'coach_run') { out.push(`### ${clock(t.elapsedMs)} · Coach Python run (assistance)`, '', '```json', JSON.stringify(t.result), '```', ''); continue; }
    if (t.kind === 'partial') out.push(`### ${clock(t.elapsedMs)} · ${t.replyKind === 'debrief' ? 'Debrief' : 'Interviewer'} (interrupted)`, '', t.asked || 'No reply text was returned.', '', 'Reply interrupted before it finished.', '');
    else if (t.kind === 'debrief') out.push('## Debrief', '', (state.debriefed && reportMarkdown(buildReport(state, raw))) || t.asked || 'No debrief text was returned.', '');
    else if (t.said || t.asked) out.push(`### ${clock(t.elapsedMs)} · ${t.said ? 'Candidate' : 'Interviewer'}`, '', t.said || t.asked, '');
    else if (t.kind === 'event') out.push(`### ${clock(t.elapsedMs)} · ${t.event.type}`, '', '```json', JSON.stringify(t.event), '```', '');
    else if (t.kind === 'error') out.push(`At ${clock(t.elapsedMs)} the interviewer could not complete the reply.`, '');
  }
  if (!state.debriefed) out.push('No debrief recorded.', '');
  out.push('## Hints used', '', `${facts.hints.length} hints.`, ...facts.hints.map(h => `- ${clock(h.at)}: ${h.level}`), '', '## Time per phase', '',
    ...(facts.away ? [`Attended time: ${awayText(facts.away.ms)} with nothing recorded for over ${Math.round(facts.away.thresholdMs / 60000)} minutes is left out.`, ''] : []),
    ...facts.phases.map(({ phase, ms }) => `- ${phase}: ${clock(ms)}`));
  return out.join('\n') + '\n';
}
export async function writeInterviewDoc({ root, slug, id }) {
  const store = new InterviewStore({ root });
  const state = await store.readState(slug, id);
  if (!state) return null;
  const file = path.join(store.dir(slug, id), 'interview.md');
  await fs.writeFile(file, renderInterview({ state, turns: await store.readTurns(slug, id) }));
  return file;
}
