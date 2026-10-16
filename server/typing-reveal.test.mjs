import test from 'node:test';
import assert from 'node:assert/strict';
import { bucketFor, revealable, REVEAL_MS, STEP_MS, BUCKETS } from '../web/js/typing-reveal.js';

test('age maps to the delay bucket that resumes the reveal at its true point', () => {
  assert.equal(bucketFor(0), 0);
  assert.equal(bucketFor(STEP_MS - 1), 0);
  assert.equal(bucketFor(STEP_MS), 1);
  assert.equal(bucketFor(REVEAL_MS - 1), BUCKETS - 1);
});

test('a landed or nonsense age has no bucket', () => {
  assert.equal(bucketFor(REVEAL_MS), -1);
  assert.equal(bucketFor(-5), -1);
  assert.equal(bucketFor(NaN), -1);
});

const change = (text, extra = {}) => ({ changes: [{ text, rangeOffset: 0, rangeLength: 0 }], ...extra });

test('a typed character or an auto-closed pair reveals', () => {
  assert.ok(revealable(change('h')));
  assert.ok(revealable(change('()')));
});

test('pastes, newlines, deletes, spaces, undo and restores appear at once', () => {
  assert.equal(revealable(change('hello world')), null);
  assert.equal(revealable(change('\n    ')), null);
  assert.equal(revealable(change('')), null);
  assert.equal(revealable(change(' ')), null);
  assert.equal(revealable(change('a', { isUndoing: true })), null);
  assert.equal(revealable(change('a', { isFlush: true })), null);
  assert.equal(revealable({ changes: [{ text: 'a' }, { text: 'a' }] }), null);
});
