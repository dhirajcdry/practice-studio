import fs from 'node:fs/promises';
import path from 'node:path';
import { InterviewStore } from './store.mjs';
import { clock, phaseTimes } from './state.mjs';
export function renderInterview({ state, turns }) {
  const out = [`# Coding interview · ${state.slug}`, '', `Started: ${new Date(state.startedAt).toISOString()}`, '', '## Transcript', ''];
  if (!turns.some(t => t.said)) out.push('— said nothing —', '');
  for (const t of turns) {
    if (t.kind === 'debrief') out.push('## Debrief', '', t.asked || 'No debrief text was returned.', '');
    else if (t.said || t.asked) out.push(`### ${clock(t.elapsedMs)} · ${t.said ? 'Candidate' : 'Interviewer'}`, '', t.said || t.asked, '');
    else if (t.kind === 'event') out.push(`### ${clock(t.elapsedMs)} · ${t.event.type}`, '', '```json', JSON.stringify(t.event), '```', '');
    else if (t.kind === 'error') out.push(`At ${clock(t.elapsedMs)} the interviewer could not complete the reply.`, '');
  }
  if (!state.debriefed) out.push('No debrief recorded.', '');
  out.push('## Hints used', '', `${state.hints.length} hints.`, ...state.hints.map(h => `- ${clock(h.elapsedMs)}: ${h.level}`), '', '## Time per phase', '', ...Object.entries(phaseTimes(state)).map(([p, ms]) => `- ${p}: ${clock(ms)}`));
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
