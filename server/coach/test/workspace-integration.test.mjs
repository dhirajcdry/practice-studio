import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkspaceTools } from '../workspace-tools.mjs';
import { memoryPath } from '../../storage-layout.mjs';

async function root(t) { const value = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-wi-')); t?.after(() => fsp.rm(value, { recursive: true, force: true })); return value; }

test('practice workspace tool turn persists memory and completes browser edit receipt', async t => {
  const r = await root(t); const events = []; const receipts = [];
  const bridge = await createWorkspaceTools({ root: r, slug: 'lld-lockers', target: 'practice:lld-lockers:p1', stream: { send: (kind, value) => { events.push({ kind, value }); } }, kind: 'code', onAction: a => receipts.push(structuredClone(a)) });
  assert.equal((await bridge.options.toolSession.call('update_memory', { scope: 'coding', find: '', replace: 'Use a state machine; tested on expiry.', why: 'Observed in practice.' })).ok, true);
  const edit = bridge.options.toolSession.call('edit_code', { find: 'pass', replace: 'return 1', why: 'Explicitly requested fix.' });
  await new Promise(r => setImmediate(r));
  const pending = events.find(e => e.kind === 'action' && e.value.tool === 'edit_code');
  assert.ok(pending); assert.equal(pending.value.target, 'practice:lld-lockers:p1');
  // ActionStore is reached through the service-owned callback route in production; this
  // direct answer exercises the same pending action contract without a listening server.
  const { serviceFor } = await import('../routes.mjs');
  const svc = serviceFor({ homeRoot: r });
  assert.equal(svc.actions.answer(pending.value.id, { ok: true, message: 'Applied' }), 'accepted');
  assert.equal((await edit).ok, true); await bridge.dispose();
  assert.deepEqual(receipts.filter(x => x.tool === 'edit_code').map(x => x.status), ['pending', 'done']);
  const memory = await fsp.readFile(memoryPath(r, 'coding'), 'utf8'); assert.match(memory, /state machine/);
});

test('separate LLD targets remain distinct for same slug', async t => {
  const r = await root(t); const a = await createWorkspaceTools({ root: r, slug: 'lld-x', target: 'interview:lld-x:a', kind: 'review' });
  const b = await createWorkspaceTools({ root: r, slug: 'lld-x', target: 'interview:lld-x:b', kind: 'review' });
  assert.equal((await a.options.toolSession.call('update_memory', { scope: 'lld', find: '', replace: 'A', why: 'A evidence' })).ok, true);
  const memory = await b.options.toolSession.call('read_memory', { scope: 'lld' });
  const page = JSON.parse(memory.text);
  assert.equal(page.data, 'A');
  assert.equal(page.resource, 'memory');
  assert.equal(page.totalCharacters, 1);
  assert.equal(page.offset, 0);
  assert.equal(page.nextOffset, null);
  await a.dispose(); await b.dispose();
});
