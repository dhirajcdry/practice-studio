// The route table: POST /api/submit through a real node:http server, stubbed fetch.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HttpError, sendError } from '../../http-util.mjs';
import { routes, handleSubmit } from '../routes.mjs';
import { SessionLog } from '../../coach/sessions.mjs';
import { ACCEPTED_CHECK, htmlResponse, jsonResponse, keychainWith, stubFetch } from './helpers.mjs';

const CODE = 'class Solution:\n    def twoSum(self, nums, target):\n        return [0,1]\n';

async function withServer(ctx, fn) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleSubmit(req, res, ctx)).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', 'unexpected');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    });
  } finally {
    server.close();
  }
}

function baseCtx(fetchImpl, homeRoot) {
  return {
    homeRoot,
    sessionLog: new SessionLog({ root: homeRoot }),
    questionIds: { get: async () => '1' },
    judgeOverrides: {
      fetchImpl,
      execFileImpl: keychainWith(),
      sleep: async () => {},
    },
  };
}

test('the route table exposes exactly POST /api/submit', () => {
  assert.deepEqual(Object.keys(routes), ['POST /api/submit']);
});

test('a successful submit returns the contract payload', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-routes-'));
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 2081220750 }),
    '/check/': jsonResponse(ACCEPTED_CHECK),
  });
  await withServer(baseCtx(fetchImpl, root), async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.accepted, true);
    assert.equal(json.submissionUrl, 'https://leetcode.com/submissions/detail/2081220750/');
    assert.equal(json.failure, null);
  });
});

test('an expired session is a 401 SESSION_EXPIRED error envelope', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-routes-'));
  const fetchImpl = stubFetch({ '/submit/': htmlResponse('<html>sign in</html>', { status: 403 }) });
  await withServer(baseCtx(fetchImpl, root), async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE });
    assert.equal(status, 401);
    assert.equal(json.error.code, 'SESSION_EXPIRED');
    assert.match(json.error.message, /re-paste/i);
  });
});

test('a poll timeout is a 504 whose envelope names the submission', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-routes-'));
  const fetchImpl = stubFetch({
    '/submit/': jsonResponse({ submission_id: 555 }),
    '/check/': jsonResponse({ state: 'STARTED' }),
  });
  let clock = 0;
  const ctx = baseCtx(fetchImpl, root);
  ctx.judgeOverrides.now = () => (clock += 3000);
  ctx.judgeOverrides.pollOptions = { ceilingMs: 9000 };

  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE });
    assert.equal(status, 504);
    assert.equal(json.error.code, 'JUDGE_TIMEOUT');
    assert.equal(json.error.submissionId, 555);
    assert.equal(json.error.submissionUrl, 'https://leetcode.com/submissions/detail/555/');
  });
  assert.equal(fetchImpl.countOf('/submit/'), 1);
});

test('a slug outside the catalog is refused before any network call', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-routes-'));
  const fetchImpl = stubFetch({});
  const ctx = { ...baseCtx(fetchImpl, root), catalog: { get: () => null } };
  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'not-a-problem', code: CODE });
    assert.equal(status, 404);
    assert.equal(json.error.code, 'PROBLEM_NOT_FOUND');
  });
  assert.equal(fetchImpl.calls.length, 0);
});

test('a body with no slug or no code is a 400 and submits nothing', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-routes-'));
  const fetchImpl = stubFetch({});
  await withServer(baseCtx(fetchImpl, root), async (post) => {
    assert.equal((await post({ code: CODE })).status, 400);
    assert.equal((await post({ slug: 'two-sum' })).status, 400);
  });
  assert.equal(fetchImpl.calls.length, 0);
});
