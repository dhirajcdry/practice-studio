import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DesignService, routes } from './routes.mjs';
import { DesignStore } from './store.mjs';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test/fake-claude.mjs');
const root = () => fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-recovery-'));
async function startInterview(dir) {
  const svc = new DesignService({ root: dir, binary: FAKE, log: { warn() {} } });
  const req = request({ level: 'L4' });
  const sink = new ResponseSink();
  await routes['POST /api/design/start'](req, sink, { design: svc, homeRoot: dir, params: {} });
  await svc.live.values().next().value?.completion;
  return { svc, id: sink.events.find(e => e.name === 'interview').payload.id };
}
function request(body) { const req = new EventEmitter(); process.nextTick(() => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); }); return req; }
class ResponseSink {
  constructor() { this.events = []; this.headersSent = false; }
  setHeader() {}
  flushHeaders() {}
  on() { return this; }
  writeHead() { this.headersSent = true; }
  write(chunk) { for (const block of String(chunk).split('\n\n')) { const d = block.match(/data: (.*)/)?.[1]; const e = block.match(/event: (.*)/)?.[1]; if (d) this.events.push({ name: e, payload: JSON.parse(d) }); } }
  end() {}
}
const post = (svc, dir, id, body) => routes['POST /api/design/turn'](
  request({ interviewId: id, ...body }),
  new ResponseSink(), { design: svc, homeRoot: dir, params: {} });
const settled = async (svc, id) => { for (let i = 0; i < 100 && svc.live.has(id); i++) await new Promise(r => setTimeout(r, 5)); };

test('same requestId replays the recorded answer without duplicating evidence', async () => {
  const dir = await root(); process.env.STUDIO_FAKE_REPLY = 'What is your availability target?';
  const { svc, id } = await startInterview(dir);
  await post(svc, dir, id, { said: 'I would cache it.', requestId: 'retry-1' });
  await settled(svc, id);
  await post(svc, dir, id, { said: 'I would cache it.', requestId: 'retry-1' });
  await assert.rejects(() => post(svc, dir, id, { said: 'A different answer.', requestId: 'retry-1' }), /different answer/);
  const turns = await new DesignStore({ root: dir }).readTurns(id);
  assert.equal(turns.filter(t => t.kind === 'turn').length, 1);
  assert.equal(turns.filter(t => t.kind === 'candidate').length, 1);
});

test('interrupted debrief does not mark interview complete', async () => {
  const dir = await root(); process.env.STUDIO_FAKE_REPLY = 'USER: I would choose a database.\nWhat next?';
  const { svc, id } = await startInterview(dir);
  const req = request({ interviewId: id });
  const sink = new ResponseSink();
  await routes['POST /api/design/done'](req, sink, { design: svc, homeRoot: dir, params: {} });
  await settled(svc, id);
  assert.equal((await new DesignStore({ root: dir }).readState(id)).debriefed, false);
});

test('accepted answer survives a stopped provider and retries after a service restart', async t => {
  const dir = await root(); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  process.env.STUDIO_FAKE_REPLY = 'Design a service.';
  const { svc, id } = await startInterview(dir);
  process.env.STUDIO_FAKE_CHUNK_DELAY = '200';
  t.after(() => { delete process.env.STUDIO_FAKE_CHUNK_DELAY; });
  const body = { said: 'The mapping is durably stored before acknowledging the write.', requestId: 'durable-input' };
  await post(svc, dir, id, body);
  const before = await svc.store.readTurns(id);
  assert.equal(before.filter(turn => turn.said === body.said).length, 1, 'input must reach disk before a model reply');
  await assert.rejects(post(svc, dir, id, body), /finishing a turn/);
  await routes['POST /api/design/stop'](request({ interviewId: id }), { writeHead() {}, end() {} }, { design: svc });
  delete process.env.STUDIO_FAKE_CHUNK_DELAY;
  const restarted = new DesignService({ root: dir, binary: FAKE, log: { warn() {} } });
  await post(restarted, dir, id, body); await settled(restarted, id);
  const after = await restarted.store.readTurns(id);
  assert.equal(after.filter(turn => turn.said === body.said).length, 1);
  assert.equal(after.filter(turn => turn.kind === 'turn' && turn.requestId === body.requestId && !turn.interrupted).length, 1);
});

test('concurrent scene snapshots never overwrite one another', async t => {
  const dir = await root(); t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const store = new DesignStore({ root: dir }), id = '2026-10-31T11-00-00-000Z';
  await store.create(id, { topicSlug: 'design-url-shortener' });
  await Promise.all([store.appendScene(id, [{ id: 'a' }]), store.appendScene(id, [{ id: 'b' }])]);
  const snapshots = await store.readScenes(id);
  assert.deepEqual(snapshots.map(scene => scene.elements[0].id).sort(), ['a', 'b']);
});
