#!/usr/bin/env node
// Only used by scratch-home checks. No network, tools, or real provider process.
import fs from 'node:fs';
import { fixtureReport } from './report-fixture.mjs';
const args = process.argv.slice(2);
const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] || 'fixture-interview';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_INTERVIEW_PROMPT) fs.appendFileSync(process.env.FAKE_INTERVIEW_PROMPT, JSON.stringify({ args, prompt }) + '\n');
const debrief = prompt.includes("Write the candidate's report");
const review = (prompt + args.join('\n')).includes('going over it with the candidate afterwards');
const selection = prompt.includes('INTERVIEW_PROBLEM_SELECTION');
const selected = {
  title: 'Museum ticket reservations', family: 'museum-ticket-reservations',
  statement: 'Design a museum ticket reservation system.',
  facts: 'Timed visits have finite capacity. Reservations may be cancelled by their owner. Reject invalid intervals and overbooking before mutation. Python in-memory implementation.',
  curveball: 'Two customers reserve the last place at the same time.',
  rationale: 'Practise state ownership and validation at the requested target level; use recorded evidence where available.',
};
const asked = selection ? JSON.stringify(selected)
  : debrief ? (process.env.FAKE_INTERVIEW_LEGACY_DEBRIEF ? '## Hire signal\nLean hire — The approach was clear.' : fixtureReport())
  : review ? 'Try these cases:\n\n- `[3,3], 6` → `[0,1]`: a repeated value.\n- `[-1,-2], -3` → `[0,1]`: negatives.\n\nAt 5:40 the failing run was the moment to ask.'
  : prompt.includes('The problem for this interview is:') ? (prompt.match(/The problem for this interview is: ([^\n]+)/)?.[1] || 'Design a museum ticket reservation system.')
  : prompt.includes('State the problem in one or two sentences') ? 'Find two numbers that sum to the target. Read the problem and talk me through your approach. [[phase: approach]]'
    : prompt.includes('A safe interjection is due') ? 'It passed. What is the time complexity? [[phase: followup]]'
      : 'What will you keep in the map? [[phase: code]]';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'system', subtype: 'init', session_id: session });
for (const text of asked.match(/.{1,9}|\n/g) || []) {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: session });
  await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_INTERVIEW_TOKEN_MS) || 2));
}
emit({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: asked });
