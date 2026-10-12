import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { AsrWorker } from './routes.mjs';

async function fakeWorker(source) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-asr-worker-test-'));
  const file = path.join(dir, 'worker.mjs');
  await fsp.writeFile(file, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return file;
}

test('serializes concurrent requests and preserves queue order', async () => {
  const binary = await fakeWorker(`
    let busy = false; process.stdin.setEncoding('utf8'); let b='';
    process.stdin.on('data', c => { b += c; let i; while ((i=b.indexOf('\\n'))>=0) { const x=JSON.parse(b.slice(0,i)); b=b.slice(i+1); if (busy) process.exit(9); busy=true; setTimeout(() => { process.stdout.write(JSON.stringify({text:x.input,words:[]})+'\\n'); busy=false; }, 20); } });
  `);
  const worker = new AsrWorker(binary, 1000);
  const results = await Promise.all(['a', 'b', 'c'].map((input) => worker.run(input)));
  assert.deepEqual(results.map((x) => x.result.text), ['a', 'b', 'c']);
  worker.close();
});

test('restarts after a crash and serves queued work', async () => {
  const binary = await fakeWorker(`
    process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data', c => { b += c; const i=b.indexOf('\\n'); if(i<0)return; const x=JSON.parse(b.slice(0,i)); if(x.input==='crash') process.exit(7); process.stdout.write(JSON.stringify({text:x.input})+'\\n'); });
  `);
  const worker = new AsrWorker(binary, 1000);
  const first = worker.run('crash');
  const second = worker.run('after-crash');
  assert.equal((await first).ok, false);
  assert.equal((await second).result.text, 'after-crash');
  worker.close();
});

test('timeout kills a stuck worker and recovers the next request', async () => {
  const binary = await fakeWorker(`
    process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data', c => { b += c; const i=b.indexOf('\\n'); if(i<0)return; const x=JSON.parse(b.slice(0,i)); if(x.input==='hang') return; process.stdout.write(JSON.stringify({text:x.input})+'\\n'); });
  `);
  const worker = new AsrWorker(binary, 1000);
  const timed = worker.run('hang'); const queued = worker.run('next');
  assert.equal((await timed).error.kind, 'timeout');
  assert.equal((await queued).result.text, 'next');
  worker.close();
});

test('malformed worker output becomes an internal error and next request still works', async () => {
  const binary = await fakeWorker(`
    process.stdin.setEncoding('utf8'); let b=''; process.stdin.on('data', c => { b += c; const i=b.indexOf('\\n'); if(i<0)return; const x=JSON.parse(b.slice(0,i)); b=b.slice(i+1); process.stdout.write(x.input==='bad'?'not-json\\n':JSON.stringify({text:x.input})+'\\n'); });
  `);
  const worker = new AsrWorker(binary, 1000);
  assert.equal((await worker.run('bad')).error.kind, 'internal');
  assert.equal((await worker.run('good')).result.text, 'good');
  worker.close();
});

test('missing binary fails cleanly', async () => {
  const worker = new AsrWorker('/tmp/studio-asr-no-such-binary', 1000);
  assert.equal((await worker.run('x')).ok, false);
  worker.close();
});

 test('close resolves active and queued work and releases the process', async () => {
  const binary = await fakeWorker(`process.stdin.resume();`);
  const worker = new AsrWorker(binary, 1000);
  const active = worker.run('first');
  const queued = worker.run('second');
  worker.close();
  assert.equal((await active).error.kind, 'shutdown');
  assert.equal((await queued).error.kind, 'shutdown');
  assert.equal(worker.child, null);
});
