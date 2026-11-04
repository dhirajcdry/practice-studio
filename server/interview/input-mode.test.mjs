import test from 'node:test';
import assert from 'node:assert/strict';
import { createInterviewMode } from '../../web/js/interview-mode.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('a busy selection changes UI immediately and saves only when ready', async () => {
  let ready = false; const selected = [], saved = [], statuses = [];
  const mode = createInterviewMode({ ready: () => ready, save: async x => saved.push(x), onSelect: x => selected.push(x), onStatus: x => statuses.push(x) });
  mode.select('voice');
  assert.equal(mode.value, 'voice'); assert.deepEqual(selected, ['voice']); assert.equal(mode.pending, true);
  assert.equal(mode.sync('typed'), 'voice'); await tick(); assert.deepEqual(saved, []);
  assert.equal(statuses.at(-1).pending, true);
  ready = true; await mode.flush(); assert.deepEqual(saved, ['voice']); assert.equal(mode.pending, false);
  mode.dispose();
});

test('an older streamed state cannot overwrite the selected mode even after its save settles', async () => {
  const mode = createInterviewMode({ ready: () => true, save: async () => {} });
  mode.select('voice'); await tick(); assert.equal(mode.pending, false);
  assert.equal(mode.sync('typed'), 'voice'); assert.equal(mode.value, 'voice');
  mode.dispose();
});

test('rapid toggles serialize saves and retain the latest desired mode', async () => {
  const writes = [], selected = []; let active = 0, maxActive = 0;
  const mode = createInterviewMode({ ready: () => true, onSelect: x => selected.push(x), save: value => { const done = deferred(); active++; maxActive = Math.max(maxActive, active); writes.push({ value, done }); return done.promise.finally(() => active--); } });
  mode.select('voice'); await tick();
  mode.select('typed'); assert.equal(mode.value, 'typed'); assert.equal(mode.sync('voice'), 'typed');
  assert.equal(writes.length, 1); writes[0].done.resolve(); await tick();
  assert.equal(writes.length, 2); assert.equal(writes[1].value, 'typed');
  mode.select('voice'); assert.equal(mode.sync('typed'), 'voice'); writes[1].done.resolve(); await tick();
  assert.equal(writes.length, 3); writes[2].done.resolve(); await tick();
  assert.equal(mode.value, 'voice'); assert.equal(mode.pending, false); assert.equal(maxActive, 1);
  assert.deepEqual(selected, ['voice','typed','voice']); mode.dispose();
});

test('save failure stays visible without retry loops and explicit retry saves desired mode', async () => {
  let calls = 0; const statuses = [];
  const mode = createInterviewMode({ ready: () => true, onStatus: s => statuses.push(s), save: async () => { if (++calls === 1) throw Error('offline'); } });
  mode.select('voice'); await tick(); assert.equal(calls, 1);
  assert.equal(statuses.at(-1).error, 'offline'); assert.equal(mode.pending, true); assert.equal(mode.value, 'voice');
  await mode.flush(); await tick(); assert.equal(calls, 1);
  assert.equal(mode.sync('typed'), 'voice');
  mode.retry(); await tick(); assert.equal(calls, 2); assert.equal(mode.pending, false); assert.equal(statuses.at(-1).error, null);
  mode.dispose();
});

test('awaiting flush waits for an in-flight save and the latest queued choice', async () => {
  const writes = [];
  const mode = createInterviewMode({ ready: () => true, save: value => { const done = deferred(); writes.push({ value, done }); return done.promise; } });
  mode.select('voice'); await tick(); mode.select('typed');
  let finished = false; const flush = mode.flush().then(() => { finished = true; });
  writes[0].done.resolve(); await tick();
  assert.equal(finished, false); assert.equal(writes[1].value, 'typed');
  writes[1].done.resolve(); await flush;
  assert.equal(finished, true); assert.equal(mode.pending, false); mode.dispose();
});

test('disposal suppresses UI updates and queued saves after an in-flight write', async () => {
  const gate = deferred(), selected = [], statuses = [], saved = [];
  const mode = createInterviewMode({ ready: () => true, save: value => { saved.push(value); return gate.promise; }, onSelect: x => selected.push(x), onStatus: x => statuses.push(x) });
  mode.select('voice'); await tick(); mode.select('typed');
  const count = statuses.length; mode.dispose(); mode.select('voice'); mode.retry(); gate.resolve(); await tick();
  assert.deepEqual(saved, ['voice']); assert.deepEqual(selected, ['voice','typed']); assert.equal(statuses.length, count);
});
