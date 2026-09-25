import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { createApp } from '../app.mjs';
import { loadSolutionStore } from '../solutions.mjs';
import { loadCatalog, validateCatalog } from '../catalog.mjs';
import { LeetCodeContentCache, LeetCodeError } from '../leetcode.mjs';
import { StaticSite } from '../static.mjs';
import { CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from '../paths.mjs';

const solutions = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);
const catalog = loadCatalog(CATALOG_FILE, solutions);

const TWO_SUM = {
  questionId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  content: '<p>Given an array...</p>',
  difficulty: 'Easy',
  isPaidOnly: false,
  exampleTestcases: '[2,7,11,15]\n9',
  topicTags: [{ name: 'Array', slug: 'array' }],
  codeSnippets: [],
};

const PREMIUM = {
  questionId: '253',
  title: 'Meeting Rooms II',
  titleSlug: 'meeting-rooms-ii',
  content: null,
  difficulty: 'Medium',
  isPaidOnly: true,
  exampleTestcases: '[[0,30],[5,10]]',
  topicTags: [{ name: 'Array', slug: 'array' }],
  codeSnippets: null,
};

/** Start a real loopback server so the Host/Origin path is exercised end to end. */
async function withServer({ fetchQuestionImpl, cacheDir, webDir = null } = {}, run) {
  const dir = cacheDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-app-')));
  const leetcode = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl:
      fetchQuestionImpl ??
      (async (slug) => (slug === 'meeting-rooms-ii' ? PREMIUM : { ...TWO_SUM, titleSlug: slug })),
  });
  const site = new StaticSite(webDir ?? path.join(os.tmpdir(), 'studio-no-web-' + process.pid));
  const app = createApp({
    catalog,
    solutions,
    leetcode,
    site,
    log: { warn() {}, error() {} },
  });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const call = async (pathname, init = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { res, text, json, status: res.status };
  };

  try {
    await run({ call, port, dir });
  } finally {
    await new Promise((r) => server.close(r));
    if (!cacheDir) await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('boot-time counts: 250 problems, 18 patterns, no "JavaScript" pattern', () => {
  assert.equal(catalog.problems.length, 250);
  assert.equal(catalog.patterns.length, 18);
  assert.equal(catalog.patterns.includes('JavaScript'), false);
  // The pattern does exist in the full 973-problem bundle; it is absent from the 250.
  assert.equal(catalog.allPatterns.includes('JavaScript'), true);
  assert.equal(catalog.allPatterns.length, 19);
  assert.deepEqual(validateCatalog(catalog), []);
  assert.equal(catalog.patterns[0], 'Arrays & Hashing', 'first-appearance order, not alphabetical');
});

test('GET /api/health', async () => {
  await withServer({}, async ({ call }) => {
    const { status, json, res } = await call('/api/health');
    assert.equal(status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(json.ok, true);
    assert.equal(json.problemCount, 250);
    assert.equal(json.patternCount, 18);
    assert.equal(json.solutionsCommit, '9907b7fed441fa55083c0751e208b7197101dbba');
    assert.ok(typeof json.catalogSource === 'string');
  });
});

test('GET /api/problems returns the contract shape', async () => {
  await withServer({}, async ({ call }) => {
    const { status, json } = await call('/api/problems');
    assert.equal(status, 200);
    assert.equal(json.problems.length, 250);
    assert.equal(json.patterns.length, 18);
    const twoSum = json.problems.find((p) => p.slug === 'two-sum');
    assert.deepEqual(Object.keys(twoSum).sort(), [
      'difficulty',
      'hasArticle',
      'hasPythonSolution',
      'isPro',
      'lists',
      'neetcodeSlug',
      'number',
      'pattern',
      'slug',
      'title',
      'youtubeVideoId',
    ]);
    assert.equal(twoSum.number, 1);
    assert.equal(twoSum.pattern, 'Arrays & Hashing');
    assert.deepEqual(Object.keys(twoSum.lists).sort(), ['blind75', 'neetcode150', 'neetcode250']);
    assert.equal(twoSum.lists.neetcode250, true);
    assert.equal(twoSum.hasPythonSolution, true);
    assert.ok(json.problems.every((p) => p.lists.neetcode250 === true));
    // The internal lookup key must not leak onto the wire.
    assert.equal('solutionCodeStem' in JSON.parse(JSON.stringify(twoSum)), false);
  });
});

test('GET /api/problems/:slug — lazy fetch, then cache hit', async () => {
  let calls = 0;
  await withServer(
    {
      fetchQuestionImpl: async () => {
        calls += 1;
        return TWO_SUM;
      },
    },
    async ({ call }) => {
      const { status, json } = await call('/api/problems/two-sum');
      assert.equal(status, 200);
      assert.equal(json.slug, 'two-sum');
      assert.equal(json.catalog.number, 1);
      assert.equal(json.content.title, 'Two Sum');
      assert.equal(json.content.descriptionHtml, '<p>Given an array...</p>');
      assert.deepEqual(json.content.topicTags, ['Array']);
      assert.equal(json.content.isPaidOnly, false);
      assert.equal(json.content.stale, false);
      assert.ok(json.content.fetchedAt);
      assert.deepEqual(json.solution, { available: true, language: 'python' });
      assert.deepEqual(json.article, { available: true });

      await call('/api/problems/two-sum');
      assert.equal(calls, 1, 'second open must be served from cache');
    },
  );
});

test('GET /api/problems/:slug — premium is 200, not an error', async () => {
  await withServer({}, async ({ call }) => {
    const { status, json } = await call('/api/problems/meeting-rooms-ii');
    assert.equal(status, 200);
    assert.equal(json.content.isPaidOnly, true);
    assert.equal(json.content.descriptionHtml, null);
    assert.equal(json.content.title, 'Meeting Rooms II');
    // `catalog.isPro` is NeetCode-pro and is a different thing from LeetCode premium —
    // this problem is LeetCode-premium but not NeetCode-pro. Only content.isPaidOnly is
    // authoritative for "you cannot read the description".
    assert.equal(json.catalog.isPro, false);
  });
});

test('GET /api/problems/:slug — unreachable with no cache is 503 LEETCODE_UNREACHABLE', async () => {
  await withServer(
    {
      fetchQuestionImpl: async () => {
        throw new LeetCodeError('Could not reach LeetCode. Check your network connection.', {
          kind: 'network',
        });
      },
    },
    async ({ call }) => {
      const { status, json } = await call('/api/problems/two-sum');
      assert.equal(status, 503);
      assert.equal(json.error.code, 'LEETCODE_UNREACHABLE');
      assert.match(json.error.message, /still works/);
      assert.doesNotMatch(json.error.message, /at .*\.mjs:/, 'no stack trace in a user-facing message');
    },
  );
});

test('GET /api/problems/:slug — unreachable WITH a cache entry is 200 + stale', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-stale-'));
  await fsp.writeFile(
    path.join(dir, 'two-sum.json'),
    JSON.stringify({ slug: 'two-sum', fetchedAt: '2020-01-01T00:00:00.000Z', complete: false, question: TWO_SUM }),
    'utf8',
  );
  await withServer(
    {
      cacheDir: dir,
      fetchQuestionImpl: async () => {
        throw new LeetCodeError('Could not reach LeetCode.', { kind: 'network' });
      },
    },
    async ({ call }) => {
      const { status, json } = await call('/api/problems/two-sum');
      assert.equal(status, 200);
      assert.equal(json.content.stale, true);
      assert.equal(json.content.title, 'Two Sum');
    },
  );
  await fsp.rm(dir, { recursive: true, force: true });
});

test('GET /api/problems/:slug/solution', async () => {
  await withServer({}, async ({ call }) => {
    const { status, json } = await call('/api/problems/two-sum/solution');
    assert.equal(status, 200);
    assert.equal(json.language, 'python');
    assert.equal(json.sourcePath, 'python/0001-two-sum.py');
    assert.match(json.code, /class Solution/);
    assert.match(json.license.notice, /MIT/);
    assert.match(json.license.copyright, /neetcode-gh/);
  });
});

test('GET /api/problems/:slug/solution — 404 SOLUTION_NOT_AVAILABLE when there is no Python file', async () => {
  const without = catalog.problems.find((p) => !p.hasPythonSolution);
  assert.ok(without, 'expected at least one problem in the 250 with no Python reference');
  await withServer({}, async ({ call }) => {
    const { status, json } = await call(`/api/problems/${without.slug}/solution`);
    assert.equal(status, 404);
    assert.equal(json.error.code, 'SOLUTION_NOT_AVAILABLE');
  });
});

test('GET /api/problems/:slug/article', async () => {
  await withServer({}, async ({ call }) => {
    const { status, json } = await call('/api/problems/contains-duplicate/article');
    assert.equal(status, 200);
    // Articles are keyed by the NeetCode slug, which for this problem is not the LeetCode one.
    assert.equal(json.sourcePath, 'articles/duplicate-integer.md');
    assert.ok(json.markdown.length > 0);
    assert.match(json.license.notice, /MIT/);
  });
});

test('unknown and hostile slugs are rejected, never turned into a path', async () => {
  await withServer({}, async ({ call }) => {
    for (const p of [
      '/api/problems/definitely-not-a-problem',
      '/api/problems/..%2f..%2fpackage.json',
      '/api/problems/%2e%2e%2f%2e%2e%2fetc%2fpasswd/solution',
      '/api/problems/..%2f..%2f..%2fdata%2fcatalog.json/article',
      '/api/problems/two%00sum',
    ]) {
      const { status, json } = await call(p);
      assert.equal(status, 404, p);
      assert.equal(json.error.code, 'PROBLEM_NOT_FOUND', p);
    }
  });
});

test('every response body is an error envelope with a plain-English message', async () => {
  await withServer({}, async ({ call }) => {
    const nope = await call('/api/nope');
    assert.equal(nope.status, 404);
    assert.equal(nope.json.error.code, 'NOT_FOUND');
    assert.ok(nope.json.error.message.length > 10);

    const post = await call('/api/problems', { method: 'POST' });
    assert.equal(post.status, 405);
    assert.equal(post.json.error.code, 'METHOD_NOT_ALLOWED');
  });
});

test('non-loopback Host and Origin are refused with 403', async () => {
  await withServer({}, async ({ call, port }) => {
    const bad = await call('/api/health', { headers: { Origin: 'https://evil.example.com' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.json.error.code, 'FORBIDDEN_ORIGIN');

    const badRef = await call('/api/health', { headers: { Referer: 'https://evil.example.com/x' } });
    assert.equal(badRef.status, 403);

    // A DNS-rebinding attempt reaches us with an attacker-controlled Host header.
    const rebind = await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/health', method: 'GET', headers: { Host: 'evil.example.com' } },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(body) }));
        },
      );
      req.end();
    });
    assert.equal(rebind.status, 403);
    assert.equal(rebind.json.error.code, 'FORBIDDEN_ORIGIN');

    // Loopback origins are fine.
    for (const origin of ['http://localhost:4173', 'http://127.0.0.1:4173', 'http://[::1]:4173']) {
      const ok = await call('/api/health', { headers: { Origin: origin } });
      assert.equal(ok.status, 200, origin);
    }
  });
});

test('static: placeholder when studio/web does not exist', async () => {
  await withServer({}, async ({ call }) => {
    const { status, text, res } = await call('/');
    assert.equal(status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(text, /Studio server is running/);
  });
});

test('static: serves studio/web when present, and cannot be escaped', async () => {
  const web = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-web-'));
  const outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-outside-'));
  await fsp.writeFile(path.join(web, 'index.html'), '<h1>client</h1>', 'utf8');
  await fsp.mkdir(path.join(web, 'assets'));
  await fsp.writeFile(path.join(web, 'assets', 'app.css'), 'body{}', 'utf8');
  await fsp.writeFile(path.join(outsideDir, 'secret.txt'), 'secret', 'utf8');

  await withServer({ webDir: web }, async ({ call }) => {
    const root = await call('/');
    assert.equal(root.status, 200);
    assert.match(root.text, /<h1>client<\/h1>/);

    const css = await call('/assets/app.css');
    assert.equal(css.status, 200);
    assert.match(css.res.headers.get('content-type'), /text\/css/);

    // Extensionless deep link falls back to index.html for client-side routing.
    const spa = await call('/problem/two-sum');
    assert.equal(spa.status, 200);
    assert.match(spa.text, /<h1>client<\/h1>/);

    for (const p of ['/../secret.txt', '/%2e%2e%2fsecret.txt', '/assets/../../secret.txt']) {
      const esc = await call(p);
      assert.notEqual(esc.text.trim(), 'secret', `escaped the web root via ${p}`);
    }

    // The API is still the API, even with a client present.
    const health = await call('/api/health');
    assert.equal(health.status, 200);
  });

  await fsp.rm(web, { recursive: true, force: true });
  await fsp.rm(outsideDir, { recursive: true, force: true });
});
