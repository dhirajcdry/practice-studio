#!/usr/bin/env node
// Scripted display fixture, not an AI evaluation. Never calls a model/service.
import { COACH } from './fixture.mjs';
const args = process.argv.slice(2);
const flag = args.includes('--resume') ? '--resume' : '--session-id';
const sessionId = args[args.indexOf(flag) + 1] || 'illustrative-demo';
process.stdin.resume();
process.stdin.on('end', async () => {
  const emit = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);
  emit({ type: 'system', subtype: 'init', session_id: sessionId });
  for (const text of COACH.match(/.{1,32}/gs)) {
    emit({ type: 'stream_event', session_id: sessionId,
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, stop_reason: 'end_turn' });
});
