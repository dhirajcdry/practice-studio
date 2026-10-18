// Tutor tools end to end over real HTTP: a Claude turn whose fake CLI starts the real
// studio-mcp.mjs and calls back into POST /api/coach/tools/call, a Codex turn whose fake
// app-server asks for a browser action the "page" (this test) answers, plus the result
// and undo routes, and the token dying with its turn.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { routes, CoachService } from '../routes.mjs';
import { createUpkeepQueue } from '../upkeep.mjs';
import { readTurns } from '../transcript.mjs';
import { readCases } from '../../runner/cases.mjs';
import { HttpError, sendError } from '../../http-util.mjs';
import { workspace } from './tools-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'bin', 'fake-claude.mjs');
const FAKE_CODEX = path.join(HERE, 'bin', 'fake-codex.mjs');

/** The router's dispatch, `:param` segments included, and nothing more. */
function serverFor(coach) {
  const table = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ');
    return { method, parts: pattern.split('/').filter(Boolean), handler };
  });
  return http.createServer((req, res) => {
    const segments = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean);
    for (const route of table) {
      if (route.method !== req.method || route.parts.length !== segments.length) continue;
      const params = {};
      if (!route.parts.every((p, i) => (p.startsWith(':') ? (params[p.slice(1)] = segments[i], true) : p === segments[i]))) continue;
      Promise.resolve(route.handler(req, res, { coach, params })).catch((err) => {
        if (res.headersSent) return res.end();
        if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
        return sendError(res, 500, 'INTERNAL_ERROR', String(err));
      });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'no such route');
  });
}

async function fixture(t, { provider = 'claude', env = {} } = {}) {
  const w = await workspace();
  t.after(w.cleanup);
  await fsp.writeFile(path.join(w.root, 'coach-settings.json'),
    JSON.stringify(provider === 'codex' ? { provider: 'codex', model: 'gpt-6-astra' } : { provider: 'claude', model: 'default' }));
  const coach = new CoachService({
    root: w.root, binary: FAKE_CLAUDE, timeoutMs: 15_000, log: { warn() {}, error() {}, info() {} },
    env: { ...process.env, ...env },
  });
  const server = serverFor(coach);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { root: w.root, coach, base: `http://127.0.0.1:${server.address().port}` };
}

const post = async (base, route, body) => {
  const res = await fetch(base + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
};

/** Read SSE events as they arrive, calling `onEvent` for each. */
async function stream(response, onEvent = () => {}) {
  const events = [];
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true });
    let end;
    while ((end = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, end);
      buf = buf.slice(end + 2);
      const name = block.split('\n').find((l) => l.startsWith('event: '))?.slice(7);
      if (!name) continue;
      const data = JSON.parse(block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'));
      events.push({ event: name, data });
      await onEvent({ event: name, data });
    }
  }
  return events;
}

const ask = (base, message) => fetch(`${base}/api/coach/message`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'two-sum', message }),
});

test('Claude: studio tools reach Studio through the MCP bridge; the token dies with the turn', async (t) => {
  const f0 = await workspace();
  t.after(f0.cleanup);
  const results = path.join(f0.root, 'claude-results.jsonl');
  const f = await fixture(t, { env: {
    FAKE_CLAUDE_MODE: 'tools',
    FAKE_CLAUDE_TOOL_RESULTS_FILE: results,
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { tool: 'get_state', arguments: {} },
      { tool: 'add_case', arguments: { input: { nums: [5, 5], target: 10 }, expected: [0, 1], why: 'Duplicates that sum to target' } },
    ]),
  } });

  const events = await stream(await ask(f.base, 'give me an edge case'));
  assert.equal(events.at(-1).event, 'done', JSON.stringify(events.at(-1)));
  const action = events.find((e) => e.event === 'action').data;
  assert.equal(action.tool, 'add_case');
  assert.equal(action.refresh, 'cases');
  assert.equal(action.select, 3);
  assert.equal(action.status, 'done');
  // The tool lines show plain names, as they do for Codex.
  assert.deepEqual(events.filter((e) => e.event === 'tool').map((e) => e.data.name), ['get_state', 'add_case']);
  assert.match(events.filter((e) => e.event === 'token').map((e) => e.data.text).join(''), /Parameters, in order: nums, target/);

  const lines = (await fsp.readFile(results, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const { token, url, configPath } = lines[0];
  assert.match(url, new RegExp(`^${f.base}/api/coach/tools/call$`));
  assert.deepEqual(lines[2].tools.length, 10);
  assert.equal(lines[4].result.isError, false);
  assert.deepEqual((await readCases({ root: f.root, slug: 'two-sum' })).map((c) => c.input), ['[5,5]\n10']);

  // After the turn: no token, no config file, and a replayed call is refused.
  assert.equal(f.coach.toolTokens.size, 0);
  await assert.rejects(fsp.stat(configPath), { code: 'ENOENT' });
  const replay = await post(f.base, '/api/coach/tools/call', { token, tool: 'get_state', arguments: {} });
  assert.equal(replay.status, 403);
  assert.equal((await post(f.base, '/api/coach/tools/call', { token: 'x', tool: 'get_state' })).status, 403);

  // The turn record keeps the receipts.
  const [turn] = await readTurns({ root: f.root, slug: 'two-sum' });
  assert.deepEqual(turn.actions, [{ id: action.id, tool: 'add_case', summary: action.summary, ok: true }]);

  // Undo through the route, once.
  const undone = await post(f.base, `/api/coach/actions/${action.id}/undo`, {});
  assert.deepEqual(undone, { status: 200, json: { ok: true, refresh: 'cases' } });
  assert.deepEqual(await readCases({ root: f.root, slug: 'two-sum' }), []);
  const again = await post(f.base, `/api/coach/actions/${action.id}/undo`, {});
  assert.equal(again.status, 409);
  assert.match(again.json.error.message, /already undone/);
  assert.equal((await post(f.base, '/api/coach/actions/act-missing/undo', {})).status, 404);
});

test('Codex: a browser action is answered by the page through the result route', async (t) => {
  const f0 = await workspace();
  t.after(f0.cleanup);
  const results = path.join(f0.root, 'codex-results.jsonl');
  const prior = process.env.STUDIO_CODEX_BINARY;
  process.env.STUDIO_CODEX_BINARY = FAKE_CODEX;
  t.after(() => { if (prior === undefined) delete process.env.STUDIO_CODEX_BINARY; else process.env.STUDIO_CODEX_BINARY = prior; });
  const f = await fixture(t, { provider: 'codex', env: {
    FAKE_CODEX_TOOL_RESULTS_FILE: results,
    FAKE_CODEX_TOOL_CALLS: JSON.stringify([
      { tool: 'mark_lines', arguments: { from: 5, note: 'Check before you store.', tone: 'hint' } },
      { tool: 'run_code', arguments: { cases: [1] } },
    ]),
  } });

  const answers = [];
  const events = await stream(await ask(f.base, 'where is my bug?'), async ({ event, data }) => {
    if (event !== 'action' || data.status !== 'pending') return;
    assert.equal(data.needsAck, true);
    answers.push(await post(f.base, `/api/coach/actions/${data.id}/result`, { ok: true, message: 'Marked.' }));
    // A second answer to the same action is refused.
    answers.push(await post(f.base, `/api/coach/actions/${data.id}/result`, { ok: true }));
  });
  assert.equal(events.at(-1).event, 'done');
  assert.deepEqual(answers.map((a) => a.status), [200, 409]);

  const statuses = events.filter((e) => e.event === 'action').map((e) => [e.data.tool, e.data.status]);
  assert.deepEqual(statuses, [['mark_lines', 'pending'], ['mark_lines', 'done'], ['run_code', 'done']]);
  const runAction = events.filter((e) => e.event === 'action').at(-1).data;
  assert.equal(runAction.run.summary.passed, 1);

  const responses = (await fsp.readFile(results, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(responses[0].result.success, true);
  assert.match(responses[0].result.contentItems[0].text, /Marked line 5/);
  assert.match(responses[1].result.contentItems[0].text, /Case 1 — passed/);

  const [turn] = await readTurns({ root: f.root, slug: 'two-sum' });
  assert.deepEqual(turn.actions.map((a) => [a.tool, a.ok]), [['mark_lines', true], ['run_code', true]]);
  assert.deepEqual(turn.tools, ['mark_lines Check before you store.', 'run_code']);

  assert.equal((await post(f.base, '/api/coach/actions/act-missing/result', { ok: true })).status, 404);
  assert.equal((await post(f.base, `/api/coach/actions/${runAction.id}/result`, { ok: 'yes' })).status, 400);
  const notUndoable = await post(f.base, `/api/coach/actions/${runAction.id}/undo`, {});
  assert.equal(notUndoable.status, 400);
});

test('the memory upkeep step is never given studio tools', async () => {
  let opts;
  const queue = createUpkeepQueue({ runner: (o) => { opts = o; return { exited: Promise.resolve() }; }, logger: { info() {}, warn() {} } });
  queue.enqueue({ root: 'r', slug: 'two-sum', sessionId: 's' });
  await new Promise((r) => setImmediate(r));
  assert.ok(opts);
  assert.equal(opts.mcpConfigPath, undefined);
  assert.equal(opts.studioTools, undefined);
  assert.equal(opts.toolSession, undefined);
});
