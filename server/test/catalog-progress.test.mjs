import test from 'node:test';
import assert from 'node:assert/strict';

import { progressFor, summarizeProgress, loadCatalogProgress } from '../../web/js/catalog-progress.js';

const catalog = [{ slug: 'a' }, { slug: 'b' }, { slug: 'c' }, { slug: 'd' }, { slug: 'e' }];

test('summarizeProgress keeps accepted, local pass, attempted, and untouched separate', () => {
  const map = new Map([
    ['a', { status: 'accepted' }], ['b', { status: 'local-pass' }],
    ['c', { status: 'attempted' }], ['d', { status: 'notes-only' }], ['e', { status: 'empty' }],
  ]);
  assert.deepEqual(summarizeProgress(catalog, map), { accepted: 1, localPass: 1, attempted: 1, total: 5, touched: 3 });
});

test('summarizeProgress counts only the catalog subset', () => {
  const map = new Map([['outside', { status: 'accepted' }], ['a', { status: 'accepted' }]]);
  assert.deepEqual(summarizeProgress([{ slug: 'a' }, { slug: 'missing' }], map), { accepted: 1, localPass: 0, attempted: 0, total: 2, touched: 1 });
});

test('progressFor distinguishes unavailable data from an absent record', () => {
  const map = new Map([['a', { status: 'accepted' }], ['b', { status: 'local-pass' }], ['c', { status: 'attempted' }], ['d', { status: 'notes-only' }], ['e', { status: 'empty' }]]);
  assert.deepEqual(progressFor('a', map), { status: 'accepted', label: 'Accepted' });
  assert.deepEqual(progressFor('b', map), { status: 'local-pass', label: 'Passed locally' });
  assert.deepEqual(progressFor('c', map), { status: 'attempted', label: 'In progress' });
  assert.deepEqual(progressFor('d', map), { status: 'notes-only', label: 'Notes saved' });
  assert.deepEqual(progressFor('e', map), { status: 'empty', label: 'Not started' });
  assert.deepEqual(progressFor('missing', map), { status: 'empty', label: 'Not started' });
  assert.deepEqual(progressFor('a', null), { status: 'unknown', label: 'Progress unavailable' });
});

test('loadCatalogProgress validates the endpoint shape and keeps records by slug', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, async json() { return { problems: [{ slug: 'a', status: 'accepted' }] }; } });
  try { assert.deepEqual([...await loadCatalogProgress()], [['a', { slug: 'a', status: 'accepted' }]]); }
  finally { globalThis.fetch = original; }
});

test('loadCatalogProgress rejects endpoint failures and malformed payloads', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: false, status: 503 });
    await assert.rejects(loadCatalogProgress(), /503/);
    globalThis.fetch = async () => ({ ok: true, async json() { return { totals: {} }; } });
    await assert.rejects(loadCatalogProgress(), /problems array/);
  } finally { globalThis.fetch = original; }
});
