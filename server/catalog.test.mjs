import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from './paths.mjs';
import { loadSolutionStore } from './solutions.mjs';
import { loadCatalog } from './catalog.mjs';

const store = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);

test('shipped Amazon overlay merges 18 records with six NC250 overlaps', () => {
  const catalog = loadCatalog(CATALOG_FILE, store);
  const prep = catalog.problems.filter((p) => p.lists['amazon-interview']);
  assert.equal(prep.length, 18);
  assert.equal(catalog.problems.length, 262);
  assert.equal(prep.filter((p) => p.lists.neetcode250).length, 6);
  assert.equal(catalog.neetcode250.length, 250);
  assert.equal(new Set(catalog.problems.map((p) => p.slug)).size, 262);
});

test('Amazon entries retain curated metadata and existing bundle metadata', () => {
  const catalog = loadCatalog(CATALOG_FILE, store);
  const overlay = catalog.get('word-search-ii');
  assert.equal(overlay.number, 212);
  assert.equal(overlay.lists.neetcode250, true);
  assert.deepEqual(overlay.tags, ['amazon-interview']);
  assert.equal(overlay.interviewPrep.id, 'PS04');
  const synthesized = catalog.get('parallel-courses-ii');
  assert.ok(synthesized);
  assert.equal(synthesized.neetcodeSlug, null);
  assert.equal(synthesized.solutionCodeStem, null);
  assert.deepEqual(synthesized.tags, ['amazon-interview']);
  assert.equal(synthesized.lists.neetcode250, false);
  assert.equal(catalog.get('first-unique-number').leetcodePremium, true);
  const personal = catalog.get('game-of-life');
  assert.equal(personal.number, 289);
  assert.equal(personal.lists.neetcode250, false);
  assert.equal(personal.interviewPrep.origin, 'personal');
  assert.equal(personal.interviewPrep.sources[0].url, 'https://leetcode.com/problems/game-of-life/description/');
});
