import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readGuidance, changeGuidance, effectiveGuidance } from '../guidance.mjs';

const source = { actor: 'user', requestId: 'test' };
async function home(t) { const root=await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guidance-')); t.after(()=>fs.rm(root,{recursive:true,force:true}));return root; }
const rule = (id='hint', extra={}) => ({ id, scope:'coding', mode:'practice', text:'Be precise.', enabled:true, ...extra });

test('guidance mutations persist, page, and restore', async t => {
  const root = await home(t);
  const a = await changeGuidance(root, { expectedRevision:0, mutationId:'a', operation:'upsert', rule:rule(), reason:'add' }, source);
  const b = await changeGuidance(root, { expectedRevision:1, mutationId:'b', operation:'upsert', rule:rule('other'), reason:'add' }, source);
  await changeGuidance(root, { expectedRevision:2, mutationId:'c', operation:'remove', ruleId:'hint', reason:'remove' }, source);
  const r = await changeGuidance(root, { expectedRevision:3, mutationId:'d', operation:'restore', restoreRevision:1, reason:'undo' }, source);
  assert.deepEqual(r.rules, [rule()]);
  assert.equal((await readGuidance(root, {limit:2})).history.length, 2);
  assert.equal((await readGuidance(root)).revision, 4);
  assert.equal(b.revision, 2);
});

test('CAS and mutation idempotency/collision', async t => {
  const root = await home(t);
  const input = { expectedRevision:0, mutationId:'same', operation:'upsert', rule:rule(), reason:'x' };
  const first = await changeGuidance(root, input, source); const replay = await changeGuidance(root, input, source);
  assert.equal(replay.replayed, true); await assert.rejects(changeGuidance(root, {...input, reason:'y'}, source), /different data/);
  await assert.rejects(changeGuidance(root, {...input, mutationId:'new'}, source), e => e.status === 409);
  assert.deepEqual((await effectiveGuidance(root, {discipline:'coding', mode:'practice'})).rules, [{id:'hint',scope:'coding',mode:'practice',text:'Be precise.'}]);
});

test('validation limits and safe path', async t => {
  const root = await home(t);
  await assert.rejects(changeGuidance(root, {expectedRevision:0, mutationId:'x', operation:'upsert', rule:{...rule(), scope:'wat'}, reason:''}, source), e => e.status === 400);
  await assert.rejects(changeGuidance(root, {expectedRevision:0, mutationId:'x', operation:'upsert', rule:{...rule(), text:'x'.repeat(2001)}, reason:''}, source), e => e.status === 400);
  await assert.rejects(changeGuidance(root, {expectedRevision:0, mutationId:'x', operation:'upsert', rule:rule(), extra:true, reason:''}, source), /Unknown|invalid/i);
});
