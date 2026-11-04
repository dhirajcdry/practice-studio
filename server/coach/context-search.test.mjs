import test from 'node:test';
import assert from 'node:assert/strict';
import { createEvidenceIndex } from './context-search.mjs';

test('search ranks relevant old evidence, isolates discipline, and retrieves exact source', () => {
  const index = createEvidenceIndex({ discipline: 'lld', slug: 'locker', records: [
    { sourceId: 'old', discipline: 'lld', text: 'The invariant fails when ownership transitions are unclear.' },
    { sourceId: 'new', discipline: 'lld', text: 'Unrelated presentation feedback.' },
    { sourceId: 'foreign', discipline: 'coding', text: 'ownership state invariant' },
  ], notes: [{ sourceId: 'note', scope: 'problem', text: 'Correction: state ownership belongs to Locker.' }] });
  const result = index.search({ query: 'ownership state invariant', limit: 8 });
  assert.equal(result.results[0].sourceId, 'old');
  assert.ok(!result.results.some(x => x.sourceId === 'foreign'));
  assert.equal(index.read(result.results.find(x => x.sourceId === 'old').resource), 'The invariant fails when ownership transitions are unclear.');
});

test('hash resources are stable, corrections remain separate, and summaries are bounded', () => {
  const input = { discipline: 'design', slug: 'x', records: [
    { sourceId: 'a', text: 'Correction: capacity is six.' }, { sourceId: 'b', text: 'Earlier capacity was five.' },
  ]};
  const a = createEvidenceIndex(input), b = createEvidenceIndex(input);
  const ar = a.search({ query: 'capacity', limit: 8 }).results;
  assert.deepEqual(ar.map(x => x.resource), b.search({ query: 'capacity', limit: 8 }).results.map(x => x.resource));
  assert.equal(ar.length, 2);
  assert.ok(JSON.stringify(a.search({ query: 'capacity', limit: 8 })).length <= 5000);
});
