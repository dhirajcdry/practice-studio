import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { TtsWorker } from './worker.mjs';
import { createTtsRoutes } from './routes.mjs';
const fake = fileURLToPath(new URL('./test/fake-helper.mjs', import.meta.url));
function fixture(t) {
  const worker = new TtsWorker({ python: fake, script: fake });
  worker.model = worker.voices = fake;
  t.after(() => worker.close());
  const routes = createTtsRoutes(worker);
  async function call(route, body) {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(data) { this.data = data; } };
    await routes[route](Readable.from([Buffer.from(JSON.stringify(body ?? {}))]), res);
    return res;
  }
  return { worker, call };
}
test('fake helper status, ordered queue, wav and restart after death', async t => {
  const { worker, call } = fixture(t);
  const status = await call('GET /api/tts/status'); assert.equal(JSON.parse(status.data).available, true);
  const response = await call('POST /api/tts', { text: 'Hello.', voice: 'af_heart', speed: 1 });
  assert.equal(response.headers['content-type'], 'audio/wav'); assert.equal(response.data.toString('ascii', 0, 4), 'RIFF');
  const results = await Promise.all([worker.request({ text: 'Die.' }), worker.request({ text: 'Next.' })]);
  assert.equal(results[0].ok, false); assert.equal(results[1].ok, true);
});
test('route rejects malformed text, multiple sentences, voice and speed', async t => {
  const { call } = fixture(t);
  for (const body of [null, { text: 3 }, { text: '' }, { text: 'a'.repeat(501) }, { text: 'One. Two.' }, { text: 'Hi.', voice: 'af_unknown' }, { text: 'Hi.', speed: '1' }, { text: 'Hi.', speed: 3 }]) {
    await assert.rejects(call('POST /api/tts', body));
  }
  await call('POST /api/tts', { text: 'Use e.g. 1.5 here.' });
});
test('missing install is unavailable without a process', async t => {
  const { worker, call } = fixture(t); worker.python = '/nonexistent/studio-python';
  const response = await call('GET /api/tts/status');
  assert.equal(JSON.parse(response.data).available, false); assert.equal(worker.child, null);
});
test('bounded queue and close settle every pending request', async t => {
  const { worker } = fixture(t);
  const pending = Array.from({ length: 20 }, () => worker.request({ text: 'Wait.' }));
  worker.close(); const results = await Promise.all(pending);
  assert.ok(results.every(r => !r.ok));
});
test('timeout fails a stuck sentence and permits a fresh helper', async t => {
  const worker = new TtsWorker({ python: fake, script: fake, timeout: 100 });
  t.after(() => worker.close());
  assert.equal((await worker.request({ text: 'Wait.' })).ok, false);
  assert.equal((await worker.request({ text: 'Next.' })).ok, true);
});
