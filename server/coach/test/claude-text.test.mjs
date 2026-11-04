import test from 'node:test';
import assert from 'node:assert/strict';
import { createClaudeTextStream } from '../claude-text.mjs';

const answer = 'Yes, size matters. Each package is small, medium or large.';
function harness(first = answer) {
  const stream = createClaudeTextStream(), output = [];
  const accept = chunks => output.push(...chunks);
  accept(stream.start()); accept(stream.push(0, first)); accept(stream.stop(0));
  stream.tool(); accept(stream.finish()); accept(stream.start());
  return {stream, output, accept, text: () => output.join('')};
}

test('exact tool continuation echo never reaches live tokens, regardless of chunking', () => {
  for (let size = 1; size <= answer.length; size++) {
    const h = harness();
    for (let i = 0; i < answer.length; i += size) {
      assert.deepEqual(h.stream.push(0, answer.slice(i, i + size)), []);
    }
    h.accept(h.stream.stop(0)); h.accept(h.stream.finish());
    assert.equal(h.text(), answer);
  }
});
test('novel suffix is delivered once with identical formatting for every split', () => {
  const suffix = '\n\nWhat should happen when no compartment fits?';
  const reply = answer + suffix;
  for (let i = 0; i <= reply.length; i++) {
    const h = harness();
    h.accept(h.stream.push(0, reply.slice(0, i)));
    h.accept(h.stream.push(0, reply.slice(i)));
    assert.equal(h.text(), reply, 'new text streams before finish');
    h.accept(h.stream.finish()); assert.equal(h.text(), reply);
  }
});
test('shorter and divergent answers are retained, including word extensions', () => {
  for (const reply of ['Yes, size matters.', 'Yes, size does not matter.', 'No, size is out of scope.']) {
    const h = harness();
    for (const c of reply) h.accept(h.stream.push(0, c));
    h.accept(h.stream.finish()); assert.equal(h.text(), answer + '\n\n' + reply);
  }
  const h = harness('Yes'); h.accept(h.stream.push(0, 'Yes')); h.accept(h.stream.push(0, 'terday'));
  assert.equal(h.text(), 'Yes\n\nYesterday');
});
test('same-message repetition and non-tool message repetition are preserved', () => {
  const s = createClaudeTextStream();
  assert.deepEqual(s.start(), []);
  assert.deepEqual(s.push(0, answer + answer), [answer + answer]);
  assert.deepEqual(s.push(1, answer), ['\n\n', answer]);
  s.finish(); s.start();
  assert.deepEqual(s.push(0, answer), ['\n\n', answer]);
});
test('post-tool acknowledgement or correction remains visible after an empty completion', () => {
  for (const reply of ['Recorded.', 'Correction: the reservation also needs an owner.']) {
    const h = harness();
    // A thinking-only completion has message boundaries but no text deltas.
    h.accept(h.stream.finish()); h.accept(h.stream.start());
    h.accept(h.stream.push(0, reply));
    assert.equal(h.text(), answer + '\n\n' + reply, 'new text is delivered immediately');
    h.accept(h.stream.finish());
    assert.equal(h.text(), answer + '\n\n' + reply);
  }
});
test('later tool rounds and empty tool-only messages preserve the last text boundary', () => {
  const h = harness();
  h.accept(h.stream.push(0, answer)); h.accept(h.stream.stop(0)); h.stream.tool();
  h.accept(h.stream.finish()); h.accept(h.stream.start());
  h.stream.tool(); h.accept(h.stream.finish()); h.accept(h.stream.start());
  h.accept(h.stream.push(0, answer + '\n\n')); h.accept(h.stream.finish());
  assert.equal(h.text(), answer, 'empty separators after an echo are not emitted');
});
test('a shorter held prefix is flushed at a text block boundary before a tool', () => {
  const h = harness();
  h.accept(h.stream.push(0, 'Yes, size')); h.accept(h.stream.stop(0)); h.stream.tool();
  assert.equal(h.text(), answer + '\n\nYes, size');
});
