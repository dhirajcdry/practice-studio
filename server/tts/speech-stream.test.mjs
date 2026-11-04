import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechStream } from '../../web/js/speech-stream.js';

function harness(options = {}) {
  const spoken = [], timers = new Map(); let id = 0, cancelled = 0;
  const stream = createSpeechStream({ say: text => spoken.push(text), cancel: () => cancelled++ }, {
    setTimer: fn => { timers.set(++id, fn); return id; }, clearTimer: key => timers.delete(key), ...options,
  });
  return { stream, spoken, timers, get cancelled() { return cancelled; }, tick() {
    const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(fn => fn());
  } };
}

test('Markdown closing punctuation starts speech before completion', () => {
  const h = harness();
  h.stream.push('**Here is the direct answer.** ');
  assert.deepEqual(h.spoken, ['Here is the direct answer.']);
  h.stream.push('Then ask "Why this choice?" ');
  assert.deepEqual(h.spoken, ['Here is the direct answer.', 'Then ask "Why this choice?"']);
  h.stream.finish(); h.stream.finish();
  assert.equal(h.spoken.length, 2);
});

test('character streamed fences and links never leak syntax or code', () => {
  const h = harness();
  const source = 'First useful sentence. ```js\nsecret.code();\n``` Then read [this explanation](https://example.test/a(b)). Last words';
  for (const c of source) { h.stream.push(c); h.tick(); }
  h.stream.finish();
  assert.equal(h.spoken.join(' '), 'First useful sentence. Then read this explanation. Last words');
});

test('long prose starts in bounded chunks and preserves every word', () => {
  const h = harness(); const text = Array.from({ length: 180 }, (_, i) => `word${i}`).join(' ');
  h.stream.push(text);
  assert.ok(h.spoken.length > 0);
  h.stream.finish();
  assert.equal(h.spoken.join(' '), text);
  assert.ok(h.spoken.every(text => text.length <= 500));
});

test('latency timer does not reset on tokens and keeps incomplete words', () => {
  const h = harness();
  h.stream.push('Here are five useful opening words ');
  const timer = [...h.timers.keys()][0];
  h.stream.push('incom');
  assert.equal([...h.timers.keys()][0], timer);
  h.tick(); assert.deepEqual(h.spoken, ['Here are five useful opening words']);
  h.stream.push('plete ending'); h.stream.finish();
  assert.equal(h.spoken.join(' '), 'Here are five useful opening words incomplete ending');
});

test('cancel discards timed and future text; incomplete Markdown is withheld', () => {
  const h = harness(); h.stream.push('**These are five words still inside'); h.tick();
  assert.deepEqual(h.spoken, []);
  h.stream.cancel(); h.tick(); h.stream.push('** '); h.stream.finish();
  assert.deepEqual(h.spoken, []); assert.equal(h.cancelled, 1);
});
