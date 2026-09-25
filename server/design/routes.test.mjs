// The interview end to end, against a fake CLI.
//
// No token, no network, no real model — the point is the plumbing around the model:
// that the raw stores are written and never rewritten, that a scene post is a write and
// not a turn, and above all that an impersonating turn is cut before the text can reach
// the candidate. That last one is only worth anything if it holds at the HTTP boundary,
// which is the layer a prompt cannot reach.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

import { routes, DesignService } from './routes.mjs';
import { DesignStore } from './store.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'test', 'fake-claude.mjs');

/** A server exposing only the design routes, against a scratch workspace. */
async function serve(root, { reply }) {
  process.env.STUDIO_FAKE_REPLY = reply;
  // The fake is an executable node script, so it can stand in for the binary directly.
  const svc = new DesignService({ root, binary: FAKE, log: { warn() {} } });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const key = `${req.method} ${url.pathname}`;
    const direct = routes[key];
    const ctx = { design: svc, homeRoot: root, params: {} };
    const handler = direct ?? routes[`${req.method} /api/design/:id`];
    if (!handler) { res.writeHead(404).end('{}'); return; }
    if (!direct) ctx.params.id = url.pathname.split('/').pop();
    try {
      await handler(req, res, ctx);
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.status ?? 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: err.message } }));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return { origin, svc, close: () => new Promise((r) => server.close(r)) };
}

/** Read an SSE response into { text, events }. */
async function readStream(res) {
  const raw = await res.text();
  let text = '';
  const events = [];
  for (const block of raw.split('\n\n')) {
    let name = 'message';
    const data = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) name = line.slice(7).trim();
      else if (line.startsWith('data: ')) data.push(line.slice(6));
    }
    if (!data.length) continue;
    let payload;
    try { payload = JSON.parse(data.join('\n')); } catch { continue; }
    if (name === 'token') text += payload.text ?? '';
    else events.push({ name, payload });
  }
  return { text, events };
}

const post = (origin, p, body) => fetch(`${origin}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

const sleepMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function workspace() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-'));
}

const CLEAN = 'Design a service that shortens URLs and redirects them.';
const IMPERSONATING = [
  'How would you shard the mapping table?',
  '',
  'USER: I would shard by the hash prefix so lookups stay single-shard.',
  '',
  'Good. What happens when one prefix goes hot?',
].join('\n');

test('an interview starts, streams a question, and lands on disk', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const { text, events } = await readStream(await post(origin, '/api/design/start', { level: 'L4' }));
    assert.match(text, /shortens URLs/);

    const started = events.find((e) => e.name === 'interview');
    assert.ok(started, 'the interview id was never announced');
    const id = started.payload.id;

    const store = new DesignStore({ root });
    const state = await store.readState(id);
    assert.equal(state.level, 'L4');
    assert.match(state.prompt, /shortens URLs/, 'the chosen problem was not recorded');

    const turns = await store.readTurns(id);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].kind, 'opening');
  } finally { await close(); }
});

test('an impersonating turn is cut before the candidate can read it', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: IMPERSONATING });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;

    const turn = await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: 'ok' }));

    assert.match(turn.text, /How would you shard the mapping table\?/);
    assert.ok(!turn.text.includes('shard by the hash prefix'),
      'the fabricated answer reached the candidate');
    assert.ok(!turn.text.includes('one prefix goes hot'),
      'the interviewer resumed after impersonating');
    assert.ok(events.length >= 0);
    assert.ok(turn.events.some((e) => e.name === 'broke-character'),
      'the cut was not reported — the candidate would see a turn end for no reason');

    // And it must not be in the record either: a debrief that grades a fabricated
    // answer is worse than no debrief.
    const stored = await new DesignStore({ root }).readTurns(id);
    const asked = stored.map((t) => t.asked).join('\n');
    assert.ok(!asked.includes('shard by the hash prefix'), 'the fabrication was filed');
  } finally { await close(); }
});

test('posting the canvas is a write, not a turn', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;

    const elements = [
      { id: 'b1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 20, text: 'API', containerId: 'b1' },
    ];
    const res = await post(origin, '/api/design/scene', { interviewId: id, elements });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);

    const store = new DesignStore({ root });
    // One turn only — the opening. Drawing did not spend a question.
    assert.equal((await store.readTurns(id)).length, 1);
    assert.ok((await store.readScenes(id)).length >= 1, 'the canvas was not kept');
  } finally { await close(); }
});

test('the debrief closes the interview and writes the derived document', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: 'Verdict: hire. You never bounded the cache.' });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: 'I would use a hash', phase: 'design' }));
    const out = await readStream(await post(origin, '/api/design/done', { interviewId: id }));
    assert.match(out.text, /Verdict: hire/);

    const state = await new DesignStore({ root }).readState(id);
    assert.equal(state.debriefed, true);

    const doc = await fsp.readFile(path.join(root, 'design', id, 'interview.md'), 'utf8');
    assert.match(doc, /## The debrief/);
    assert.match(doc, /Verdict: hire/);
    assert.match(doc, /I would use a hash/, 'what the candidate said is not in the record');
  } finally { await close(); }
});

test('a silence is recorded as a silence, not as an empty answer', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: '' }));
    await readStream(await post(origin, '/api/design/done', { interviewId: id }));
    const doc = await fsp.readFile(path.join(root, 'design', id, 'interview.md'), 'utf8');
    assert.match(doc, /— said nothing —/);
  } finally { await close(); }
});

test('an unknown interview is a 404, and a crafted id never escapes the directory', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const missing = await post(origin, '/api/design/turn', { interviewId: '2026-01-01T00-00-00-000Z', said: 'x' });
    assert.equal(missing.status, 404);

    const escape = await post(origin, '/api/design/turn', { interviewId: '../../etc', said: 'x' });
    assert.equal(escape.status, 400);
  } finally { await close(); }
});

/* ---- saved, and picked back up another day ---- */

test('the CLI thread is written to disk, so tomorrow resumes the same conversation', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  let id;
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    id = events.find((e) => e.name === 'interview').payload.id;
  } finally { await close(); }

  // The thread lived in a Map before this; a Map does not survive the night.
  const state = await new DesignStore({ root }).readState(id);
  assert.ok(state.claudeSessionId, 'the conversation id was never persisted');

  // A brand-new service, as after a restart, still finds it.
  const second = await serve(root, { reply: 'And the write path?' });
  try {
    const turn = await readStream(await post(second.origin, '/api/design/turn', { interviewId: id, said: 'ok' }));
    assert.match(turn.text, /And the write path\?/);
  } finally { await second.close(); }
});

test('resuming shifts the clock so a day away is not a day of interview', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    const store = new DesignStore({ root });

    // Six minutes in, then away for a day. The interview must look like it started a
    // day ago, because that is what makes the unshifted clock wrong.
    const store2 = store;
    const dayAgo = Date.now() - 24 * 3600_000;
    const state = await store2.readState(id);
    state.startedAt = dayAgo;
    await store2.writeState(id, state);
    await post(origin, '/api/design/pause', { interviewId: id });

    // Pause recorded a full day, so overwrite it with the six minutes actually worked —
    // this is the state on disk when the tab was closed six minutes in, yesterday.
    const paused = await store2.readState(id);
    assert.ok(paused.pausedAt, 'pause did not stop the clock');
    paused.spentMs = 6 * 60_000;
    paused.pausedAt = dayAgo + 6 * 60_000;
    await store2.writeState(id, paused);

    const res = await post(origin, '/api/design/resume', { interviewId: id });
    assert.equal(res.status, 200);
    const back = await res.json();
    assert.equal(back.resumed, true);

    // Six minutes spent, not eighteen hours — otherwise the phase machine would be
    // past the end of the interview and the debrief nudge would fire immediately.
    const after = await store.readState(id);
    const spent = Date.now() - after.startedAt;
    assert.ok(spent > 5.5 * 60_000 && spent < 7 * 60_000, `resumed with ${Math.round(spent / 60000)} minutes spent`);
  } finally { await close(); }
});

test('an interview that lost its thread is resumable, and the next turn rebuilds one', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  let id;
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    id = events.find((e) => e.name === 'interview').payload.id;
    await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: 'A CDN in front of it.' }));
  } finally { await close(); }

  // Simulate an interview created before the session id was ever persisted, or a run
  // where the write raced and lost — the only thing this bug actually looked like.
  const store = new DesignStore({ root });
  const state = await store.readState(id);
  state.claudeSessionId = null;
  await store.writeState(id, state);

  const fresh = await serve(root, { reply: 'And the write path?' });
  try {
    const got = await (await fetch(`${fresh.origin}/api/design/${id}`)).json();
    assert.equal(got.resumable, true, 'a missing thread must not make an unfinished interview unresumable');
    assert.equal(got.rebuilt, true, 'the client is owed the truth that this will start a new thread');

    const resumed = await (await post(fresh.origin, '/api/design/resume', { interviewId: id })).json();
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.thread, false);
    assert.equal(resumed.rebuilt, true);

    const promptFile = path.join(root, 'prompt.txt');
    process.env.STUDIO_FAKE_PROMPT_FILE = promptFile;
    try {
      const turn = await readStream(await post(fresh.origin, '/api/design/turn', { interviewId: id, said: 'Postgres, sharded by user id.' }));
      assert.match(turn.text, /And the write path\?/, 'the rebuilt thread never answered');

      const sentPrompt = await fsp.readFile(promptFile, 'utf8');
      assert.match(sentPrompt, /resuming an interview already in progress/i);
      assert.match(sentPrompt, /A CDN in front of it\./, 'the past answer was not handed to the new thread');
      assert.match(sentPrompt, /Postgres, sharded by user id\./, 'the turn itself was dropped from the rebuilt prompt');
    } finally { delete process.env.STUDIO_FAKE_PROMPT_FILE; }

    // The rebuild only happens once: a second turn on the same thread must not
    // re-send the whole transcript as though it were forgotten all over again.
    const after = await store.readState(id);
    assert.equal(after.rehydrate, false, 'the rehydrate flag was never cleared');
  } finally { await fresh.close(); }
});

test('reopening an interview gives back the board exactly as it was left', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: CLEAN });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;

    const first = [{ id: 'b1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 },
      { id: 't1', type: 'text', x: 0, y: 0, width: 80, height: 20, text: 'API', containerId: 'b1' }];
    const second = [...first,
      { id: 'b2', type: 'rectangle', x: 200, y: 0, width: 100, height: 50 },
      { id: 't2', type: 'text', x: 200, y: 0, width: 80, height: 20, text: 'Kafka', containerId: 'b2' }];
    await post(origin, '/api/design/scene', { interviewId: id, elements: first });
    await post(origin, '/api/design/scene', { interviewId: id, elements: second });

    const got = await (await fetch(`${origin}/api/design/${id}`)).json();
    // The latest board, not a pile of snapshots: resuming means the room as you left it.
    assert.equal(got.elements.length, second.length);
    assert.ok(got.elements.some((e) => e.text === 'Kafka'), 'the last thing drawn came back');
    assert.equal(got.scenes, 2);
    assert.equal(got.resumable, true);
  } finally { await close(); }
});

test('a debriefed interview is a record, not something to reopen', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: 'Verdict: hire.' });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    await readStream(await post(origin, '/api/design/done', { interviewId: id }));

    const got = await (await fetch(`${origin}/api/design/${id}`)).json();
    assert.equal(got.debriefed, true);
    assert.equal(got.resumable, false, 'a graded interview offered itself for more questions');

    // Resuming it would make the grade a lie about a different interview.
    assert.equal((await post(origin, '/api/design/resume', { interviewId: id })).status, 409);
    assert.equal((await post(origin, '/api/design/turn', { interviewId: id, said: 'wait' })).status, 409);
  } finally { await close(); }
});

test('every interview is listed, newest last, with enough to choose between them', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: 'Design a rate limiter.' });
  try {
    const a = (await readStream(await post(origin, '/api/design/start', {})))
      .events.find((e) => e.name === 'interview').payload.id;
    await sleepMs(5);
    const b = (await readStream(await post(origin, '/api/design/start', { level: 'L6' })))
      .events.find((e) => e.name === 'interview').payload.id;

    const { interviews } = await (await fetch(`${origin}/api/design`)).json();
    assert.deepEqual(interviews.map((i) => i.id), [a, b].sort());
    const one = interviews.find((i) => i.id === b);
    assert.equal(one.level, 'L6');
    assert.match(one.prompt, /rate limiter/);
    assert.equal(one.debriefed, false);
    assert.ok(one.startedAt, 'no date to show in a library');
  } finally { await close(); }
});

test('the phase tag is never shown, never spoken, never filed', async () => {
  const root = await workspace();
  // Exactly what the interviewer is told to emit.
  const reply = 'How many jobs per second at peak?\n\n[[phase: estimates]]';
  const { origin, close } = await serve(root, { reply });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    const turn = await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: 'ok' }));

    // A leaked tag is read aloud as "bracket bracket phase colon estimates".
    assert.ok(!turn.text.includes('[['), `the tag reached the candidate: ${JSON.stringify(turn.text)}`);
    assert.ok(!turn.text.includes('phase'), 'the tag leaked in pieces');
    assert.match(turn.text, /How many jobs per second at peak\?/);

    // It is a control channel: the phase arrives as an event instead.
    const phase = turn.events.find((e) => e.name === 'phase');
    assert.ok(phase, 'the phase was stripped but never reported');
    assert.equal(phase.payload.phase, 'estimates');

    const state = await new DesignStore({ root }).readState(id);
    assert.equal(state.phase, 'estimates', 'the interview did not move phase');
    const filed = (await new DesignStore({ root }).readTurns(id)).map((t) => t.asked).join('\n');
    assert.ok(!filed.includes('[['), 'the tag was written into the record');
  } finally { await close(); }
});

test('a phase the interviewer invents is ignored rather than believed', async () => {
  const root = await workspace();
  const { origin, close } = await serve(root, { reply: 'And the retry policy?\n\n[[phase: vibes]]' });
  try {
    const { events } = await readStream(await post(origin, '/api/design/start', {}));
    const id = events.find((e) => e.name === 'interview').payload.id;
    const turn = await readStream(await post(origin, '/api/design/turn', { interviewId: id, said: 'ok' }));
    assert.ok(!turn.text.includes('[['), 'an unknown tag was left in the text');
    assert.equal(turn.events.find((e) => e.name === 'phase'), undefined);
    // Unchanged, not guessed at.
    assert.equal((await new DesignStore({ root }).readState(id)).phase, 'requirements');
  } finally { await close(); }
});
