import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { loadSolutionStore, stemsAreSameProblem, SolutionStore } from '../solutions.mjs';
import { SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from '../paths.mjs';

const store = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);

function entry({ slug, neetcodeSlug = null, number, stem }) {
  const e = { slug, neetcodeSlug, number };
  Object.defineProperty(e, 'solutionCodeStem', { value: stem, enumerable: false });
  return e;
}

test('slug-drift: same problem, different upstream spellings', () => {
  assert.ok(stemsAreSameProblem('pascal-triangle-ii', 'pascals-triangle-ii'));
  assert.ok(stemsAreSameProblem('length-of-last-word', 'length-of-the-last-word'));
  assert.ok(
    stemsAreSameProblem('remove-nth-node-from-end-of-list', 'remove-nth-node-from-end-of-the-list'),
  );
  assert.ok(
    stemsAreSameProblem('rearrange-array-elements-by-sign', 'rearrange-array-elements-by-signs'),
  );
  assert.ok(
    stemsAreSameProblem(
      'lowest-common-ancestor-of-a-binary-tree',
      'lowest-common-ancestor-of-binary-tree',
    ),
  );
  assert.ok(
    stemsAreSameProblem(
      'find-largest-value-in-each-tree-row',
      'find-the-largest-value-in-each-tree-row',
    ),
  );
  assert.ok(stemsAreSameProblem('range-sum-query', 'range-sum-query-immutable'));
});

test('slug-drift: upstream misnumbering must NOT be merged', () => {
  // All three of these share a number with a different problem in the vendored repo.
  assert.equal(stemsAreSameProblem('contains-duplicate', 'encode-and-decode-strings'), false);
  assert.equal(
    stemsAreSameProblem('lowest-common-ancestor-of-a-binary-tree', 'power-of-three'),
    false,
  );
  // Meeting Rooms is problem 252; upstream filed it under 0253. A prefix match, but the
  // trailing ordinal says these are different problems.
  assert.equal(stemsAreSameProblem('meeting-rooms-ii', 'meeting-rooms'), false);
});

test('0119 Pascal\'s Triangle II: the Python file lives under the OTHER spelling', () => {
  // Exact-stem lookup on `0119-pascals-triangle-ii` yields java+kotlin only.
  assert.deepEqual(Object.keys(store.solutions['0119-pascals-triangle-ii']).sort(), [
    'java',
    'kotlin',
  ]);
  const e = entry({
    slug: 'pascals-triangle-ii',
    neetcodeSlug: 'pascals-triangle-ii',
    number: 119,
    stem: '0119-pascals-triangle-ii',
  });
  const langs = store.languagesFor(e);
  assert.ok(langs.has('python'), 'number-based resolution must find the drifted Python file');
  assert.equal(langs.get('python').path, 'python/0119-pascal-triangle-ii.py');
  assert.equal(langs.get('java').path, 'java/0119-pascals-triangle-ii.java');
});

test('0019 / 0058 / 2149 / 0236 / 0303: drifted files are merged in', () => {
  const cases = [
    [
      entry({ slug: 'remove-nth-node-from-end-of-list', number: 19, stem: '0019-remove-nth-node-from-end-of-list' }),
      'rust',
      'rust/0019-remove-nth-node-from-end-of-list.rs', // canonical wins the collision
    ],
    [
      entry({ slug: 'length-of-last-word', number: 58, stem: '0058-length-of-last-word' }),
      'c',
      'c/0058-length-of-last-word.c',
    ],
    [
      entry({ slug: 'rearrange-array-elements-by-sign', number: 2149, stem: '2149-rearrange-array-elements-by-sign' }),
      'java',
      'java/2149-rearrange-array-elements-by-signs.java', // only exists under the drifted stem
    ],
    [
      entry({
        slug: 'lowest-common-ancestor-of-a-binary-tree',
        number: 236,
        stem: '0236-lowest-common-ancestor-of-a-binary-tree',
      }),
      'go',
      'go/0236-lowest-common-ancestor-of-binary-tree.go',
    ],
    [
      entry({ slug: 'range-sum-query-immutable', number: 303, stem: '0303-range-sum-query-immutable' }),
      'go',
      'go/0303-range-sum-query.go',
    ],
  ];
  for (const [e, lang, expected] of cases) {
    const langs = store.languagesFor(e);
    assert.ok(langs.has(lang), `${e.slug}: expected a ${lang} file`);
    assert.equal(langs.get(lang).path, expected, e.slug);
  }
});

test('misnumbered upstream files are not served for the wrong problem', () => {
  const containsDuplicate = entry({
    slug: 'contains-duplicate',
    neetcodeSlug: 'duplicate-integer',
    number: 217,
    stem: '0217-contains-duplicate',
  });
  assert.equal(
    store.languagesFor(containsDuplicate).get('kotlin').path,
    'kotlin/0217-contains-duplicate.kt',
    'must not pick up kotlin/0217-encode-and-decode-strings.kt',
  );

  const lca = entry({
    slug: 'lowest-common-ancestor-of-a-binary-tree',
    number: 236,
    stem: '0236-lowest-common-ancestor-of-a-binary-tree',
  });
  assert.equal(store.languagesFor(lca).has('cpp'), false, 'cpp/0236-power-of-three.cpp is a different problem');

  const meetingRoomsII = entry({
    slug: 'meeting-rooms-ii',
    neetcodeSlug: 'meeting-schedule-ii',
    number: 253,
    stem: '0253-meeting-rooms-ii',
  });
  assert.equal(
    store.languagesFor(meetingRoomsII).get('python').path,
    'python/0253-meeting-rooms-ii.py',
    'python/0253-meeting-rooms.py is actually problem 252',
  );
});

test('articles resolve on the NeetCode slug key space (no number prefix)', () => {
  const e = entry({ slug: 'contains-duplicate', neetcodeSlug: 'duplicate-integer', number: 217, stem: '0217-contains-duplicate' });
  assert.equal(store.articlePathFor(e), 'articles/duplicate-integer.md');

  const missing = entry({ slug: 'not-a-real-problem', neetcodeSlug: null, number: 99999, stem: null });
  assert.equal(store.articlePathFor(missing), null);
  assert.equal(store.hasArticle(missing), false);
});

test('vendor reads are confined to the vendor root', async () => {
  const escapes = [
    '../../package.json',
    '../../../../etc/passwd',
    'articles/../../package.json',
    '/etc/passwd',
    path.join(os.homedir(), '.ssh', 'id_rsa'),
    'articles/../../../data/catalog.json',
    'articles/two-sum.md\0.png',
  ];
  for (const p of escapes) {
    assert.equal(await store.resolveInsideVendor(p), null, `must reject: ${p}`);
    assert.equal(await store.readVendorFile(p), null, `must reject: ${p}`);
  }

  // The legitimate case still works.
  const ok = await store.readVendorFile('python/0001-two-sum.py');
  assert.ok(typeof ok === 'string' && ok.length > 0);
  assert.equal(await store.resolveInsideVendor('LICENSE') !== null, true);
});

test('a symlink pointing out of the vendor root is refused', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-vendor-'));
  const root = path.join(tmp, 'vendor');
  const outside = path.join(tmp, 'secret.txt');
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(outside, 'secret', 'utf8');
  await fsp.writeFile(path.join(root, 'inside.txt'), 'inside', 'utf8');
  await fsp.symlink(outside, path.join(root, 'escape.txt'));

  const s = new SolutionStore({ solutions: {}, license: {}, source: {} }, root);
  assert.equal(await s.readVendorFile('inside.txt'), 'inside');
  assert.equal(await s.readVendorFile('escape.txt'), null, 'symlink out of the root must be refused');

  await fsp.rm(tmp, { recursive: true, force: true });
});

test('a missing vendor root fails closed rather than throwing', async () => {
  const s = new SolutionStore({ solutions: {}, license: {}, source: {} }, '/definitely/not/here');
  assert.equal(s.vendorRootReal, null);
  assert.equal(await s.readVendorFile('python/0001-two-sum.py'), null);
});
