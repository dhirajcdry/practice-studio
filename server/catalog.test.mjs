import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from './paths.mjs';
import { loadSolutionStore } from './solutions.mjs';
import { Catalog, loadCatalog } from './catalog.mjs';

const FIXTURE = new URL('./test/fixtures/collection.json', import.meta.url).pathname;

const store = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);

test('the repo ships no collection: without a workspace file there are only the 250', () => {
  const catalog = loadCatalog(CATALOG_FILE, store);
  assert.equal(catalog.problems.length, 250);
  assert.equal(catalog.collection, null);
  assert.deepEqual(Object.keys(catalog.get('two-sum').lists).sort(), ['blind75', 'neetcode150', 'neetcode250']);
  const missing = loadCatalog(CATALOG_FILE, store, '/nonexistent/collection.json');
  assert.equal(missing.problems.length, 250, 'a missing workspace collection is normal');
});

test('a private collection merges by slug and names itself', () => {
  const catalog = loadCatalog(CATALOG_FILE, store, FIXTURE);
  const prep = catalog.problems.filter((p) => p.lists['sample-collection']);
  assert.equal(prep.length, 5);
  assert.equal(catalog.problems.length, 253);
  assert.equal(prep.filter((p) => p.lists.neetcode250).length, 2);
  assert.equal(catalog.neetcode250.length, 250);
  assert.equal(new Set(catalog.problems.map((p) => p.slug)).size, 253);
  assert.deepEqual(catalog.collection, { id: 'sample-collection', label: 'Sample collection', note: catalog.collection.note, checkedAt: '2026-01-01' });
});

test('collection entries retain curated metadata and existing bundle metadata', () => {
  const catalog = loadCatalog(CATALOG_FILE, store, FIXTURE);
  const overlay = catalog.get('word-search-ii');
  assert.equal(overlay.number, 212);
  assert.equal(overlay.lists.neetcode250, true);
  assert.deepEqual(overlay.tags, ['sample-collection']);
  assert.equal(overlay.interviewPrep.id, 'S01');
  const synthesized = catalog.get('parallel-courses-ii');
  assert.ok(synthesized);
  assert.equal(synthesized.neetcodeSlug, null);
  assert.equal(synthesized.solutionCodeStem, null);
  assert.deepEqual(synthesized.tags, ['sample-collection']);
  assert.equal(synthesized.lists.neetcode250, false);
  assert.equal(catalog.get('first-unique-number').leetcodePremium, true);
  const personal = catalog.get('game-of-life');
  assert.equal(personal.number, 289);
  assert.equal(personal.lists.neetcode250, false);
  assert.equal(personal.interviewPrep.origin, 'personal');
  assert.equal(personal.interviewPrep.sources[0].url, 'https://leetcode.com/problems/game-of-life/description/');
});


test('imported records retain You or Others and legacy records default to You', () => {
  const records = [
    { leetcodeSlug: 'manual-fixture', title: 'Manual fixture', lists: { added: true } },
    { leetcodeSlug: 'shuffle-fixture', title: 'Shuffle fixture', lists: { others: true } },
    { leetcodeSlug: 'legacy-fixture', title: 'Legacy fixture' },
  ];
  const original = JSON.stringify(records);
  const catalog = new Catalog({ problems: [] }, store, null, records);
  for (const [slug, list] of [['manual-fixture', 'added'], ['shuffle-fixture', 'others'], ['legacy-fixture', 'added']]) {
    const entry = catalog.get(slug);
    assert.equal(entry.lists[list], true);
    assert.equal(entry.lists[list === 'added' ? 'others' : 'added'], undefined);
    assert.equal(catalog.add({ leetcodeSlug: slug, title: 'Replacement', lists: { others: true } }, store), entry);
  }
  assert.equal(catalog.problems.length, 3);
  assert.equal(JSON.stringify(records), original, 'loading does not rewrite saved source records');
  assert.equal(catalog.add({ leetcodeSlug: 'legacy-direct', title: 'Legacy direct', lists: {} }, store).lists.added, true);
});
