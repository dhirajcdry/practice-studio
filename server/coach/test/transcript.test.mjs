import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { appendTurn, readTurns, readThreads, chatFile } from '../transcript.mjs';

async function workspace() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-tx-'));
  return root;
}

const turn = (over = {}) => ({ sessionId: 's1', kind: 'question', ask: 'why?', answer: 'because', ...over });

test('a turn round-trips through the file', async () => {
  const root = await workspace();
  const result = await appendTurn({ root, slug: 'two-sum', turn: turn() });
  assert.equal(result.written, true);

  const turns = await readTurns({ root, slug: 'two-sum' });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].ask, 'why?');
  assert.equal(turns[0].answer, 'because');
  assert.match(turns[0].at, /^\d{4}-\d{2}-\d{2}T/);
});

test('a turn where nothing was said either way is not recorded', async () => {
  const root = await workspace();
  const result = await appendTurn({ root, slug: 'two-sum', turn: turn({ ask: '  ', answer: '' }) });
  assert.equal(result.written, false);
  assert.deepEqual(await readTurns({ root, slug: 'two-sum' }), []);
});

test('a review with no typed question is still recorded, because the answer is the point', async () => {
  const root = await workspace();
  const result = await appendTurn({ root, slug: 'two-sum', turn: turn({ ask: '', kind: 'attempt-review', answer: 'Verdict: pass.' }) });
  assert.equal(result.written, true);
  const [only] = await readTurns({ root, slug: 'two-sum' });
  assert.equal(only.kind, 'attempt-review');
});

test('a torn line is skipped, and the turns around it survive', async () => {
  const root = await workspace();
  await appendTurn({ root, slug: 'two-sum', turn: turn({ ask: 'first' }) });
  await fsp.appendFile(chatFile(root, 'two-sum'), '{"ask":"half-writ\n');
  await appendTurn({ root, slug: 'two-sum', turn: turn({ ask: 'third' }) });

  const turns = await readTurns({ root, slug: 'two-sum' });
  assert.deepEqual(turns.map((t) => t.ask), ['first', 'third']);
});

test('turns group into threads by session, newest thread first', async () => {
  const root = await workspace();
  await appendTurn({ root, slug: 'two-sum', turn: turn({ sessionId: 'old', ask: 'a', at: '2026-07-25T10:00:00-04:00' }) });
  await appendTurn({ root, slug: 'two-sum', turn: turn({ sessionId: 'old', ask: 'b', at: '2026-07-25T10:05:00-04:00' }) });
  await appendTurn({ root, slug: 'two-sum', turn: turn({ sessionId: 'new', ask: 'c', at: '2026-07-26T09:00:00-04:00' }) });

  const threads = await readThreads({ root, slug: 'two-sum' });
  assert.deepEqual(threads.map((t) => t.sessionId), ['new', 'old']);
  assert.deepEqual(threads[1].turns.map((t) => t.ask), ['a', 'b']);
  assert.equal(threads[1].startedAt, '2026-07-25T10:00:00-04:00');
  assert.equal(threads[1].endedAt, '2026-07-25T10:05:00-04:00');
});

test('turns with no session id each stand alone rather than merging', async () => {
  // Two unrelated conversations from before ids were recorded must not be shown as one.
  const root = await workspace();
  await appendTurn({ root, slug: 'two-sum', turn: turn({ sessionId: null, ask: 'a', at: '2026-07-25T10:00:00-04:00' }) });
  await appendTurn({ root, slug: 'two-sum', turn: turn({ sessionId: null, ask: 'b', at: '2026-07-25T11:00:00-04:00' }) });

  const threads = await readThreads({ root, slug: 'two-sum' });
  assert.equal(threads.length, 2);
  assert.equal(threads.every((t) => t.resumable === false), true);
});

test('a problem that was never discussed has no threads and does not throw', async () => {
  const root = await workspace();
  assert.deepEqual(await readThreads({ root, slug: 'never-opened' }), []);
});

test('recall turn kind and delivery receipt survive replay', async t => {
  const root = await workspace(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const action = { id: 'recall-action', tool: 'save_recall_note', summary: 'Pending sync', ok: true, revisionId: 'a'.repeat(64) };
  await appendTurn({ root, slug: 'two-sum', turn: turn({ kind: 'recall-notes', actions: [action] }) });
  const rows = await readTurns({ root, slug: 'two-sum' });
  assert.equal(rows[0].kind, 'recall-notes');
  assert.deepEqual(rows[0].actions, [action]);
});

test('new optional activity preserves raw tools/actions and old record bytes', async t => {
  const root = await workspace(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  await appendTurn({ root, slug: 'two-sum', turn: turn({ tools: ['Read old/context'] }) });
  const before = await fsp.readFile(chatFile(root, 'two-sum'), 'utf8');
  const activity = [{ tool: 'read_context', effect: 'read', ms: 2300 }, { tool: 'save_note', effect: 'note' }];
  await appendTurn({ root, slug: 'two-sum', turn: turn({ askedAt: '2025-01-01T10:00:00Z', durationMs: 4500, activity, tools: ['save_note raw evidence'] }) });
  const bytes = await fsp.readFile(chatFile(root, 'two-sum'), 'utf8');
  assert.ok(bytes.startsWith(before));
  const saved = (await readTurns({ root, slug: 'two-sum' }))[1];
  assert.deepEqual(saved.activity, activity);
  assert.equal(saved.durationMs, 4500);
  assert.equal(saved.askedAt, '2025-01-01T10:00:00Z');
  assert.deepEqual(saved.tools, ['save_note raw evidence']);
});

test('history activity resolves new and legacy tools without altering evidence', async () => {
  const { normalizeTurnActivity } = await import('../transcript.mjs');
  const legacy = { tools: ['mcp__studio__read_context problem:fixture', 'Read private/path', 'unknown_tool secret'] };
  const copy = structuredClone(legacy);
  const activity = normalizeTurnActivity(legacy);
  assert.equal(activity[0].tool, 'read_context');
  assert.equal(activity[0].display.done, 'Read saved context');
  assert.equal(activity[1].display.done, 'Read saved context');
  assert.equal(activity[2].display.done, 'Used a tool');
  assert.equal(activity[0].ms, undefined);
  assert.deepEqual(legacy, copy);
  assert.deepEqual(normalizeTurnActivity({}), []);
  const fresh = normalizeTurnActivity({ activity: [{ tool: 'save_note', effect: 'note', ms: 1234 }], tools: ['Read ignored'] });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].ms, 1234);
  assert.equal(fresh[0].display.effect, 'note');
});

test('terminal activity keeps request identity separate from raw tool-action evidence', async t => {
  const root = await workspace(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const terminal = { requestId: 'mock-r1', ask: 'Answer.', answer: 'Done.', activity: [{ tool: 'read_context', effect: 'read' }] };
  const action = { requestId: 'mock-r1', kind: 'tool_action', action: { id: 'a1', tool: 'read_context', status: 'done' } };
  await appendTurn({ root, slug: 'two-sum', turn: terminal });
  const rows = await readTurns({ root, slug: 'two-sum' });
  assert.equal(rows[0].requestId, 'mock-r1');
  assert.deepEqual(rows[0].activity, terminal.activity);
  assert.deepEqual(action, { requestId: 'mock-r1', kind: 'tool_action', action: { id: 'a1', tool: 'read_context', status: 'done' } }, 'raw action evidence remains caller-owned');
});
