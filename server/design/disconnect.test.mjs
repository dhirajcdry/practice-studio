import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DesignService, routes } from './routes.mjs';

// Exercise actual route callbacks and fake CLI without needing a listening socket.
test('detached turn completes, appends the question, and retains a navigation pause', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'design-detached-'));
  const svc = new DesignService({ root, binary: fileURLToPath(new URL('./test/fake-claude.mjs', import.meta.url)) });
  const reply = 'How would you partition the cache?';
  process.env.STUDIO_FAKE_REPLY = reply;
  process.env.STUDIO_FAKE_CHUNK_DELAY = '10';
  async function call(route, body) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.headers = {};
    const res = new EventEmitter();
    res.raw = '';
    res.writeHead = () => res;
    res.write = chunk => { res.raw += chunk; return true; };
    res.end = chunk => { if (chunk) res.raw += chunk; };
    await routes['POST /api/design/' + route](req, res, { design: svc });
    return res;
  }
  try {
    await call('start', {});
    const id = [...svc.live.keys()][0];
    await svc.live.get(id).completion;
    const before = await svc.store.readTurns(id);
    const res = await call('turn', { interviewId: id, said: 'Hash the key.' });
    const completion = svc.live.get(id).completion;
    res.emit('close');
    await call('pause', { interviewId: id });
    await completion;
    const state = await svc.store.readState(id);
    assert.ok(state.pausedAt);
    const turns = await svc.store.readTurns(id);
    assert.deepEqual(turns.slice(0, before.length), before);
    assert.equal(turns.at(-1).asked, reply);
    assert.equal(turns.at(-1).said, 'Hash the key.');
    const resumed = await call('resume', { interviewId: id });
    assert.equal(JSON.parse(resumed.raw).turns.at(-1).asked, reply);
  } finally {
    delete process.env.STUDIO_FAKE_REPLY;
    delete process.env.STUDIO_FAKE_CHUNK_DELAY;
    await fsp.rm(root, { recursive: true, force: true });
  }
});
