// Everything a problem needs, with the network unplugged.
//
// The screenshot that prompted this: THE DESCRIPTION TIMED OUT, a stub that is a shell
// with an empty method body, "the example cases could not be loaded", and NOT SAVING TO
// DISK — four separate failures, all of them one missing cache file. A problem you have
// opened before works on a plane. A problem you have not, does not.
//
// So the fetch here does not fail politely: it throws on every call, the way it would with
// the wifi off. What the routes then serve must come entirely from disk.
//
// `scripts/warm-cache.mjs` is the other half — it fills the cache so that the "cached"
// branch is the one you are actually on. This proves the branch is worth filling.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { createApp } from '../app.mjs';
import { loadSolutionStore } from '../solutions.mjs';
import { loadCatalog } from '../catalog.mjs';
import { LeetCodeContentCache, LeetCodeError } from '../leetcode.mjs';
import { StaticSite } from '../static.mjs';
import { CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from '../paths.mjs';

const solutions = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);
const catalog = loadCatalog(CATALOG_FILE, solutions);

/** A real cached record, in the shape warm-cache.mjs leaves on disk. */
const CACHED_TWO_SUM = {
  slug: 'two-sum',
  fetchedAt: '2026-07-30T09:00:00.000Z',
  complete: true,
  question: {
    questionId: '1',
    questionFrontendId: '1',
    title: 'Two Sum',
    titleSlug: 'two-sum',
    content: '<p>Given an array of integers <code>nums</code>...</p>',
    difficulty: 'Easy',
    isPaidOnly: false,
    exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
    topicTags: [{ name: 'Array', slug: 'array' }, { name: 'Hash Table', slug: 'hash-table' }],
    metaData: JSON.stringify({
      name: 'twoSum',
      params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
      return: { type: 'integer[]' },
    }),
    codeSnippets: [
      { lang: 'Python3', langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ' },
      { lang: 'Java', langSlug: 'java', code: 'class Solution {}' },
    ],
  },
};

/** The wifi is off. Not slow, not flaky — off. */
function unplugged() {
  return async () => {
    throw new LeetCodeError('The request to LeetCode failed (the network is unreachable).', {
      kind: 'network',
    });
  };
}

async function withOfflineServer(run, { seed = [CACHED_TWO_SUM] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-offline-'));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-offline-home-'));
  for (const record of seed) {
    await fsp.writeFile(path.join(dir, `${record.slug}.json`), JSON.stringify(record, null, 2));
  }

  let calls = 0;
  const leetcode = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async (...args) => { calls += 1; return unplugged()(...args); },
  });
  const app = createApp({
    catalog,
    solutions,
    leetcode,
    site: new StaticSite(path.join(os.tmpdir(), 'studio-no-web-' + process.pid)),
    homeRoot: home,
    log: { warn() {}, error() {} },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const call = async (pathname, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { res, text, json, status: res.status };
  };

  try {
    await run({ call, home, networkCalls: () => calls });
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(home, { recursive: true, force: true });
  }
}

test('a cached problem opens with the network unreachable', async () => {
  await withOfflineServer(async ({ call, networkCalls }) => {
    const { status, json } = await call('/api/problems/two-sum');
    assert.equal(status, 200);
    assert.match(json.content.descriptionHtml, /Given an array of integers/);
    assert.equal(json.content.difficulty, 'Easy');
    assert.equal(json.content.stale, false, 'served from cache is not stale — nothing was tried and failed');
    assert.equal(networkCalls(), 0, 'a cache hit must not touch the network at all');
  });
});

test('the starting stub is LeetCode\'s own, not a generated shell', async () => {
  await withOfflineServer(async ({ call }) => {
    const { status, json } = await call('/api/problems/two-sum/code');
    assert.equal(status, 200);
    const code = json.code ?? json.stub ?? '';
    // The screenshot's shell was `def removeNthNodeFromEndOfList(self):` — the method name
    // guessed from the slug and no parameters. The real signature is the tell.
    assert.match(code, /def twoSum\(self, nums: List\[int\], target: int\)/);
    assert.doesNotMatch(code, /It is not answering, so this is a shell/);
  });
});

test('the example cases load, and the problem is runnable', async () => {
  await withOfflineServer(async ({ call }) => {
    const { status, json } = await call('/api/problems/two-sum/testcases');
    assert.equal(status, 200);
    assert.equal(json.runnable, true, 'metaData came from the cache, so the runner knows the shape');
    assert.ok(json.cases.length >= 2, `expected the two example cases, got ${json.cases.length}`);
    assert.equal(json.cases[0].input, '[2,7,11,15]\n9');
  });
});

test('an uncached problem offline says so honestly, and does not pretend', async () => {
  await withOfflineServer(async ({ call, networkCalls }) => {
    const { status, json } = await call('/api/problems/3sum');
    assert.equal(status, 503);
    assert.equal(json.error.code, 'LEETCODE_UNREACHABLE');
    assert.match(json.error.message, /everything else in the app still works/);
    assert.ok(networkCalls() > 0, 'a miss should at least try');
  });
});

test('the catalog, the search, and the solutions never needed the network', async () => {
  await withOfflineServer(async ({ call, networkCalls }) => {
    const list = await call('/api/problems');
    assert.equal(list.status, 200);
    assert.equal(list.json.problems.length, 250, 'the whole curriculum is a local file');

    // The vendored solution and article are on disk too — the two panels the timed-out
    // page still offered, and correctly so.
    const solution = await call('/api/problems/two-sum/solution');
    assert.equal(solution.status, 200);
    assert.ok(solution.json.code.length > 0);

    assert.equal(networkCalls(), 0, 'none of this should have gone anywhere near LeetCode');
  });
});

test('every cached record the app relies on survives a round trip through disk', async () => {
  // The cache file is the contract between warm-cache.mjs and the server. If the shape
  // drifts, the warm cache silently becomes useless and every problem is a first open.
  await withOfflineServer(async ({ call }) => {
    const { json } = await call('/api/problems/two-sum');
    for (const field of ['descriptionHtml', 'difficulty', 'exampleTestcases', 'metaData', 'codeSnippets']) {
      assert.ok(json.content[field] != null, `${field} did not survive the cache round trip`);
    }
    assert.equal(json.content.metaData.name, 'twoSum', 'metaData must arrive parsed, not as a string');
  });
});

test('the editor does not wait on LeetCode to hand back the code that is on disk', async () => {
  // The screenshot's other failure: NOT SAVING TO DISK, "the server took longer than 8s".
  // The buffer was on disk and readable; the response was held up behind a starting stub.
  // A fetch that hangs must cost this route a couple of seconds, not the browser's whole
  // patience — the stub is a nicety, the code is the point.
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-offline-slow-'));
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-offline-slowhome-'));
  await fsp.mkdir(path.join(home, 'problems', 'two-sum'), { recursive: true });
  await fsp.writeFile(path.join(home, 'problems', 'two-sum', 'solution.py'), '# my actual work\n');

  const leetcode = new LeetCodeContentCache({
    cacheDir: dir,
    // Hangs the way an unreachable host does: nothing comes back, and nothing errors.
    fetchQuestionImpl: () => new Promise(() => {}),
  });
  const app = createApp({
    catalog,
    solutions,
    leetcode,
    site: new StaticSite(path.join(os.tmpdir(), 'studio-no-web-' + process.pid)),
    homeRoot: home,
    log: { warn() {}, error() {} },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  try {
    const started = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/api/problems/two-sum/code`);
    const json = await res.json();
    const took = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(json.code, '# my actual work\n', 'their code came back, which is the whole job');
    assert.ok(took < 5000, `took ${took}ms — the browser gives up at 8000ms`);
    assert.ok(json.stub, 'a generic stub rather than none, so Reset still means something');
  } finally {
    await new Promise((r) => server.close(r));
    await fsp.rm(dir, { recursive: true, force: true });
    await fsp.rm(home, { recursive: true, force: true });
  }
});
