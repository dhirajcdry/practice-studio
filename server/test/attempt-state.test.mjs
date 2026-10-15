import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeDecision, STALE_ATTEMPT_MS } from '../../web/js/attempt-state.js';
import { createSeenRuns, SEEN_RUNS_KEY } from '../../web/js/seen-runs.js';

const attempt = { attemptId: 'same-id', slug: 'two-sum', title: 'Two Sum', startedAt: 1000, savedMs: 500 };
test('resume retains the original identity up to six hours, then closes stale work', () => {
  assert.equal(resumeDecision(attempt, 2000), 'resume');
  assert.equal(resumeDecision(attempt, 1000 + STALE_ATTEMPT_MS), 'resume');
  assert.equal(resumeDecision(attempt, 1001 + STALE_ATTEMPT_MS), 'stale');
  assert.equal(attempt.attemptId, 'same-id');
});
test('malformed and future attempts cannot reopen a microphone', () => {
  for (const value of [null, {}, { ...attempt, startedAt: '1000' }, { ...attempt, savedMs: -1 }, { ...attempt, slug: '' }]) {
    assert.equal(resumeDecision(value, 2000), 'invalid');
  }
  assert.equal(resumeDecision(attempt, 999), 'invalid');
});
test('seen runs survive reload, deduplicate, and retain the newest 100 ids', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const seen = createSeenRuns(storage);
  for (let n = 0; n < 110; n++) seen.remember(String(n));
  seen.remember('10');
  const restored = createSeenRuns(storage);
  assert.equal(restored.has('9'), false);
  assert.equal(restored.has('10'), true);
  assert.equal(restored.has('109'), true);
  assert.equal(JSON.parse(values.get(SEEN_RUNS_KEY)).length, 100);
  assert.equal(JSON.parse(values.get(SEEN_RUNS_KEY)).at(-1), '10');
});
test('seen runs tolerate denied storage and corrupt persisted values', () => {
  const seen = createSeenRuns({ getItem() { throw Error('denied'); }, setItem() { throw Error('denied'); } });
  seen.remember('read');
  assert.equal(seen.has('read'), true);
  assert.equal(createSeenRuns({ getItem: () => '{}' }).has('read'), false);
});
