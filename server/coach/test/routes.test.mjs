// End-to-end over a real node:http server, with a fake `claude` on disk.
// The router does not exist yet (the main agent wires the route table in), so this test
// stands one up from `routes` exactly as the contract's integration rule describes.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { routes, CoachService } from '../routes.mjs';
import { HttpError, sendError } from '../../http-util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'bin', 'fake-claude.mjs');

/** A minimal stand-in for the router the main agent will write. */
function serverFor(ctx) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const segments = url.pathname.split('/').filter(Boolean);

    let key = `${req.method} ${url.pathname}`;
    let params = {};
    if (segments[0] === 'api' && segments[1] === 'sessions' && segments.length === 3 && req.method === 'GET') {
      key = 'GET /api/sessions/:slug';
      params = { slug: segments[2] };
    }

    const handler = routes[key];
    if (!handler) return sendError(res, 404, 'NOT_FOUND', 'no such route');

    Promise.resolve(handler(req, res, { ...ctx, params })).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', String(err));
    });
  });
  return server;
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(base, route, body) {
  const res = await fetch(base + route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

/** Read an SSE response into a list of {event, data} — using a strict parser, so a
 *  framing bug shows up as a parse failure rather than a passing test. */
async function readSse(response) {
  const text = await response.text();
  const events = [];
  for (const block of text.split('\n\n')) {
    if (block.trim() === '' || block.startsWith(':')) continue;
    const lines = block.split('\n').filter((l) => l !== '' && !l.startsWith(':'));
    const name = lines.find((l) => l.startsWith('event: '))?.slice(7);
    const data = lines
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(l.startsWith('data: ') ? 6 : 5))
      .join('\n');
    if (name) events.push({ event: name, data: JSON.parse(data) });
  }
  return events;
}

async function fixture({ mode = 'ok', binary = FAKE, extraEnv = {} } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-routes-'));
  const coach = new CoachService({
    root,
    binary,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode, ...extraEnv },
    timeoutMs: 15_000,
    log: { warn() {}, error() {} },
  });
  const server = serverFor({ coach });
  const base = await listen(server);
  return { root, coach, server, base, close: () => new Promise((r) => server.close(r)) };
}

// ------------------------------------------------------------- POST /api/sessions/event

test('POST /api/sessions/event appends and reports the session it landed in', async (t) => {
  const f = await fixture();
  t.after(f.close);

  const a = await postJson(f.base, '/api/sessions/event', { slug: 'two-sum', type: 'problem_opened' });
  assert.equal(a.status, 200);
  assert.match(a.json.at, /^\d{4}-\d{2}-\d{2}T.*[+-]\d{2}:\d{2}$/);
  assert.equal(a.json.file, path.join('problems', 'two-sum', 'sessions', `${a.json.sessionId}.jsonl`));

  const b = await postJson(f.base, '/api/sessions/event', {
    slug: 'two-sum',
    type: 'run_result',
    data: { ok: true, summary: { passed: 3, total: 3 } },
  });
  assert.equal(b.json.sessionId, a.json.sessionId);

  const raw = await fsp.readFile(path.join(f.root, 'problems', 'two-sum', 'sessions', `${a.json.sessionId}.jsonl`), 'utf8');
  assert.equal(raw.split('\n').filter(Boolean).length, 2);
});

test('a bad slug, a bad type and a non-object data are all refused with a real message', async (t) => {
  const f = await fixture();
  t.after(f.close);

  assert.equal((await postJson(f.base, '/api/sessions/event', { slug: '../etc', type: 'problem_opened' })).status, 400);
  const bad = await postJson(f.base, '/api/sessions/event', { slug: 'two-sum', type: 'made_coffee' });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /must be one of/);
  assert.equal(
    (await postJson(f.base, '/api/sessions/event', { slug: 'two-sum', type: 'verdict', data: 'nope' })).status,
    400,
  );
});

// --------------------------------------------------------------- GET /api/sessions/:slug

test('GET /api/sessions/:slug returns every session, oldest first, with its events', async (t) => {
  const f = await fixture();
  t.after(f.close);

  await f.coach.sessionLog.appendEvent('two-sum', 'problem_opened', null, { now: Date.now() - 86_400_000 });
  await f.coach.sessionLog.appendEvent('two-sum', 'submitted', null, { now: Date.now() - 86_300_000 });
  await f.coach.sessionLog.appendEvent('two-sum', 'problem_opened');
  await f.coach.sessionLog.appendEvent('two-sum', 'first_keystroke');

  const res = await fetch(`${f.base}/api/sessions/two-sum`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.sessions.length, 2);
  assert.ok(body.sessions[0].id < body.sessions[1].id);
  assert.equal(body.sessions[0].events.length, 2);
  assert.ok(body.sessions[0].startedAt);
  assert.ok(body.sessions[0].endedAt);
});

test('GET /api/sessions/:slug for an untouched problem is an empty list, not a 404', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const res = await fetch(`${f.base}/api/sessions/never-opened`);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).sessions, []);
});

// -------------------------------------------------------------- POST /api/coach/message

test('a coach turn streams token, tool and done in the contract shape', async (t) => {
  const f = await fixture();
  t.after(f.close);

  const res = await fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'why is case 1 failing?', includeCode: true }),
  });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');

  const events = await readSse(res);
  const names = events.map((e) => e.event);
  assert.ok(names.includes('token'));
  assert.ok(names.includes('tool'));
  assert.equal(names[names.length - 1], 'done');
  assert.ok(!names.includes('error'));

  assert.equal(events.filter((e) => e.event === 'token').map((e) => e.data.text).join(''), 'Hello, coach here.');
  const tool = events.find((e) => e.event === 'tool');
  assert.deepEqual(tool.data, { name: 'Read', summary: 'problems/two-sum/NOTES.md' });
  const done = events.at(-1);
  assert.equal(done.data.stoppedReason, 'end_turn');
  assert.ok(done.data.sessionId);
});

test('multi-line model output survives SSE framing intact', async (t) => {
  const f = await fixture({ mode: 'multiline' });
  t.after(f.close);

  const res = await fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'draw me a table' }),
  });
  const events = await readSse(res);
  const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
  assert.equal(text, 'line one\nline two\n\nline four with a lone \r carriage return');
});

test('asking the coach is itself logged as a session event', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await readSse(
    await fetch(`${f.base}/api/coach/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'two-sum', message: 'help me' }),
    }),
  );
  const sessions = await f.coach.sessionLog.readSessions('two-sum');
  const asked = sessions[0].events.filter((e) => e.type === 'asked_coach');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].data.message, 'help me');
});

// -------------------------------------------------------------------- session resumption

test('the first turn starts a session; the next turn for that problem resumes exactly it', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-resume-'));
  const argsFile = path.join(root, 'args.json');
  const coach = new CoachService({
    root,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_ARGS_FILE: argsFile },
    timeoutMs: 15_000,
    log: { warn() {}, error() {} },
  });
  const server = serverFor({ coach });
  const base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const ask = (slug, message) =>
    fetch(`${base}/api/coach/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug, message }),
    }).then(readSse);

  const first = await ask('two-sum', 'first question');
  const firstArgs = JSON.parse(await fsp.readFile(argsFile, 'utf8'));
  assert.ok(firstArgs.includes('--session-id'), 'the first turn should start a session');
  assert.ok(!firstArgs.includes('--resume'));
  const sessionId = first.at(-1).data.sessionId;
  assert.equal(sessionId, firstArgs[firstArgs.indexOf('--session-id') + 1]);

  // A different problem must not inherit it.
  await ask('valid-anagram', 'unrelated question');
  const otherArgs = JSON.parse(await fsp.readFile(argsFile, 'utf8'));
  assert.ok(otherArgs.includes('--session-id'));
  assert.notEqual(otherArgs[otherArgs.indexOf('--session-id') + 1], sessionId);

  // Back to the first problem: resume that conversation, not the other one.
  const second = await ask('two-sum', 'a week later');
  const resumeArgs = JSON.parse(await fsp.readFile(argsFile, 'utf8'));
  assert.ok(resumeArgs.includes('--resume'), 'the second turn should resume');
  assert.equal(resumeArgs[resumeArgs.indexOf('--resume') + 1], sessionId);
  assert.equal(second.at(-1).data.sessionId, sessionId);

  const stored = JSON.parse(await fsp.readFile(path.join(root, 'problems', 'two-sum', 'coach-session.json'), 'utf8'));
  assert.equal(stored.sessionId, sessionId);
  assert.equal(stored.turns, 2);
});

test('a session id that no longer resumes is reported once and then forgotten', async (t) => {
  const f = await fixture({ mode: 'noresume' });
  t.after(f.close);
  await f.coach.coachSessions.remember('two-sum', 'sess-from-a-deleted-machine');

  const events = await fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'hello again' }),
  }).then(readSse);

  const errors = events.filter((e) => e.event === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].data.message, /could not resume/);
  // The dead pointer is gone, so the next turn starts clean instead of failing forever.
  assert.equal(await f.coach.coachSessions.read('two-sum'), null);
});

// ------------------------------------------------------------------------- failure paths

test('a missing claude binary yields exactly one error event and a clean close', async (t) => {
  const f = await fixture({ binary: '/nonexistent/claude-not-installed' });
  t.after(f.close);

  const res = await fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'are you there?' }),
  });
  assert.equal(res.status, 200); // the stream opened; the failure is in-band
  const events = await readSse(res);
  // `run` comes first now — it carries the id a reloaded page re-attaches by. What this
  // test is about is that the failure is reported once and the stream then ends.
  assert.deepEqual(events.map((e) => e.event), ['run', 'error']);
  assert.match(events[1].data.message, /was not found on this machine/);

  // And the rest of the app is unaffected.
  assert.equal((await postJson(f.base, '/api/sessions/event', { slug: 'two-sum', type: 'ran_locally' })).status, 200);
});

test('a child that dies mid-stream leaves the tokens already sent plus one error', async (t) => {
  const f = await fixture({ mode: 'crash' });
  t.after(f.close);

  const events = await fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'hi' }),
  }).then(readSse);

  assert.deepEqual(
    events.map((e) => e.event),
    ['run', 'token', 'error'],
  );
  assert.match(events[2].data.message, /stopped unexpectedly/);
});

test('a disconnect leaves the turn running; Stop kills it, and its grandchildren too', async (t) => {
  // This used to assert that a disconnect killed the CLI. That was the bug: a page
  // reload is a disconnect, and it took the answer with it. So the contract is inverted
  // — but the guarantee it was protecting is not. Nothing may leak, so the process-group
  // kill is still checked, on the path that is now the only one that ends a turn early.
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-abort-'));
  const pidsFile = path.join(root, 'pids.json');
  const coach = new CoachService({
    root,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'spawnchild', FAKE_CLAUDE_PIDS_FILE: pidsFile },
    timeoutMs: 30_000,
    log: { warn() {}, error() {} },
  });
  const server = serverFor({ coach });
  const base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  const controller = new AbortController();
  const request = fetch(`${base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'think for a long time' }),
    signal: controller.signal,
  });

  let pids;
  for (let i = 0; i < 200 && !pids; i += 1) {
    try {
      pids = JSON.parse(await fsp.readFile(pidsFile, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  assert.ok(pids?.grandchild, 'the fake CLI never started');

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };

  controller.abort();
  await request.catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(alive(pids.child), true, 'a disconnect must not stop the coach — that is what a reload is');

  await fetch(`${base}/api/coach/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum' }),
  });

  for (let i = 0; i < 200 && (alive(pids.child) || alive(pids.grandchild)); i += 1) {
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(alive(pids.child), false, 'the coach process leaked after Stop');
  assert.equal(alive(pids.grandchild), false, 'a grandchild leaked after Stop');
});

test('the prompt handed to the CLI fences the buffer and forbids the server-owned files', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-prompt-'));
  const promptFile = path.join(root, 'prompt.txt');
  await fsp.mkdir(path.join(root, 'problems', 'two-sum'), { recursive: true });
  await fsp.writeFile(path.join(root, 'problems', 'two-sum', 'solution.py'), 'class Solution:\n    pass\n');

  const coach = new CoachService({
    root,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_PROMPT_FILE: promptFile },
    timeoutMs: 15_000,
    log: { warn() {}, error() {} },
  });
  const server = serverFor({ coach });
  const base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));

  await fetch(`${base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'take a look' }),
  }).then(readSse);

  const prompt = await fsp.readFile(promptFile, 'utf8');
  assert.ok(prompt.includes('## CURRENT CONTEXT'));
  assert.ok(prompt.includes('UNTRUSTED DATA'));
  assert.ok(prompt.includes('class Solution:'));
  assert.ok(prompt.includes('`sessions/`'));
  assert.ok(prompt.trimEnd().endsWith('take a look'));
});

test('an empty message is refused with a normal 400 before any stream opens', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const res = await postJson(f.base, '/api/coach/message', { slug: 'two-sum', message: '   ' });
  assert.equal(res.status, 400);
  assert.match(res.json.error.message, /"message" is required/);
});

test('a turn stopped halfway still keeps what the coach had already said', async (t) => {
  // The half you got is the half worth keeping. Before this, `appendTurn` ran only from
  // onDone — and a killed CLI settles with no callback at all, so pressing Stop on a long
  // review threw the whole answer away the moment it left the screen.
  const f = await fixture({ mode: 'hang' });
  t.after(f.close);

  const abort = new AbortController();
  const request = fetch(`${f.base}/api/coach/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum', message: 'grade this attempt', kind: 'attempt-review', attemptId: 'A9' }),
    signal: abort.signal,
  });

  // Wait for the first token to have been streamed, then hang up like the Stop button.
  const res = await request;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  // The stream opens with a comment before any token; reading exactly one chunk would
  // abort before the coach had said anything, and the test would pass on an empty answer.
  for (let i = 0; i < 20 && !seen.includes('event: token'); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
  }
  assert.match(seen, /event: token/, 'no token arrived before the stop');
  // Press Stop. Hanging up is no longer a stop — that conflation is what made a page
  // reload end a turn — so this has to be the deliberate act it is meant to stand for.
  await fetch(`${f.base}/api/coach/stop`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'two-sum' }),
  });
  abort.abort();
  await reader.cancel().catch(() => {});

  const file = path.join(f.root, 'problems', 'two-sum', 'chats.jsonl');
  let turns = [];
  for (let i = 0; i < 60 && turns.length === 0; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const raw = await fsp.readFile(file, 'utf8').catch(() => '');
    turns = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  assert.equal(turns.length, 1, 'the stopped turn was never filed');
  assert.equal(turns[0].ask, 'grade this attempt');
  assert.equal(turns[0].answer, 'Hello, ', 'the partial answer was lost');
  assert.equal(turns[0].kind, 'attempt-review');
  assert.equal(turns[0].attemptId, 'A9');
  assert.equal(turns[0].stopped, true, 'a cut-off answer must be marked as one');
});
