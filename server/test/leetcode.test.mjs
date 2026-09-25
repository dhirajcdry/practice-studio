import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fsp from 'node:fs/promises';

import { fetchQuestion, toContent, LeetCodeError, LeetCodeContentCache } from '../leetcode.mjs';

function response({ status = 200, contentType = 'application/json', body = {}, headers = {} } = {}) {
  const all = new Map(
    Object.entries({ 'content-type': contentType, ...headers }).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => all.get(String(k).toLowerCase()) ?? null },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const TWO_SUM = {
  questionId: '1',
  questionFrontendId: '1',
  title: 'Two Sum',
  titleSlug: 'two-sum',
  content: '<p>Given an array...</p>',
  difficulty: 'Easy',
  isPaidOnly: false,
  exampleTestcases: '[2,7,11,15]\n9',
  topicTags: [
    { name: 'Array', slug: 'array' },
    { name: 'Hash Table', slug: 'hash-table' },
  ],
  codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution:' }],
};

// [VERIFIED 2026-07-25] premium shape, from docs/LEETCODE-API.md §1.5
const MEETING_ROOMS = {
  questionId: '252',
  questionFrontendId: '252',
  title: 'Meeting Rooms',
  titleSlug: 'meeting-rooms',
  content: null,
  difficulty: 'Easy',
  isPaidOnly: true,
  exampleTestcases: '[[0,30],[5,10],[15,20]]\n[[7,10],[2,4]]',
  topicTags: [{ name: 'Array', slug: 'array' }],
  codeSnippets: null,
};

async function tmpCache() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-cache-'));
}

test('premium: 200 + isPaidOnly, content null, codeSnippets null, no errors array', async () => {
  const q = await fetchQuestion('meeting-rooms', {
    fetchImpl: async () => response({ body: { data: { question: MEETING_ROOMS } } }),
  });
  const content = toContent(q, { fetchedAt: 'T' });
  assert.equal(content.isPaidOnly, true);
  assert.equal(content.descriptionHtml, null);
  assert.equal(content.title, 'Meeting Rooms');
  assert.deepEqual(content.topicTags, ['Array']);
  assert.equal(content.exampleTestcases, '[[0,30],[5,10],[15,20]]\n[[7,10],[2,4]]');
  assert.equal(content.stale, false);
});

test('toContent survives a question with every optional field missing', () => {
  const c = toContent({}, { fetchedAt: null });
  assert.deepEqual(c, {
    title: null,
    difficulty: null,
    descriptionHtml: null,
    topicTags: [],
    exampleTestcases: null,
    // Surfaced for the local runner (metaData) and the editor's starting stub
    // (codeSnippets). Both were always fetched; premium returns null for codeSnippets,
    // so neither may be assumed present.
    metaData: null,
    codeSnippets: null,
    isPaidOnly: false,
    fetchedAt: null,
    stale: false,
  });
  assert.doesNotThrow(() => toContent(null, {}));
});

test('HTML instead of JSON is never parsed as JSON', async () => {
  const html = '<!DOCTYPE html><html><body>Just a moment...</body></html>';

  await assert.rejects(
    fetchQuestion('two-sum', {
      fetchImpl: async () =>
        response({
          status: 403,
          contentType: 'text/html; charset=UTF-8',
          headers: { 'cf-mitigated': 'challenge' },
          body: html,
        }),
    }),
    (err) => {
      assert.ok(err instanceof LeetCodeError);
      assert.equal(err.kind, 'challenged');
      assert.match(err.message, /challenge/i);
      assert.doesNotMatch(err.message, /JSON|SyntaxError|Unexpected token/);
      return true;
    },
  );

  await assert.rejects(
    fetchQuestion('two-sum', {
      fetchImpl: async () => response({ status: 200, contentType: 'text/html', body: html }),
    }),
    (err) => err instanceof LeetCodeError && err.kind === 'not-json',
  );
});

test('rate limiting, GraphQL errors and unknown slugs all become plain-English errors', async () => {
  await assert.rejects(
    fetchQuestion('two-sum', { fetchImpl: async () => response({ status: 429, body: {} }) }),
    (e) => e.kind === 'rate-limited',
  );
  await assert.rejects(
    fetchQuestion('two-sum', {
      fetchImpl: async () => response({ body: { errors: [{ message: 'nope' }], data: null } }),
    }),
    (e) => e.kind === 'graphql-error' && /nope/.test(e.message),
  );
  await assert.rejects(
    fetchQuestion('not-a-slug', { fetchImpl: async () => response({ body: { data: { question: null } } }) }),
    (e) => e.kind === 'unknown-slug',
  );
  await assert.rejects(
    fetchQuestion('two-sum', {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    }),
    (e) => e instanceof LeetCodeError && e.kind === 'network',
  );
});

test('cache: miss fetches and writes atomically, hit does no network at all', async () => {
  const dir = await tmpCache();
  let calls = 0;
  const cache = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async () => {
      calls += 1;
      return TWO_SUM;
    },
  });

  const first = await cache.getContent('two-sum');
  assert.equal(calls, 1);
  assert.equal(first.fromCache, false);
  assert.equal(first.content.stale, false);
  assert.equal(first.content.descriptionHtml, '<p>Given an array...</p>');

  const onDisk = JSON.parse(await fsp.readFile(path.join(dir, 'two-sum.json'), 'utf8'));
  assert.equal(onDisk.slug, 'two-sum');
  assert.equal(onDisk.complete, true);
  assert.equal(onDisk.question.title, 'Two Sum');
  assert.equal((await fsp.readdir(dir)).filter((f) => f.endsWith('.tmp')).length, 0, 'no temp files left behind');

  const second = await cache.getContent('two-sum');
  assert.equal(calls, 1, 'a cache hit must not touch the network');
  assert.equal(second.fromCache, true);
  assert.equal(second.content.stale, false);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('cache: a failed fetch with an existing entry serves it with stale:true', async () => {
  const dir = await tmpCache();
  await fsp.writeFile(
    path.join(dir, 'two-sum.json'),
    JSON.stringify({ slug: 'two-sum', fetchedAt: '2020-01-01T00:00:00.000Z', complete: false, question: TWO_SUM }),
    'utf8',
  );
  const cache = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async () => {
      throw new LeetCodeError('Could not reach LeetCode.', { kind: 'network' });
    },
  });
  const result = await cache.getContent('two-sum');
  assert.equal(result.stale, true);
  assert.equal(result.content.stale, true);
  assert.equal(result.content.title, 'Two Sum');
  assert.equal(result.content.fetchedAt, '2020-01-01T00:00:00.000Z');
  assert.ok(result.error instanceof LeetCodeError);

  await fsp.rm(dir, { recursive: true, force: true });
});

test('cache: a failed fetch with no entry propagates, and writes nothing', async () => {
  const dir = await tmpCache();
  const cache = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async () => {
      throw new LeetCodeError('Could not reach LeetCode.', { kind: 'network' });
    },
  });
  await assert.rejects(cache.getContent('two-sum'), (e) => e instanceof LeetCodeError);
  assert.deepEqual(await fsp.readdir(dir), [], 'a failure must never poison the cache');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('cache: a corrupt cache file is a miss, not a crash', async () => {
  const dir = await tmpCache();
  await fsp.writeFile(path.join(dir, 'two-sum.json'), '{"question":', 'utf8');
  const cache = new LeetCodeContentCache({ cacheDir: dir, fetchQuestionImpl: async () => TWO_SUM });
  const r = await cache.getContent('two-sum');
  assert.equal(r.fromCache, false);
  assert.equal(r.content.title, 'Two Sum');
  await fsp.rm(dir, { recursive: true, force: true });
});

test('cache: premium is cached like any other successful answer', async () => {
  const dir = await tmpCache();
  let calls = 0;
  const cache = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async () => {
      calls += 1;
      return MEETING_ROOMS;
    },
  });
  const a = await cache.getContent('meeting-rooms');
  const b = await cache.getContent('meeting-rooms');
  assert.equal(calls, 1);
  assert.equal(a.content.isPaidOnly, true);
  assert.equal(b.content.isPaidOnly, true);
  assert.equal(b.content.descriptionHtml, null);
  await fsp.rm(dir, { recursive: true, force: true });
});

test('cache: concurrent opens of the same slug share one fetch', async () => {
  const dir = await tmpCache();
  let calls = 0;
  const cache = new LeetCodeContentCache({
    cacheDir: dir,
    fetchQuestionImpl: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return TWO_SUM;
    },
  });
  const [a, b, c] = await Promise.all([
    cache.getContent('two-sum'),
    cache.getContent('two-sum'),
    cache.getContent('two-sum'),
  ]);
  assert.equal(calls, 1);
  assert.equal(a.content.title, 'Two Sum');
  assert.equal(b.content.title, 'Two Sum');
  assert.equal(c.content.title, 'Two Sum');
  await fsp.rm(dir, { recursive: true, force: true });
});
