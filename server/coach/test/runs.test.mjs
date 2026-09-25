// A coach turn outliving the connection that started it.
//
// The behaviour under test, in one sentence: a browser going away is not a decision to
// stop. Reloading the page, closing the tab, losing the network — none of them should
// end a turn, because none of them mean the person stopped wanting the answer. Only the
// Stop button, the CLI finishing, and the timeout do.
//
// This used to be exactly backwards. `res.on('close')` killed the child, so a refresh
// killed the coach mid-sentence and filed the half it had as `stopped`.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { routes, CoachService } from '../routes.mjs';
import { CoachRuns, RETAIN_MS } from '../runs.mjs';
import { HttpError, sendError } from '../../http-util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'bin', 'fake-claude.mjs');

/* ------------------------------------------------------------------ the registry */

/** A stream that records what it was sent, so replay can be asserted exactly. */
function fakeStream() {
  const sent = [];
  return {
    sent,
    closed: false,
    send(event, value) { sent.push({ event, value }); return true; },
    token(text) { return this.send('token', { text }); },
    tool(name, summary) { return this.send('tool', { name, summary }); },
    done(sessionId, stoppedReason) { return this.send('done', { sessionId, stoppedReason }); },
    error(message) { return this.send('error', { message }); },
    end() { this.closed = true; },
  };
}

test('a run keeps the answer so far, and a late watcher gets all of it', () => {
  const runs = new CoachRuns();
  const run = runs.start({ slug: 'two-sum', ask: 'why a hash map?' });
  runs.token(run, 'Because ');
  runs.tool(run, 'Read', 'NOTES.md');
  runs.token(run, 'lookups are constant.');

  const late = fakeStream();
  runs.attach(run, late);

  assert.equal(late.sent[0].event, 'run', 'the id comes first — it is what a reload finds it by');
  assert.equal(late.sent[0].value.id, run.id);
  // Replayed as one piece of text, not as a recording of every token that ever arrived.
  assert.deepEqual(late.sent[1], { event: 'token', value: { text: 'Because lookups are constant.' } });
  assert.deepEqual(late.sent[2], { event: 'tool', value: { name: 'Read', summary: 'NOTES.md' } });
});

test('a watcher that arrives after the end still gets the whole answer, then done', () => {
  const runs = new CoachRuns();
  const run = runs.start({ slug: 'two-sum' });
  runs.token(run, 'all of it');
  runs.finish(run, { status: 'done', sessionId: 'sess-1' });

  const late = fakeStream();
  runs.attach(run, late);
  assert.deepEqual(late.sent.map((e) => e.event), ['run', 'token', 'done']);
  assert.equal(late.sent.at(-1).value.sessionId, 'sess-1');
  assert.equal(late.closed, true);
});

test('live watchers all see the same stream, and detaching one leaves the rest', () => {
  const runs = new CoachRuns();
  const run = runs.start({ slug: 'two-sum' });
  const a = fakeStream();
  const b = fakeStream();
  const detachA = runs.attach(run, a);
  runs.attach(run, b);

  runs.token(run, 'x');
  detachA();
  runs.token(run, 'y');
  runs.finish(run, { status: 'done', sessionId: 's' });

  assert.deepEqual(a.sent.filter((e) => e.event === 'token').map((e) => e.value.text), ['x']);
  assert.deepEqual(b.sent.filter((e) => e.event === 'token').map((e) => e.value.text), ['x', 'y']);
  assert.equal(b.sent.at(-1).event, 'done');
});

test('one live run per problem — a second would resume the same session twice', () => {
  const runs = new CoachRuns();
  const run = runs.start({ slug: 'two-sum' });
  assert.equal(runs.liveFor('two-sum'), run);
  runs.finish(run, { status: 'done' });
  assert.equal(runs.liveFor('two-sum'), null, 'a finished run is not something to join');
});

test('finished runs are swept once nothing could still want them; running ones never are', () => {
  let now = 1_000_000;
  const runs = new CoachRuns({ now: () => now });
  const old = runs.start({ slug: 'old' });
  const live = runs.start({ slug: 'live' });
  runs.finish(old, { status: 'done' });

  now += RETAIN_MS - 1;
  runs.sweep();
  assert.ok(runs.get(old.id), 'still adoptable just inside the window');

  now += 2;
  runs.sweep();
  assert.equal(runs.get(old.id), null);
  assert.ok(runs.get(live.id), 'a turn still being written is never evicted');
});

/* -------------------------------------------------------------------- over http */

function serverFor(ctx) {
  return http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    let key = `${req.method} ${url.pathname}`;
    let params = {};
    if (segments[0] === 'api' && segments[1] === 'coach' && segments[2] === 'runs' && segments.length === 4) {
      key = 'GET /api/coach/runs/:id';
      params = { id: segments[3] };
    }

    const handler = routes[key];
    if (!handler) return sendError(res, 404, 'NOT_FOUND', 'no such route');

    Promise.resolve(handler(req, res, { ...ctx, params })).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', String(err));
    });
  });
}

async function fixture({ mode = 'slow', delayMs = 500 } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-coachruns-'));
  let spawns = 0;
  const coach = new CoachService({
    root,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_DELAY_MS: String(delayMs) },
    spawnFn: (...args) => { spawns += 1; return spawn(...args); },
    timeoutMs: 15_000,
    log: { warn() {}, error() {} },
  });
  const server = serverFor({ coach });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    root,
    coach,
    base: `http://127.0.0.1:${server.address().port}`,
    spawnCount: () => spawns,
    close: () => new Promise((r) => server.close(r)),
  };
}

const post = (base, route, body) => fetch(base + route, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Read an SSE body until `stop` says we have enough, then hand back the raw text. */
async function readUntil(response, stop) {
  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += utf8.decode(value, { stream: true });
    if (stop(text)) break;
  }
  return { text, cancel: () => reader.cancel().catch(() => {}) };
}

const tokensIn = (text) => [...text.matchAll(/^event: token\ndata: (.*)$/gm)]
  .map((m) => JSON.parse(m[1]).text)
  .join('');

const waitFor = async (fn, ms = 5000) => {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
};

test('a browser that disconnects mid-answer does NOT stop the coach', async (t) => {
  const f = await fixture({ delayMs: 500 });
  t.after(f.close);

  const response = await post(f.base, '/api/coach/message', { slug: 'two-sum', message: 'why?' });
  const first = await readUntil(response, (text) => text.includes('first half'));
  await first.cancel();   // the tab is gone — a reload, a close, a dropped network

  // The turn is still going, and finishes on its own.
  const done = await waitFor(async () => {
    const list = await (await fetch(`${f.base}/api/coach/runs`)).json();
    const run = list.runs.find((r) => r.slug === 'two-sum');
    return run && run.status !== 'running' ? run : null;
  });
  assert.ok(done, 'the run never finished after the client went away');
  assert.equal(done.status, 'done', 'a disconnect was treated as a stop');

  // And the transcript has the WHOLE answer, not the half that had arrived.
  const raw = await fsp.readFile(path.join(f.root, 'problems', 'two-sum', 'chats.jsonl'), 'utf8');
  const turn = JSON.parse(raw.trim().split('\n').at(-1));
  assert.match(turn.answer, /first half. second half\./);
  assert.notEqual(turn.stopped, true, 'filed as stopped, when nobody stopped anything');
});

test('re-attaching gives back the whole answer, not the tail', async (t) => {
  const f = await fixture({ delayMs: 700 });
  t.after(f.close);

  const response = await post(f.base, '/api/coach/message', { slug: 'two-sum', message: 'why?' });
  const first = await readUntil(response, (text) => text.includes('first half'));
  const runId = JSON.parse(/^event: run\ndata: (.*)$/m.exec(first.text)[1]).id;
  await first.cancel();

  // Exactly what a reloaded page does.
  const again = await fetch(`${f.base}/api/coach/runs/${runId}`, { headers: { accept: 'text/event-stream' } });
  const all = await again.text();

  // The whole answer, from the beginning — including the part that arrived and was
  // painted before the connection dropped. `slow` streams "Hello, " then "first half. "
  // before the pause, so a replay that only had the tail would be missing both.
  assert.equal(tokensIn(all), 'Hello, first half. second half.');
  assert.match(all, /^event: done$/m);
  assert.equal(f.spawnCount(), 1, 're-attaching must not start a second coach');
});

test('a second ask while one is in flight joins it rather than starting another', async (t) => {
  const f = await fixture({ delayMs: 500 });
  t.after(f.close);

  const a = await post(f.base, '/api/coach/message', { slug: 'two-sum', message: 'why?' });
  const started = await readUntil(a, (text) => text.includes('first half'));

  // A page that reloaded and re-asked before adopting, or a second tab.
  const b = await post(f.base, '/api/coach/message', { slug: 'two-sum', message: 'why?' });
  const joined = await b.text();

  assert.equal(f.spawnCount(), 1, 'two CLI processes on one problem interleave two answers into one thread');
  assert.match(tokensIn(joined), /first half/);
  await started.cancel();
});

test('Stop is now the only thing that ends a turn early, and it keeps what arrived', async (t) => {
  const f = await fixture({ mode: 'hang' });
  t.after(f.close);

  const response = await post(f.base, '/api/coach/message', { slug: 'two-sum', message: 'why?' });
  const open = await readUntil(response, (text) => text.includes('event: token'));

  const stopped = await post(f.base, '/api/coach/stop', { slug: 'two-sum' });
  assert.equal((await stopped.json()).stopped, true);

  const gone = await waitFor(async () => {
    const list = await (await fetch(`${f.base}/api/coach/runs`)).json();
    const run = list.runs.find((r) => r.slug === 'two-sum');
    return run && run.status !== 'running' ? run : null;
  });
  assert.equal(gone?.status, 'stopped');

  const raw = await fsp.readFile(path.join(f.root, 'problems', 'two-sum', 'chats.jsonl'), 'utf8');
  const turn = JSON.parse(raw.trim().split('\n').at(-1));
  assert.equal(turn.stopped, true, 'a real stop IS a stop, and says so');
  assert.ok(turn.answer.length > 0, 'the half you got is the half worth keeping');
  await open.cancel();
});

test('a run id that is not held any more is an honest 404, not an empty stream', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const res = await fetch(`${f.base}/api/coach/runs/coach-nope-1`);
  assert.equal(res.status, 404);
});
