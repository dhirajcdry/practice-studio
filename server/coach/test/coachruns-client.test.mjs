import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { createSeenRuns } from '../../../web/js/seen-runs.js';

const source = (await fs.readFile(new URL('../../../web/js/coachruns.js', import.meta.url), 'utf8'))
  .replace(/^import .*;$/gm, '').replaceAll('export ', '');
function harness(storage = new Map()) {
  const streams = [], found = [];
  const open = handlers => new Promise(resolve => streams.push({ handlers, resolve }));
  const ctx = vm.createContext({ createSeenRuns, AbortController, setTimeout,
    localStorage: { getItem: key => storage.get(key), setItem: (key,value) => storage.set(key,value) },
    streamCoachMessage: (_slug, _message, handlers) => open(handlers),
    attachCoachRun: (_id, handlers) => open(handlers),
    listCoachRuns: async () => ({ ok: true, runs: found }), stopCoachRun: async () => {},
  });
  vm.runInContext(source + '\nthis.api = {startRun,markSeen,dismissRun,adopt,runsElsewhere,runFor};', ctx);
  return { ...ctx.api, streams, found, storage };
}

test('a finished seen run is not resurrected by adoption or a fresh page', async () => {
  const h = harness();
  h.startRun({ slug: 'two-sum' });
  h.streams[0].handlers.onRun({ id: 'read-id' });
  h.streams[0].resolve({ ok: true }); await Promise.resolve();
  h.markSeen('two-sum');
  h.found.push({ id: 'read-id', slug: 'two-sum', status: 'done' });
  assert.equal(await h.adopt(), 0);
  const reloaded = harness(h.storage); reloaded.found.push(...h.found);
  assert.equal(await reloaded.adopt(), 0);
  assert.equal(reloaded.runsElsewhere().length, 0);
});

test('acknowledgement before the server id arrives is persisted onRun', async () => {
  for (const action of ['markSeen', 'dismissRun']) {
    const h = harness(); h.startRun({ slug: 'two-sum' }); h[action]('two-sum');
    h.streams[0].handlers.onRun({ id: action });
    const reloaded = harness(h.storage);
    reloaded.found.push({ id: action, slug: 'two-sum', status: 'done' });
    assert.equal(await reloaded.adopt(), 0);
  }
});

test('a dismissed running run is adopted without restoring its notification', async () => {
  const h = harness(); h.startRun({ slug: 'two-sum' });
  h.streams[0].handlers.onRun({ id: 'dismissed' }); h.dismissRun('two-sum');
  const reloaded = harness(h.storage);
  reloaded.found.push({ id: 'dismissed', slug: 'two-sum', status: 'running' });
  assert.equal(await reloaded.adopt(), 1);
  assert.equal(reloaded.runFor('two-sum').dismissed, true);
  assert.equal(reloaded.runsElsewhere().length, 0);
});
