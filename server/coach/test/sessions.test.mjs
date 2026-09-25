import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  SessionLog,
  CoachSessionStore,
  isoWithOffset,
  newSessionId,
  SESSION_GAP_MS,
} from '../sessions.mjs';

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-coach-'));
}

test('timestamps are ISO-8601 and carry a timezone offset', () => {
  const stamp = isoWithOffset(new Date());
  assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  // And it must round-trip to the same instant.
  const now = new Date();
  assert.equal(Date.parse(isoWithOffset(now)), now.getTime());
});

test('session ids are filename-safe and sort chronologically', () => {
  const a = newSessionId(new Date('2026-07-25T08:00:00.000Z'));
  const b = newSessionId(new Date('2026-07-25T18:54:05.818Z'));
  assert.ok(!a.includes(':'));
  assert.ok(a < b);
});

test('appendEvent writes one JSON line per event and never rewrites', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });

  await log.appendEvent('two-sum', 'problem_opened');
  await log.appendEvent('two-sum', 'first_keystroke');
  await log.appendEvent('two-sum', 'run_result', { ok: true, summary: { passed: 3, total: 3 } });

  const files = await log.listSessionFiles('two-sum');
  assert.equal(files.length, 1);
  const raw = await fsp.readFile(files[0].file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 3);
  assert.equal(JSON.parse(lines[0]).type, 'problem_opened');
  assert.equal(JSON.parse(lines[2]).data.summary.passed, 3);
  assert.ok(raw.endsWith('\n'));

  // Appending again leaves the earlier bytes byte-for-byte identical.
  await log.appendEvent('two-sum', 'submitted');
  const raw2 = await fsp.readFile(files[0].file, 'utf8');
  assert.ok(raw2.startsWith(raw));
});

test('200 concurrent appends all land, one per line, none interleaved', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });
  await log.appendEvent('concurrent', 'problem_opened');

  const N = 200;
  const payload = 'x'.repeat(4096); // well past PIPE_BUF, so ordering is doing real work
  await Promise.all(
    Array.from({ length: N }, (_, i) =>
      log.appendEvent('concurrent', 'run_result', { i, filler: payload }),
    ),
  );

  const files = await log.listSessionFiles('concurrent');
  assert.equal(files.length, 1);
  const raw = await fsp.readFile(files[0].file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, N + 1);

  const seen = new Set();
  for (const line of lines.slice(1)) {
    const obj = JSON.parse(line); // throws if a write was torn — that is the assertion
    seen.add(obj.data.i);
    assert.equal(obj.data.filler.length, 4096);
  }
  assert.equal(seen.size, N);
});

test('concurrent appends from two independent SessionLog instances still all land', async () => {
  const root = await tempRoot();
  const a = new SessionLog({ root });
  const b = new SessionLog({ root });
  await a.appendEvent('two-writers', 'problem_opened');

  await Promise.all([
    ...Array.from({ length: 50 }, (_, i) => a.appendEvent('two-writers', 'ran_locally', { w: 'a', i })),
    ...Array.from({ length: 50 }, (_, i) => b.appendEvent('two-writers', 'ran_locally', { w: 'b', i })),
  ]);

  const events = (await a.readSessions('two-writers'))[0].events;
  assert.equal(events.length, 101);
  assert.equal(events.filter((e) => e.data?.w === 'a').length, 50);
  assert.equal(events.filter((e) => e.data?.w === 'b').length, 50);
});

test('problem_opened starts a new session; a long gap does too; a short gap does not', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });
  const t0 = Date.parse('2026-07-25T10:00:00.000Z');

  const first = await log.appendEvent('gaps', 'problem_opened', null, { now: t0 });
  const same = await log.appendEvent('gaps', 'ran_locally', null, { now: t0 + 60_000 });
  assert.equal(same.sessionId, first.sessionId);

  // The gap is measured from the last event (t0 + 60s), so this is comfortably past it.
  const afterGap = await log.appendEvent('gaps', 'ran_locally', null, {
    now: t0 + SESSION_GAP_MS + 120_000,
  });
  assert.notEqual(afterGap.sessionId, first.sessionId);

  const reopened = await log.appendEvent('gaps', 'problem_opened', null, {
    now: t0 + SESSION_GAP_MS + 180_000,
  });
  assert.notEqual(reopened.sessionId, afterGap.sessionId);

  const sessions = await log.readSessions('gaps');
  assert.equal(sessions.length, 3);
  assert.ok(sessions[0].startedAt);
  assert.ok(sessions[0].endedAt);
  assert.ok(sessions[0].id < sessions[1].id); // oldest first
});

test('unknown event types are rejected rather than stored', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });
  await assert.rejects(() => log.appendEvent('two-sum', 'made_coffee'), /Unknown session event type/);
});

test('a corrupt line is skipped on read, not repaired', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });
  await log.appendEvent('torn', 'problem_opened');
  const [{ file }] = await log.listSessionFiles('torn');
  await fsp.appendFile(file, '{"at":"broken\n');
  await log.appendEvent('torn', 'submitted');

  const before = await fsp.readFile(file, 'utf8');
  const events = await log.readSessionFile(file);
  assert.equal(events.length, 2);
  const after = await fsp.readFile(file, 'utf8');
  assert.equal(after, before); // reading did not rewrite anything
});

test('reading sessions for a problem that was never opened is empty, not an error', async () => {
  const root = await tempRoot();
  const log = new SessionLog({ root });
  assert.deepEqual(await log.readSessions('never-touched'), []);
});

test('CoachSessionStore remembers a session id per problem and forgets on demand', async () => {
  const root = await tempRoot();
  const store = new CoachSessionStore({ root });

  assert.equal(await store.read('two-sum'), null);
  await store.remember('two-sum', 'sess-A');
  await store.remember('two-sum', 'sess-A');
  await store.remember('valid-anagram', 'sess-B');

  const a = await store.read('two-sum');
  assert.equal(a.sessionId, 'sess-A');
  assert.equal(a.turns, 2);
  assert.equal((await store.read('valid-anagram')).sessionId, 'sess-B');

  await store.forget('two-sum');
  assert.equal(await store.read('two-sum'), null);
  assert.equal((await store.read('valid-anagram')).sessionId, 'sess-B');
});

test('a corrupt coach-session.json reads as "no session" rather than throwing', async () => {
  const root = await tempRoot();
  const store = new CoachSessionStore({ root });
  await fsp.mkdir(path.join(root, 'problems', 'broken'), { recursive: true });
  await fsp.writeFile(store.file('broken'), '{not json');
  assert.equal(await store.read('broken'), null);
});
