#!/usr/bin/env node
// A stand-in for `claude` that says exactly what the test told it to say.
//
// The coach's fake picks from a menu of behaviours; this one needs the opposite — the
// interview tests are about *what the model wrote*, so the reply is supplied verbatim
// in STUDIO_FAKE_REPLY. It is emitted one small chunk at a time on purpose: the
// impersonation guard has to work on a stream where a label can be split across two
// tokens, and a fake that emits the whole answer at once would never test that.

import fs from 'node:fs';

const args = process.argv.slice(2);
const reply = process.env.STUDIO_FAKE_REPLY ?? 'Design something.';

const resumeIdx = args.indexOf('--resume');
const sessionIdx = args.indexOf('--session-id');
const sessionId = resumeIdx !== -1 ? args[resumeIdx + 1]
  : sessionIdx !== -1 ? args[sessionIdx + 1]
    : 'fake-session';

const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { prompt += c; });
process.stdin.on('end', () => {
  if (process.env.STUDIO_FAKE_PROMPT_FILE) {
    fs.writeFileSync(process.env.STUDIO_FAKE_PROMPT_FILE, prompt);
  }
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });

  // Four characters at a time, so "USER:" straddles a chunk boundary.
  for (let i = 0; i < reply.length; i += 4) {
    emit({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: reply.slice(i, i + 4) },
      },
      session_id: sessionId,
    });
  }

  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: reply });
  process.exit(0);
});
