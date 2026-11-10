import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpeechStream } from '../../web/js/speech-stream.js';

function harness(options = {}) {
  const spoken = []; let cancelled = 0;
  const stream = createSpeechStream({ say: text => spoken.push(text), cancel: () => cancelled++ }, options);
  return { stream, spoken, get cancelled() { return cancelled; } };
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
  for (const c of source) h.stream.push(c);
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

test('a pause in generation never splits an ordinary sentence after ten words', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  h.stream.push('The available balance excludes active holds but includes holds that ');
  t.mock.timers.tick(5000);
  assert.deepEqual(h.spoken, []);
  h.stream.push('expired at least fifteen minutes ago. ');
  assert.deepEqual(h.spoken, ['The available balance excludes active holds but includes holds that expired at least fifteen minutes ago.']);
  h.stream.push('The next answer is still incom');
  t.mock.timers.tick(5000);
  assert.equal(h.spoken.length, 1, 'the completed sentence starts while the reply is still being generated');
  h.stream.push('plete'); h.stream.finish();
  assert.equal(h.spoken[1], 'The next answer is still incomplete');
});

test('a two-word opener joins the next sentence instead of starting a tiny clip', () => {
  const h = harness();
  h.stream.push('Good question. ');
  assert.deepEqual(h.spoken, []);
  h.stream.push('Let us consider two callers reserving the same room. ');
  assert.deepEqual(h.spoken, ['Good question. Let us consider two callers reserving the same room.']);
  h.stream.finish();
  assert.equal(h.spoken.length, 1);
});

test('a short standalone reply speaks exactly once on completion', () => {
  const h = harness();
  h.stream.push('Why? ');
  assert.deepEqual(h.spoken, []);
  h.stream.finish(); h.stream.finish();
  assert.deepEqual(h.spoken, ['Why?']);
  const completed = harness();
  completed.stream.push('Go ahead.'); completed.stream.finish();
  assert.deepEqual(completed.spoken, ['Go ahead.']);
});

test('a short opener waits for its arriving continuation without dropping words', () => {
  const h = harness();
  h.stream.push('Good question. Let us ');
  assert.deepEqual(h.spoken, []);
  h.stream.push('consider what happens when two callers reserve ');
  assert.deepEqual(h.spoken, []);
  h.stream.push('the same room.'); h.stream.finish();
  assert.deepEqual(h.spoken, ['Good question. Let us consider what happens when two callers reserve the same room.']);
  const unpunctuated = harness();
  unpunctuated.stream.push('Good question. Let us check that'); unpunctuated.stream.finish();
  assert.deepEqual(unpunctuated.spoken, ['Good question. Let us check that']);
});

test('interrupt cancels a held short opener before any audio starts', () => {
  const h = harness(); h.stream.push('Good question. ');
  h.stream.cancel(); h.stream.finish();
  assert.deepEqual(h.spoken, []);
});

test('an unfinished next word or Markdown continuation does not release the tiny opener', () => {
  for (const [begin,end] of [
    ['Good question. Le','t us check the balance. '],
    ['Good question. **Let us check',' the balance.** '],
  ]) {
    const h = harness(); h.stream.push(begin);
    assert.deepEqual(h.spoken, [], 'an arriving continuation is not a standalone short reply');
    h.stream.push(end); h.stream.finish();
    assert.deepEqual(h.spoken, ['Good question. Let us check the balance.']);
  }
});

test('long sentences prefer a substantial clause boundary and preserve every word', () => {
  const h = harness({ maxChars: 100 });
  const clause = 'The balance includes the available funds after pending holds expire,';
  const text = clause + ' and every later read should evaluate expiration against the current time before returning the result.';
  for (const word of text.split(' ')) h.stream.push(word + ' ');
  h.stream.finish();
  assert.equal(h.spoken[0], clause);
  assert.equal(h.spoken.join(' '), text);
  assert.ok(h.spoken.every(text => text.length <= 100));
});

test('cancel discards buffered and future text; incomplete Markdown is withheld', () => {
  const h = harness(); h.stream.push('**These are five words still inside');
  assert.deepEqual(h.spoken, []);
  h.stream.cancel(); h.stream.push('** '); h.stream.finish();
  assert.deepEqual(h.spoken, []); assert.equal(h.cancelled, 1);
});
