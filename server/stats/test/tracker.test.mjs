import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildStats } from '../aggregate.mjs';
import { handleGetTracker, handleResetTracker, handleRestoreTracker } from '../tracker.mjs';

const catalog = { problems: [{ slug: 'two-sum' }] };
const line = (at, type, data) => JSON.stringify({ at, type, ...(data ? { data } : {}) }) + '\n';
const res = () => ({ writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b) { this.body = b ?? ''; }, json() { return JSON.parse(this.body); } });
const req = (value) => Readable.from([JSON.stringify(value)]);
import { Readable } from 'node:stream';

async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-tracker-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'problems', 'two-sum', 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 's.jsonl');
  await fsp.writeFile(file, line('2026-01-01T00:00:00.000Z', 'problem_opened') + line('2026-01-01T00:01:00.000Z', 'verdict', { accepted: true }));
  return { root, file };
}

test('reset and restore preserve raw evidence and lifetime stats', async (t) => {
  const { root, file } = await fixture(t); const before = await fsp.readFile(file);
  const ctx = { homeRoot: root, catalog };
  const problem = path.dirname(path.dirname(file));
  const files = ['solution.py', 'NOTES.md', 'chats.jsonl', 'meta.json', 'attempts/2026-01-01T00-00-00-000Z.py'];
  for (const name of files) {
    await fsp.mkdir(path.dirname(path.join(problem, name)), { recursive: true });
    await fsp.writeFile(path.join(problem, name), name === 'meta.json' ? '{"submissions":[]}' : 'preserved fixture');
  }
  const statsBefore = await buildStats({ root, catalog, now: new Date('2026-11-01T00:00:00Z') });
  const lifetime = res(); await handleGetTracker({}, lifetime, ctx);
  const reset = res(); await handleResetTracker(req({}), reset, ctx);
  const fresh = res(); await handleGetTracker({}, fresh, ctx);
  assert.equal(fresh.json().problems[0].status, 'empty');
  assert.ok(fresh.json().resetAt);
  assert.deepEqual(await buildStats({ root, catalog, now: new Date('2026-11-01T00:00:00Z') }), statsBefore);
  for (const name of files) assert.equal(await fsp.readFile(path.join(problem, name), 'utf8'), name === 'meta.json' ? '{"submissions":[]}' : 'preserved fixture');
  const restore = res(); await handleRestoreTracker(req({}), restore, ctx);
  assert.equal((await fsp.readFile(file)).equals(before), true);
  const after = res(); await handleGetTracker({}, after, ctx);
  assert.equal(after.json().problems[0].status, lifetime.json().problems[0].status);
});

test('opened alone after reset stays empty; later verdict becomes accepted', async (t) => {
  const { root, file } = await fixture(t); const ctx = { homeRoot: root, catalog };
  await handleResetTracker(req({}), res(), ctx);
  await fsp.appendFile(file, line('2999-01-01T00:00:00.000Z', 'problem_opened'));
  const opened = res(); await handleGetTracker({}, opened, ctx); assert.equal(opened.json().problems[0].status, 'empty');
  await fsp.appendFile(file, line('2999-01-01T00:01:00.000Z', 'verdict', { accepted: true }));
  const accepted = res(); await handleGetTracker({}, accepted, ctx); assert.equal(accepted.json().problems[0].status, 'accepted');
});

test('invalid slug and corrupt marker state are rejected', async (t) => {
  const { root } = await fixture(t); const ctx = { homeRoot: root, catalog };
  await assert.rejects(() => handleResetTracker(req({ slug: 'two-sum' }), res(), ctx), /empty JSON object/);
  await fsp.writeFile(path.join(root, 'tracker.json'), '{broken');
  await assert.rejects(() => handleGetTracker({}, res(), ctx), /could not be read/);
});

 test('fresh typing, local passes and metadata submissions update only the new round', async (t) => {
  const { root, file } = await fixture(t); const ctx = { homeRoot: root, catalog };
  await handleResetTracker(req({}), res(), ctx);
  const status = async () => { const r=res(); await handleGetTracker({},r,ctx);return r.json().problems[0].status; };
  await fsp.appendFile(file,line('2999-01-01T00:00:00Z','first_keystroke'));
  assert.equal(await status(),'attempted');
  await fsp.appendFile(file,line('2999-01-01T00:01:00Z','run_result',{passed:2,total:2}));
  assert.equal(await status(),'local-pass');
  await fsp.writeFile(path.join(path.dirname(path.dirname(file)),'meta.json'),JSON.stringify({submissions:[{at:'2999-01-01T00:02:00Z',verdict:'Accepted'}]}));
  assert.equal(await status(),'accepted');
 });
