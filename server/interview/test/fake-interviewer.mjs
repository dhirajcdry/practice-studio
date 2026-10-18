#!/usr/bin/env node
// Only used by scratch-home checks. No network, tools, or real provider process.
import fs from 'node:fs';
const args = process.argv.slice(2);
const session = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : args[args.indexOf('--session-id') + 1] || 'fixture-interview';
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
if (process.env.FAKE_INTERVIEW_PROMPT) fs.appendFileSync(process.env.FAKE_INTERVIEW_PROMPT, JSON.stringify({ args, prompt }) + '\n');
const debrief = prompt.includes('Give a scorecard');
const asked = debrief ? `## Problem solving\nSolid — 00:01: “I will use a map.”\n## Coding\nMixed — No evidence recorded.\n## Communication\nSolid — 00:01: “I will use a map.”\n## Testing & verification\nMixed — No evidence recorded.\n## Hire signal\nLean hire — The approach was clear; implementation evidence is limited.\n## Hints used\n0 hints.\n## Time per phase\nSee the recorded phase durations.\n## Practise next\n1. Explain space complexity.\n2. Trace a duplicate.\n3. Test an empty input.`
  : prompt.includes('State the problem in one or two sentences') ? 'Find two numbers that sum to the target. Read the problem and talk me through your approach. [[phase: approach]]'
    : prompt.includes('A safe interjection is due') ? 'It passed. What is the time complexity? [[phase: followup]]'
      : 'What will you keep in the map? [[phase: code]]';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
emit({ type: 'system', subtype: 'init', session_id: session });
for (const text of asked.match(/.{1,9}|\n/g) || []) {
  emit({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, session_id: session });
  await new Promise(resolve => setTimeout(resolve, 2));
}
emit({ type: 'result', subtype: 'success', is_error: false, session_id: session, result: asked });
