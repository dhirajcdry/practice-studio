import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { routes, handleGetStats } from '../routes.mjs';

/** A node:http response stand-in that records exactly what a handler sent. */
function fakeRes() {
  return {
    statusCode: null,
    headers: null,
    body: null,
    headersSent: false,
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(payload) {
      this.body = payload ? payload.toString('utf8') : '';
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-stats-routes-'));
}

const CATALOG = {
  patterns: ['Arrays & Hashing'],
  problems: [
    { slug: 'two-sum', title: 'Two Sum', number: 1, pattern: 'Arrays & Hashing', difficulty: 'Easy', lists: { blind75: true, neetcode150: true, neetcode250: true } },
  ],
};

test('the route table exports exactly the contract endpoint', () => {
  assert.deepEqual(Object.keys(routes), ['GET /api/stats']);
  assert.equal(routes['GET /api/stats'], handleGetStats);
});

test('GET /api/stats answers 200 JSON with no-store, matching the server envelope', async () => {
  const root = await tempRoot();
  const res = fakeRes();
  await handleGetStats({ method: 'GET', url: '/api/stats', headers: {} }, res, { homeRoot: root, catalog: CATALOG });

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /^application\/json/);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');

  const body = res.json();
  assert.equal(body.workspace.exists, false);
  assert.equal(body.curriculum.problems, 1);
  assert.ok(Array.isArray(body.patterns));
  assert.ok(Array.isArray(body.warnings));
});

test('the absolute home path never leaves the machine in the payload', async () => {
  const root = await tempRoot();
  const res = fakeRes();
  await handleGetStats({}, res, { homeRoot: root, catalog: CATALOG });
  assert.equal(res.json().workspace.root, '~/LeetCodeTutor');
  assert.ok(!res.body.includes(root), 'the real filesystem path must not appear anywhere in the response');
});

test('the handler works against a bare ctx — no catalog, no paths', async () => {
  const res = fakeRes();
  await handleGetStats({}, res, {});
  assert.equal(res.statusCode, 200);
  const body = res.json();
  // With no catalog there are no denominators, and it says so rather than inventing any.
  assert.equal(body.curriculum.available, false);
});

test('ctx.paths.HOME_ROOT is honoured when ctx.homeRoot is absent', async () => {
  const root = await tempRoot();
  await fsp.mkdir(path.join(root, 'problems', 'two-sum', 'sessions'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'problems', 'two-sum', 'sessions', 's1.jsonl'),
    `${JSON.stringify({ at: '2026-07-25T10:00:00.000-04:00', type: 'problem_opened' })}\n`,
    'utf8',
  );

  const res = fakeRes();
  await handleGetStats({}, res, { paths: { HOME_ROOT: root }, catalog: CATALOG });
  const body = res.json();
  assert.equal(body.workspace.problemDirs, 1);
  assert.equal(body.totals.attempted, 1);
});

test('a truncated log still yields a 200 — a bad line can never take the endpoint down', async () => {
  const root = await tempRoot();
  const dir = path.join(root, 'problems', 'two-sum', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(dir + '/s1.jsonl', '{"at":"2026-07-25T10:00:00.000-04:00","type":"problem_op', 'utf8');

  const res = fakeRes();
  await handleGetStats({}, res, { homeRoot: root, catalog: CATALOG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().workspace.skippedLines, 1);
});
