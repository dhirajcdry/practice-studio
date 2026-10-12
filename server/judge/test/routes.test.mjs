// POST /api/submit/record: a submission the browser connector sent, recorded by the server.
// Nothing here touches the network; the server never talks to LeetCode on this route.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HttpError, sendError } from '../../http-util.mjs';
import { routes, handleRecord } from '../routes.mjs';
import { SessionLog } from '../../coach/sessions.mjs';
import { ACCEPTED_CHECK } from './helpers.mjs';

const CODE = 'class Solution:\n    def twoSum(self, nums, target):\n        return [0,1]\n';
let nextId = 3100000000;

async function withServer(ctx, fn) {
  const server = http.createServer((req, res) => {
    Promise.resolve(handleRecord(req, res, ctx)).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', 'unexpected');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    return await fn(async (body) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/submit/record`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    });
  } finally {
    server.close();
  }
}

async function freshCtx() {
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-record-'));
  return { homeRoot, sessionLog: new SessionLog({ root: homeRoot }), log: { warn() {} } };
}

test('the route table exposes exactly POST /api/submit/record', () => {
  assert.deepEqual(Object.keys(routes), ['POST /api/submit/record']);
});

const readMeta = async (root) => JSON.parse(await fsp.readFile(path.join(root, 'problems', 'two-sum', 'meta.json'), 'utf8'));

test('a judged browser submission comes back as the contract verdict and is recorded', async () => {
  const ctx = await freshCtx();
  const id = nextId++;
  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE, submissionId: id, check: ACCEPTED_CHECK });
    assert.equal(status, 200);
    assert.equal(json.accepted, true);
    assert.equal(json.passed, 64);
    assert.equal(json.submissionUrl, `https://leetcode.com/submissions/detail/${id}/`);
    assert.equal(json.recorded.meta, true);
  });
  const meta = await readMeta(ctx.homeRoot);
  assert.equal(meta.submissions.length, 1);
  assert.equal(meta.submissions[0].submissionId, String(id));
  assert.equal(await fsp.readFile(path.join(ctx.homeRoot, 'problems', 'two-sum', meta.submissions[0].codeFile), 'utf8'), CODE);
});

test('acceptance is status code 10 only, even when the browser sends the body', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    const { json } = await post({ slug: 'two-sum', code: CODE, submissionId: nextId++,
      check: { state: 'SUCCESS', status_code: 11, status_msg: 'Wrong Answer', run_success: true } });
    assert.equal(json.accepted, false);
    assert.equal(json.failure.kind, 'wrong_answer');
  });
});

test('recording the same submission twice writes it once', async () => {
  const ctx = await freshCtx();
  const id = nextId++;
  await withServer(ctx, async (post) => {
    assert.equal((await post({ slug: 'two-sum', code: CODE, submissionId: id, check: ACCEPTED_CHECK })).status, 200);
    const again = await post({ slug: 'two-sum', code: CODE, submissionId: id, check: ACCEPTED_CHECK });
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'ALREADY_RECORDED');
  });
  assert.equal((await readMeta(ctx.homeRoot)).submissions.length, 1);
});

test('a submission with no verdict yet records the code and event but no verdict', async () => {
  const ctx = await freshCtx();
  const id = nextId++;
  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE, submissionId: id, check: null });
    assert.equal(status, 200);
    assert.equal(json.recorded.meta, false);
  });
  await assert.rejects(readMeta(ctx.homeRoot), { code: 'ENOENT' });
  assert.equal(await fsp.readFile(path.join(ctx.homeRoot, 'problems', 'two-sum', 'submissions', `${id}.py`), 'utf8'), CODE);
});

test('malformed record requests are refused and write nothing', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    assert.equal((await post({ code: CODE, submissionId: nextId++, check: ACCEPTED_CHECK })).status, 400);
    assert.equal((await post({ slug: 'two-sum', submissionId: nextId++, check: ACCEPTED_CHECK })).status, 400);
    assert.equal((await post({ slug: 'two-sum', code: CODE, submissionId: '../x', check: ACCEPTED_CHECK })).status, 400);
    assert.equal((await post({ slug: 'two-sum', code: CODE, submissionId: nextId++, check: { state: 'STARTED' } })).status, 400);
  });
  await assert.rejects(fsp.readdir(path.join(ctx.homeRoot, 'problems')), { code: 'ENOENT' });
});

test('a slug outside the catalog is refused', async () => {
  const ctx = { ...(await freshCtx()), catalog: { get: () => null } };
  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'not-a-problem', code: CODE, submissionId: nextId++, check: ACCEPTED_CHECK });
    assert.equal(status, 404);
    assert.equal(json.error.code, 'PROBLEM_NOT_FOUND');
  });
});

test('meta.json is merged, never clobbered', async () => {
  const ctx = await freshCtx();
  const dir = path.join(ctx.homeRoot, 'problems', 'two-sum');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    schemaVersion: 1, slug: 'two-sum', title: 'Two Sum', firstSeen: '2026-07-01', handWrittenNote: 'keep me',
    submissions: [{ at: '2026-07-01', verdict: 'Accepted', note: 'by hand' }],
  }), 'utf8');
  const id = nextId++;
  await withServer(ctx, async (post) => {
    assert.equal((await post({ slug: 'two-sum', code: CODE, submissionId: id, check: ACCEPTED_CHECK })).status, 200);
  });
  const meta = await readMeta(ctx.homeRoot);
  assert.equal(meta.handWrittenNote, 'keep me');
  assert.equal(meta.firstSeen, '2026-07-01');
  assert.equal(meta.submissions.length, 2);
  assert.equal(meta.submissions[0].note, 'by hand');
  assert.equal(meta.submissions[1].submissionId, String(id));
});

test('an unparseable meta.json is left untouched and the verdict still comes back', async () => {
  const ctx = await freshCtx();
  const warnings = [];
  ctx.log = { warn: (line) => warnings.push(line) };
  const dir = path.join(ctx.homeRoot, 'problems', 'two-sum');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), '{ "submissions": [ {', 'utf8');
  await withServer(ctx, async (post) => {
    const { status, json } = await post({ slug: 'two-sum', code: CODE, submissionId: nextId++, check: ACCEPTED_CHECK });
    assert.equal(status, 200);
    assert.equal(json.accepted, true, 'a recording problem must not hide the verdict');
    assert.equal(json.recorded.meta, false);
  });
  assert.equal(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'), '{ "submissions": [ {');
  assert.match(warnings.join('\n'), /could not be parsed/);
});
