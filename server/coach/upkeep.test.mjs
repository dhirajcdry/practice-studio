import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUpkeepPrompt, createUpkeepQueue } from './upkeep.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const job = (slug, extra = {}) => ({ root: 'r', slug, sessionId: `${slug}-session`, ...extra });

test('prompt scopes design upkeep and forbids records', () => {
  const prompt = buildUpkeepPrompt({ slug: 'design:abc', kind: 'design-debrief' });
  assert.match(prompt, /DESIGN\.md/);
  assert.match(prompt, /CLAUDE\.md/);
  assert.match(prompt, /interview\.json/);
});

test('coalesces queued jobs and runs serially', async () => {
  const turns = [];
  const queue = createUpkeepQueue({ runner: opts => {
    let done; const exited = new Promise(r => { done = r; });
    turns.push({ opts, done }); return { exited };
  } });
  assert.equal(queue.enqueue(job('a')), true);
  assert.equal(queue.enqueue(job('a', { model: 'newer', sessionId: 'latest' })), true);
  assert.equal(queue.enqueue(job('b')), true);
  await tick();
  assert.equal(queue.status().running, 'a');
  assert.equal(turns[0].opts.model, 'newer');
  assert.equal(turns[0].opts.resumeSessionId, 'latest');
  turns[0].done(); await tick(); await tick();
  assert.equal(queue.status().running, 'b');
  turns[1].done(); await tick();
  assert.deepEqual(queue.status(), { running: null, queued: 0 });
});

test('allows same slug to queue while it is running and preserves runner options and first timing', async () => {
  let resolve;
  let captured;
  let clock = 100;
  const queue = createUpkeepQueue({ now: () => clock, runner: opts => {
    captured = opts;
    opts.onToken('first'); clock = 125;
    return { exited: new Promise(r => { resolve = r; }) };
  } });
  const log = { info: () => {} };
  assert.equal(queue.enqueue(job('same', { model: 'sonnet', binary: 'custom', env: { X: '1' }, spawnFn: () => {}, log })), true);
  await tick();
  assert.equal(queue.enqueue(job('same', { model: 'opus', sessionId: 'new-session' })), true);
  assert.equal(queue.status().queued, 1);
  assert.equal(captured.binary, 'custom');
  assert.deepEqual(captured.env, { X: '1' });
  assert.equal(captured.tools, 'Read,Glob,Write,Edit');
  assert.equal(captured.forkSession, true);
  assert.equal(captured.noSessionPersistence, true);
  assert.equal(captured.timeoutMs, 300000);
  resolve(); await tick(); await tick();
  assert.equal(queue.status().running, 'same');
});

test('runner failure does not strand queue', async () => {
  const warnings = [];
  const queue = createUpkeepQueue({ runner: opts => { opts.onError('secret'); return { exited: Promise.resolve() }; } });
  const log = { warn: message => warnings.push(message) };
  assert.equal(queue.enqueue(job('a', { log })), true);
  assert.equal(queue.enqueue(job('b', { log })), true);
  await tick(); await tick();
  assert.deepEqual(queue.status(), { running: null, queued: 0 });
  assert.deepEqual(warnings, ['[coach] upkeep a: failed or queue full', '[coach] upkeep b: failed or queue full']);
});

test('bounds queued work at twenty jobs', async () => {
  let release;
  const queue = createUpkeepQueue({ runner: () => ({ exited: new Promise(r => { release = r; }) }) });
  assert.equal(queue.enqueue(job('running')), true);
  await tick();
  for (let i = 0; i < 20; i += 1) assert.equal(queue.enqueue(job(`q${i}`)), true);
  const warnings = [];
  assert.equal(queue.enqueue(job('overflow', { log: { warn: message => warnings.push(message) } })), false);
  assert.deepEqual(queue.status(), { running: 'running', queued: 20 });
  assert.deepEqual(warnings, ['[coach] upkeep overflow: failed or queue full']);
  release();
});
