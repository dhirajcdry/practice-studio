// Premium problems judged on neetcode.io: verdict shaping and recording.
// Pure functions and a local HTTP server only. Nothing here talks to NeetCode.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HttpError, sendError } from '../../http-util.mjs';
import { handleRecord, neetcodeSubmissionId } from '../routes.mjs';
import { buildNeetCodeVerdict, NEETCODE_DETAILS_MAX } from '../verdict.mjs';
import { SessionLog } from '../../coach/sessions.mjs';
import { readProblemDir, statusOf } from '../../stats/aggregate.mjs';

const CODE = 'class Solution:\n    def validTree(self, n, edges):\n        return True\n';
const URL_ = 'https://neetcode.io/problems/valid-tree/history?submissionIndex=3';

/** What the Connector scraped from the live Accepted verdict on 2026-10-15. */
const ACCEPTED_RESULT = Object.freeze({
  status: 'Accepted', accepted: true, passed: 34, total: 34, memory: '8 MB', time: '28ms', details: '', url: URL_,
});

test('the observed NeetCode Accepted result maps to the contract verdict', () => {
  const v = buildNeetCodeVerdict(ACCEPTED_RESULT, 'nc-1');
  assert.deepEqual(v, {
    ok: true, accepted: true, verdict: 'Accepted', statusCode: null,
    passed: 34, total: 34, runtime: '28ms', memory: '8 MB',
    runtimePercentile: null, memoryPercentile: null,
    submissionId: 'nc-1', submissionUrl: URL_, source: 'neetcode', failure: null,
  });
});

test('only the exact text "Accepted" is an acceptance', () => {
  for (const status of ['accepted', 'Accepted ', 'Not Accepted', 'Wrong Answer', 'Accepted?', '']) {
    const v = buildNeetCodeVerdict({ ...ACCEPTED_RESULT, status, accepted: true }, 'nc-2');
    // "Accepted " is trimmed to "Accepted" by the scrape rule, so it is the one exception.
    assert.equal(v.accepted, status === 'Accepted ', `"${status}"`);
  }
});

test('the page saying accepted:true never overrides the status text', () => {
  const v = buildNeetCodeVerdict({ ...ACCEPTED_RESULT, status: 'Wrong Answer', accepted: true }, 'nc-3');
  assert.equal(v.accepted, false);
  assert.equal(v.failure.kind, 'wrong_answer');
});

test('a failure carries NeetCode\'s own console text verbatim, capped', () => {
  const details = 'Input:\nn=5, edges=[[0,1]]\nYour Output:\ntrue\nExpected output:\nfalse';
  const v = buildNeetCodeVerdict({ ...ACCEPTED_RESULT, status: 'Wrong Answer', passed: 12, total: 34, details }, 'nc-4');
  assert.equal(v.verdict, 'Wrong Answer');
  assert.equal(v.passed, 12);
  assert.equal(v.failure.consoleOutput, details);
  assert.equal(v.failure.message, null);
  const long = buildNeetCodeVerdict({ status: 'Runtime Error', details: 'x'.repeat(9000) }, 'nc-5');
  assert.equal(long.failure.consoleOutput.length, NEETCODE_DETAILS_MAX);
  assert.equal(long.failure.kind, 'runtime_error');
  assert.equal(buildNeetCodeVerdict({ status: 'Compilation Error' }, 'nc-6').failure.kind, 'compile_error');
  assert.equal(buildNeetCodeVerdict({ status: 'Time Limit Exceeded' }, 'nc-7').failure.kind, 'time_limit');
  assert.equal(buildNeetCodeVerdict({ status: 'Something New' }, 'nc-8').failure.kind, 'other');
});

test('missing fields stay missing and foreign links are dropped', () => {
  const v = buildNeetCodeVerdict({ status: 'Accepted', passed: '34', url: 'https://evil.example/' }, 'nc-9');
  assert.equal(v.passed, null);
  assert.equal(v.total, null);
  assert.equal(v.runtime, null);
  assert.equal(v.submissionUrl, null);
});

test('synthetic ids are unique and sortable', () => {
  const a = neetcodeSubmissionId(1000);
  const b = neetcodeSubmissionId(1000);
  assert.match(a, /^nc-\d+$/);
  assert.notEqual(a, b);
  assert.ok(Number(b.slice(3)) > Number(a.slice(3)));
});

/* ------------------------------ the record route ------------------------------ */

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
  const homeRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-judge-neetcode-'));
  return { homeRoot, sessionLog: new SessionLog({ root: homeRoot }), log: { warn() {} } };
}

const problemDir = (root) => path.join(root, 'problems', 'graph-valid-tree');
const readMeta = async (root) => JSON.parse(await fsp.readFile(path.join(problemDir(root), 'meta.json'), 'utf8'));

async function readEvents(root) {
  const dir = path.join(problemDir(root), 'sessions');
  const out = [];
  for (const name of await fsp.readdir(dir)) {
    const text = await fsp.readFile(path.join(dir, name), 'utf8');
    for (const line of text.split('\n')) if (line.trim()) out.push(JSON.parse(line));
  }
  return out;
}

let nextRequest = 0;
const req = (over = {}) => ({
  source: 'neetcode', slug: 'graph-valid-tree', code: CODE, result: ACCEPTED_RESULT, requestId: `studio-test-${nextRequest += 1}`, ...over,
});

test('an accepted NeetCode result is recorded: code, both events and meta.json', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    const { status, json } = await post(req());
    assert.equal(status, 200);
    assert.equal(json.accepted, true);
    assert.equal(json.source, 'neetcode');
    assert.match(json.submissionId, /^nc-\d+$/);
    assert.equal(json.submissionUrl, URL_);
    assert.equal(json.recorded.meta, true);
    assert.equal(json.recorded.sessionEvents, true);
  });
  const meta = await readMeta(ctx.homeRoot);
  assert.equal(meta.submissions.length, 1);
  const entry = meta.submissions[0];
  assert.equal(entry.source, 'neetcode');
  assert.equal(entry.verdict, 'Accepted');
  assert.equal(entry.accepted, true);
  assert.equal(entry.testsPassed, 34);
  assert.equal(entry.runtimeMs, 28);
  assert.equal(entry.memoryMb, 8);
  assert.equal(entry.submissionUrl, URL_);
  assert.match(entry.submissionId, /^nc-\d+$/);
  assert.equal(await fsp.readFile(path.join(problemDir(ctx.homeRoot), entry.codeFile), 'utf8'), CODE);

  const events = await readEvents(ctx.homeRoot);
  const submitted = events.find((e) => e.type === 'submitted');
  const verdict = events.find((e) => e.type === 'verdict');
  assert.equal(submitted.data.source, 'neetcode');
  assert.equal(verdict.data.source, 'neetcode');
  assert.equal(verdict.data.accepted, true);
});

test('stats count an accepted NeetCode verdict as accepted', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    assert.equal((await post(req())).status, 200);
  });
  const record = await readProblemDir(ctx.homeRoot, 'graph-valid-tree');
  assert.equal(statusOf(record), 'accepted');
  assert.ok(record.accepted, 'an accepted verdict was found');
});

test('a NeetCode wrong answer is recorded as not accepted', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    const { json } = await post(req({ result: { ...ACCEPTED_RESULT, status: 'Wrong Answer', accepted: true, passed: 3 } }));
    assert.equal(json.accepted, false);
    assert.equal(json.failure.kind, 'wrong_answer');
  });
  const meta = await readMeta(ctx.homeRoot);
  assert.equal(meta.submissions[0].accepted, false);
});

test('clicked but no verdict: the code and submitted event only', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    const { status, json } = await post(req({ result: null, url: URL_ }));
    assert.equal(status, 200);
    assert.equal(json.recorded.meta, false);
    assert.equal(json.submissionUrl, URL_);
  });
  await assert.rejects(readMeta(ctx.homeRoot), { code: 'ENOENT' });
  const events = await readEvents(ctx.homeRoot);
  assert.deepEqual(events.map((e) => e.type), ['submitted']);
});

test('the same click recorded twice writes it once', async () => {
  const ctx = await freshCtx();
  const body = req();
  await withServer(ctx, async (post) => {
    assert.equal((await post(body)).status, 200);
    const again = await post(body);
    assert.equal(again.status, 409);
    assert.equal(again.json.error.code, 'ALREADY_RECORDED');
  });
  assert.equal((await readMeta(ctx.homeRoot)).submissions.length, 1);
});

test('malformed NeetCode record requests are refused and write nothing', async () => {
  const ctx = await freshCtx();
  await withServer(ctx, async (post) => {
    assert.equal((await post(req({ slug: '' }))).status, 400);
    assert.equal((await post(req({ code: '  ' }))).status, 400);
    assert.equal((await post(req({ result: { passed: 3 } }))).status, 400);
    assert.equal((await post(req({ result: ['Accepted'] }))).status, 400);
    assert.equal((await post(req({ requestId: 42 }))).status, 400);
  });
  await assert.rejects(fsp.readdir(path.join(ctx.homeRoot, 'problems')), { code: 'ENOENT' });
});

test('a NeetCode failing input becomes a Studio test case', async () => {
  const { neetcodeInputToTestcase, buildNeetCodeVerdict } = await import('../verdict.mjs');
  assert.equal(neetcodeInputToTestcase('n=5\nedges=[[0,1],[1,3],[3,0],[2,4]]'), '5\n[[0,1],[1,3],[3,0],[2,4]]');
  assert.equal(neetcodeInputToTestcase('s = "a=b"'), '"a=b"');
  assert.equal(neetcodeInputToTestcase('[1,2]'), '[1,2]');
  assert.equal(neetcodeInputToTestcase(''), null);

  const verdict = buildNeetCodeVerdict({
    status: 'Wrong Answer', passed: 4, total: 34,
    input: 'n=5\nedges=[[0,1],[1,3],[3,0],[2,4]]', output: 'true', expected: 'false', details: 'console text',
  }, 'nc-1');
  assert.equal(verdict.failure.lastTestcase, '5\n[[0,1],[1,3],[3,0],[2,4]]');
  assert.equal(verdict.failure.output, 'true');
  assert.equal(verdict.failure.expectedOutput, 'false');
  assert.equal(verdict.failure.consoleOutput, null);
});
