import test from 'node:test';
import assert from 'node:assert/strict';
import { randomProblem } from '../web/js/shuffle.js';

const list = ['a', 'b', 'c'].map(slug => ({ slug }));

test('randomProblem picks across the whole list', () => {
  assert.equal(randomProblem(list, null, () => 0).slug, 'a');
  assert.equal(randomProblem(list, null, () => 0.999).slug, 'c');
});

test('randomProblem never returns the open problem', () => {
  for (const r of [0, 0.4, 0.6, 0.999]) assert.notEqual(randomProblem(list, 'b', () => r).slug, 'b');
});

test('randomProblem returns null when nothing else is left', () => {
  assert.equal(randomProblem([], null), null);
  assert.equal(randomProblem([{ slug: 'a' }], 'a'), null);
});

import { createLeetCodeShuffle } from '../web/js/shuffle.js';

test('LeetCode shuffle ignores overlapping clicks and imports exactly once into Others', async () => {
  let release, reads = 0;
  const calls = [], busy = [];
  const shuffle = createLeetCodeShuffle({
    random: () => { reads++; return new Promise(resolve => { release = resolve; }); },
    importProblem: async input => { calls.push(input); return { slug: input.slug, existing: true }; },
    onOpen: saved => calls.push(saved), onBusy: value => busy.push(value),
  });
  const first = shuffle.run();
  assert.equal(shuffle.busy, true);
  await shuffle.run(); assert.equal(reads, 1);
  release({ ok: true, slug: 'sample-problem', paidOnly: false }); await first;
  assert.deepEqual(calls, [{ slug: 'sample-problem', source: 'others' }, { slug: 'sample-problem', existing: true }]);
  assert.deepEqual(busy, [true, false]); assert.equal(shuffle.busy, false);
});

test('LeetCode shuffle surfaces errors, validates responses and unlocks without retry', async () => {
  for (const result of [null, { ok: false, message: 'Connector message' }, { ok: true, slug: '../bad', paidOnly: false },
    { ok: true, slug: 'valid', paidOnly: true }, { ok: true, slug: 'valid' }]) {
    let reads = 0;
    const shuffle = createLeetCodeShuffle({ random: async () => { reads++; return result; },
      importProblem: () => assert.fail('Must not import'), onOpen: () => assert.fail('Must not open') });
    await assert.rejects(shuffle.run(), result?.message ? { message: result.message } : undefined);
    assert.equal(shuffle.busy, false); assert.equal(reads, 1);
  }
});

test('import failures do not open, retry or leave shuffle busy', async () => {
  let imports = 0;
  const shuffle = createLeetCodeShuffle({ random: async () => ({ ok: true, slug: 'valid', paidOnly: false }),
    importProblem: async () => { imports++; throw Error('Import failed'); }, onOpen: () => assert.fail('Must not open') });
  await assert.rejects(shuffle.run(), /Import failed/);
  assert.equal(imports, 1); assert.equal(shuffle.busy, false);
});
