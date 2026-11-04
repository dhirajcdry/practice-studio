import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActionStore, createToolSession } from '../tools.mjs';
import { createWorkspaceTools, readAgentMemory, memoryFile } from '../workspace-tools.mjs';

async function tmp(t) { const value = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-wt-')); t?.after(() => fsp.rm(value, { recursive: true, force: true })); return value; }
test('memory scopes are bounded and traversal safe', async t => {
  const root = await tmp(t);
  await assert.rejects(() => readAgentMemory(root, '../escape'));
  assert.throws(() => memoryFile(root, '../escape', 'coding'));
});
test('read/update memory exact replacement and conflict', async t => {
  const root = await tmp(t); const s = createToolSession({ root, slug: 'x', store: new ActionStore() });
  assert.equal((await s.call('update_memory', { scope: 'coding', find: '', replace: 'tested fact', why: 'observed' })).ok, true);
  const page = JSON.parse((await s.call('read_memory', { scope: 'coding' })).text);
  assert.equal(page.data, 'tested fact');
  assert.equal(page.nextOffset, null);
  assert.equal((await s.call('update_memory', { scope: 'coding', find: 'missing', replace: 'x', why: 'no' })).ok, false);
});
test('optional runCode callback is used', async t => {
  const root = await tmp(t); let called = false;
  const s = createToolSession({ root, slug: 'x', store: new ActionStore(), capabilities: { names: ['run_code'], runCode: async () => { called = true; return { exitCode: 0, stdout: 'custom' }; } } });
  assert.deepEqual(await s.call('run_code', {}), { ok: true, text: JSON.stringify({ exitCode: 0, stdout: 'custom' }) }); assert.equal(called, true);
});
test('workspace bridge cleanup removes token/config', async t => {
  const root = await tmp(t); const bridge = await createWorkspaceTools({ root, slug: 'x', kind: 'review' });
  await bridge.dispose(); assert.equal(bridge.actions.length, 0);
});

test('failed receipt persistence never sends a browser edit or leaves a pending wait', async t => {
  const root = await tmp(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const events = [];
  const tools = createToolSession({ root, slug: 'x', store: new ActionStore(), runs: { action: (_, action) => events.push(action) }, run: { subscribers: new Set([1]) },
    onAction: async () => { throw Error('disk fixture failure'); }, log: { warn() {} }, ackTimeoutMs: 10000 });
  const result = await tools.call('edit_code', { find: 'pass', replace: 'return 1', why: 'Requested' });
  assert.equal(result.ok, false); assert.equal(events.length, 0); assert.equal(tools.actions[0].status, 'failed');
  tools.dispose(); await tools.flush();
});

test('memory replacements preserve literal replacement tokens and serialize with upkeep writes', async t => {
  const root = await tmp(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const { withMemoryLock } = await import('../memory.mjs');
  const file = memoryFile(root, 'x', 'problem');
  await fsp.mkdir(path.dirname(file), { recursive: true }); await fsp.writeFile(file, 'old');
  let release, began;
  const started = new Promise(r => began = r);
  const writer = withMemoryLock(file, async () => { began(); await new Promise(r => release = r); await fsp.appendFile(file, '\nupkeep evidence'); });
  await started;
  const tools = createToolSession({ root, slug: 'x', store: new ActionStore() });
  const update = tools.call('update_memory', { scope: 'problem', find: 'old', replace: '$& literal', why: 'Correction' });
  release(); await writer; assert.equal((await update).ok, true);
  assert.equal(await fsp.readFile(file, 'utf8'), '$& literal\nupkeep evidence');
});
