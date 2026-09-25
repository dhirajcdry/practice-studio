// One interview, one file.
//
// Same discipline as the attempt assembler: everything here is recomputed from
// turns.jsonl, scenes/ and interview.json, so a bug costs a regeneration and never a
// recording. And it never invents — a turn with no answer is printed as unanswered
// rather than left as a gap that reads like agreement.
//
// What makes this worth reading later is the pairing. A transcript of questions alone
// is unusable, and a final screenshot alone hides the order things arrived in. Here the
// drawing is shown at the point it changed, next to the question that followed it, so
// the file answers the question you actually have a week later: what was on the board
// when they asked me that?

import fsp from 'node:fs/promises';
import path from 'node:path';

import { DesignStore } from './store.mjs';
import { sceneToGraph, renderGraph, diffGraphs, describeDiff } from './graph.mjs';
import { PHASES } from './interview.mjs';

const labelOf = (id) => PHASES.find((p) => p.id === id)?.label ?? id;

function clock(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.round(ms / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

/** Gather the raw stores. Nothing here modifies them. */
export async function gatherInterview({ root, id }) {
  const store = new DesignStore({ root });
  const state = await store.readState(id);
  if (!state) return null;
  return { id, state, turns: await store.readTurns(id), scenes: await store.readScenes(id) };
}

export function renderInterview(interview) {
  const { id, state, turns, scenes } = interview;
  const startMs = state.startedAt ?? (turns[0]?.at ? Date.parse(turns[0].at) : null);
  const at = (iso) => (startMs && iso ? clock(Date.parse(iso) - startMs) : '--:--');

  const asked = turns.filter((t) => t.kind === 'turn' || t.kind === 'opening');
  const answered = turns.filter((t) => t.kind === 'turn' && String(t.said ?? '').trim());
  const debrief = turns.find((t) => t.kind === 'debrief');

  const spokenByThem = turns.reduce((n, t) => n + words(t.asked), 0);
  const spokenByMe = turns.reduce((n, t) => n + words(t.said), 0);
  const share = spokenByThem + spokenByMe === 0 ? 0 : spokenByThem / (spokenByThem + spokenByMe);

  const out = [];
  const title = state.prompt ? state.prompt.replace(/\s+/g, ' ').trim() : 'System design interview';
  out.push(`# ${title}`, '');
  out.push(`- **When** ${startMs ? new Date(startMs).toLocaleString() : 'unknown'}`);
  out.push(`- **Bar** ${state.level}`);
  if (state.endedAt && startMs) {
    out.push(`- **Took** ${Math.round((state.endedAt - startMs) / 60000)} minutes of ${state.minutes}`);
  }
  out.push(`- **Questions** ${asked.length}, of which ${answered.length} got an answer`);
  out.push(`- **Talk share** the interviewer spoke ${Math.round(share * 100)}% of the words (target 20%)`);
  const reached = [...new Set([...(state.visited ?? []), state.phase])];
  out.push(`- **Reached** ${reached.map(labelOf).join(' → ')}`);
  const missed = PHASES.map((p) => p.id).filter((p) => !reached.includes(p));
  if (missed.length) out.push(`- **Never reached** ${missed.map(labelOf).join(', ')}`);
  out.push(`- **Curveball** ${state.curveballDone ? 'dropped' : 'never dropped'}`);
  if (!debrief) out.push('', '> This interview has no debrief — it was closed before the end.');

  // The board, as it changed. Only the changes, because a snapshot per pointer-up would
  // be hundreds of identical diagrams.
  const stages = [];
  let previous = null;
  for (const scene of scenes) {
    const graph = sceneToGraph(scene.elements);
    const diff = previous ? diffGraphs(previous, graph) : { changed: true };
    if (diff.changed) {
      stages.push({ at: scene.at, graph, change: previous ? describeDiff(diff, graph) : null });
      previous = graph;
    }
  }

  out.push('', '## How it went', '');
  const events = [
    ...turns.filter((t) => t.kind !== 'debrief').map((t) => ({ kind: 'turn', at: t.at, turn: t })),
    ...stages.map((s) => ({ kind: 'draw', at: s.at, stage: s })),
  ].sort((a, b) => Date.parse(a.at ?? 0) - Date.parse(b.at ?? 0));

  for (const event of events) {
    if (event.kind === 'draw') {
      out.push(`### \`${at(event.at)}\`  ·  the board`, '');
      if (event.stage.change) out.push(`*${event.stage.change}*`, '');
      out.push('```', renderGraph(event.stage.graph), '```', '');
      continue;
    }
    const t = event.turn;
    out.push(`### \`${at(t.at)}\`  ·  ${labelOf(t.phase ?? state.phase)}`, '');
    out.push(`**Q** ${String(t.asked ?? '').trim() || '*(the turn was cut — see below)*'}`, '');
    const said = String(t.said ?? '').trim();
    // A silence is printed as a silence. Leaving it blank would read, a week later, as
    // if the question had simply not been asked.
    out.push(said ? `**A** ${said}` : '**A** *— said nothing —*', '');
  }

  if (debrief) {
    out.push('', '## The debrief', '', String(debrief.asked ?? '').trim() || '*(empty)*', '');
  }

  if (scenes.length) {
    const finalGraph = sceneToGraph(scenes[scenes.length - 1].elements);
    out.push('', '## The board at the end', '', '```', renderGraph(finalGraph), '```');
  }

  return `${out.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/** Write the derived file. Safe to call repeatedly; it only ever overwrites itself. */
export async function writeInterviewDoc({ root, id }) {
  const interview = await gatherInterview({ root, id });
  if (!interview) return null;
  const file = path.join(root, 'design', id, 'interview.md');
  await fsp.writeFile(file, renderInterview(interview), 'utf8');
  return file;
}
