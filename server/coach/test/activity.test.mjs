import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOL_SPECS, toolDisplay } from '../tools.mjs';
import { createWorkspaceTools } from '../workspace-tools.mjs';
import { CoachRuns } from '../runs.mjs';
import { SseStream } from '../sse.mjs';
import { handleHistory } from '../routes.mjs';
import { appendTurn } from '../transcript.mjs';

function complete(spec) {
  assert.equal(typeof spec.display.doing, 'string', spec.name);
  assert.ok(spec.display.doing.length > 5, spec.name);
  assert.ok(spec.display.done.length > 5, spec.name);
  assert.ok(['read', 'change', 'note', 'handoff'].includes(spec.display.effect), spec.name);
}
test('every shared and workspace-exposed tool has explicit complete display metadata', async t => {
  TOOL_SPECS.forEach(complete);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-display-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const kind of ['coding', 'board', 'review', 'code']) for (const liveMock of [false, true]) {
    const tools = await createWorkspaceTools({ root, slug: 'two-sum', kind, liveMock, getState: async () => ({}), runCode: async () => ({}), sessionContext: {}, setProblem: async () => ({}) });
    try { tools.options.toolSpecs.forEach(complete); } finally { await tools.dispose(); }
  }
  for (const name of ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch']) complete({ name, display: toolDisplay(name) });
  assert.equal(toolDisplay('secret_tool').done, 'Used a tool');
  assert.deepEqual(toolDisplay('mcp__studio__save_note'), toolDisplay('save_note'));
});
test('live and replay tool events carry identical display and timestamps, without sockets', () => {
  let now = Date.parse('2025-01-01T10:00:00Z');
  const runs = new CoachRuns({ now: () => now });
  const run = runs.start({ slug: 'two-sum' });
  const output = [];
  const stream = new SseStream({ writeHead() {}, write: text => output.push(text), end() {} });
  runs.attach(run, stream);
  now += 2000; runs.tool(run, 'Read', 'private/path');
  const live = output.find(text => text.startsWith('event: tool'));
  const wire = JSON.parse(live.split('data: ')[1]);
  assert.deepEqual(wire, { name: 'Read', summary: 'private/path', at: '2025-01-01T10:00:02.000Z', display: toolDisplay('Read') });
  const replay = [];
  runs.attach(run, new SseStream({ writeHead() {}, write: text => replay.push(text), end() {} }));
  assert.equal(replay.find(text => text.startsWith('event: tool')), live);
  const action = { id: 'change', tool: 'add_case', status: 'pending' };
  runs.action(run, action); action.status = 'done';
  assert.equal(run.actions[0].status, 'done', 'the registry retains durable live action updates');
  assert.equal(run.actions[0].display.effect, 'change');
  now += 3000; runs.finish(run, { status: 'done' });
  const done = JSON.parse(output.find(text => text.startsWith('event: done')).split('data: ')[1]);
  assert.equal(done.durationMs, 5000);
});
test('history route normalizes every turn including legacy and empty activity', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-history-display-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  for (const tools of [[], ['mcp__studio__read_memory hidden/path']]) await appendTurn({ root, slug: 'two-sum', turn: { sessionId: 'fixture', ask: 'Why?', answer: 'A fixture.', tools } });
  let body = '';
  await handleHistory({}, { writeHead() {}, end(text) { body = text; } }, { homeRoot: root, params: { slug: 'two-sum' } });
  const turns = JSON.parse(body).threads[0].turns;
  assert.deepEqual(turns[0].activity, []);
  assert.equal(turns[1].activity[0].display.done, 'Read its notes');
});

test('a record keeps tool, effect and duration for each step, never wording or arguments', async () => {
  const { storedActivity } = await import('../transcript.mjs');
  const stored = storedActivity([{ tool: 'mcp__studio__get_submissions', summary: 'private/path', at: 1000 }, { tool: 'save_note', at: 3000 }], 3500);
  assert.deepEqual(stored, [{ tool: 'get_submissions', effect: 'read', ms: 2000 }, { tool: 'save_note', effect: 'note', ms: 500 }]);
  assert.deepEqual(storedActivity([{ tool: 'unknown_tool' }]), [{ tool: 'unknown_tool', effect: 'read' }]);
});

test('the page can resolve every tool name to wording from one table', async () => {
  const { toolDisplayTable } = await import('../tools.mjs');
  const table = toolDisplayTable();
  for (const spec of TOOL_SPECS) assert.deepEqual(table.tools[spec.name], spec.display);
  for (const name of ['Read', 'WebSearch', 'save_recall_note']) assert.ok(table.tools[name].done);
  assert.ok(table.unknown.done && !/tool_|mcp__/.test(table.unknown.done));
});
