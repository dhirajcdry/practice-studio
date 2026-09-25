// Cases you added: stored, validated, and never able to break a run of the examples.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readCases, writeCases, casesFile, whyNotRunnable, linesPerCase } from './cases.mjs';
import { buildCases } from './testcases.mjs';

async function workspace() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-cases-'));
}

test('a saved case comes back exactly as it was written', async () => {
  const root = await workspace();
  await writeCases({
    root,
    slug: 'two-sum',
    cases: [{ input: '[2,7,11,15]\n9', expected: '[0,1]', source: 'custom' }],
  });
  const back = await readCases({ root, slug: 'two-sum' });
  assert.equal(back.length, 1);
  assert.equal(back[0].input, '[2,7,11,15]\n9');
  assert.equal(back[0].expected, '[0,1]');
  assert.equal(back[0].source, 'custom');
});

test('no file, an unreadable file and a file of the wrong shape all read as no cases', async () => {
  const root = await workspace();
  assert.deepEqual(await readCases({ root, slug: 'never-opened' }), []);

  const file = casesFile(root, 'broken');
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, '{ not json', 'utf8');
  assert.deepEqual(await readCases({ root, slug: 'broken' }), [], 'corrupt file must not throw');

  await fsp.writeFile(file, JSON.stringify({ cases: 'nope' }), 'utf8');
  assert.deepEqual(await readCases({ root, slug: 'broken' }), []);
});

test('empty inputs are dropped and an unknown source is not trusted', async () => {
  const root = await workspace();
  const saved = await writeCases({
    root,
    slug: 'two-sum',
    cases: [
      { input: '   ', expected: '[0,1]' },
      { input: '[1]\n1', source: 'wherever-i-like' },
      null,
    ],
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].source, 'custom', 'an unrecognised source falls back to yours, never to LeetCode');
});

test('the stored list is capped, so a local run stays local-run sized', async () => {
  const root = await workspace();
  const many = Array.from({ length: 60 }, (_, i) => ({ input: `[${i}]\n${i}` }));
  const saved = await writeCases({ root, slug: 'two-sum', cases: many });
  assert.equal(saved.length, 25);
});

test('a case is refused where it was typed, with the reason', () => {
  assert.equal(whyNotRunnable('[2,7,11,15]\n9', 2), null);
  assert.match(whyNotRunnable('[2,7,11,15]', 2), /takes 2 lines of input per case, and this has 1/);
  assert.match(whyNotRunnable('nums = [1,2]\n9', 2), /not valid JSON/);
  assert.match(whyNotRunnable('   ', 2), /at least one line/);
});

test('linesPerCase follows the problem shape', () => {
  assert.equal(linesPerCase({ kind: 'function', params: [{ name: 'nums' }, { name: 'target' }] }), 2);
  assert.equal(linesPerCase({ kind: 'design' }), 2);
});

// --------------------------------------------------------------------- expected

test('an expected value you typed beats anything scraped from the description', () => {
  const built = buildCases({
    perCase: 1,
    testcases: '[1,2,3]\n[9,9]',
    descriptionHtml: '<p><strong>Output:</strong> true</p><p><strong>Output:</strong> false</p>',
    expectedOverrides: [null, 'MINE'],
  });
  assert.ok(built.ok);
  assert.equal(built.cases[0].expected, null, 'an explicit null means "no expected", not "go and scrape one"');
  assert.equal(built.cases[1].expected, 'MINE');
});

test('without overrides the scraped outputs are still used, in order', () => {
  const built = buildCases({
    perCase: 1,
    testcases: '[1,2,3]\n[9,9]',
    descriptionHtml: '<p><strong>Output:</strong> true</p><p><strong>Output:</strong> false</p>',
  });
  assert.ok(built.ok);
  assert.equal(built.cases[0].expected, 'true');
  assert.equal(built.cases[1].expected, 'false');
});

test('a case beyond the published examples does not inherit an example\'s answer', () => {
  // The bug this exists to stop: append your own case and it silently gets marked
  // wrong against the expected output of whichever example shares its index.
  const built = buildCases({
    perCase: 1,
    testcases: '[1,2,3]\n[4,5,6]\n[7,7,7]',
    descriptionHtml: '<p><strong>Output:</strong> true</p><p><strong>Output:</strong> false</p>',
    expectedOverrides: ['true', 'false', null],
  });
  assert.ok(built.ok);
  assert.equal(built.cases[2].expected, null);
  assert.equal(built.cases[2].hasExpected, false);
});
