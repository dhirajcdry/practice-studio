// Its own file so the scratch home is set before any module reads it: creating the app
// arms listeners on the default root, and a test must never point those at real data.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-report-difficulty-app-'));
process.env.STUDIO_HOME = root;
delete process.env.STUDIO_MIRROR_DIR;
const { createApp } = await import('../app.mjs');
const { readReportDifficulty } = await import('./report-difficulty.mjs');

test('report difficulty routes are registered on the app, behind the loopback guard', async t => {
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const catalog = { problems: [], patterns: [], get() { return null; } };
  const server = http.createServer(createApp({ catalog, solutions: {}, leetcode: {}, site: {}, log: { warn() {}, error() {} }, homeRoot: root }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}/api/report/difficulty`;
  const put = (difficulty, headers = {}) => fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ difficulty }) });
  assert.deepEqual(await (await fetch(url)).json(), { difficulty: 'beginner' });
  assert.deepEqual(await (await put('mid-level')).json(), { difficulty: 'mid-level' });
  assert.equal((await put('hard')).status, 400);
  assert.equal((await put('beginner', { origin: 'https://evil.example' })).status, 403);
  assert.equal(await readReportDifficulty(root), 'mid-level');
});
