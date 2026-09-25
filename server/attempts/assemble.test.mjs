// One attempt, put back together from six stores.
//
// The capture was never wrong — it was scattered. A 17-minute attempt lived as 10
// transcript files chopped every 120 seconds, 22 events in a file that also held a
// different attempt, code snapshots named in a different timezone format, and coach turns
// in a flat append-forever file. Every join existed; nothing performed one.
//
// What these tests hold down:
//   * the join is on the id where there is one, and on the window only where there is not
//   * a second attempt in the same sitting file does not bleed into the first
//   * missing data is reported as missing, never smoothed over
//   * the document is derived — same raw in, same bytes out

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { gatherAttempt, listAttempts, msFromSnapshotName } from './assemble.mjs';
import { renderAttempt, buildEntries, diffLines } from './render.mjs';

const A = '2026-07-30T14:48:35.508Z';
const B = '2026-07-30T15:20:00.000Z';

const at = (iso) => iso;

/** A workspace holding one sitting with TWO attempts in it — the case that used to bleed. */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-attempts-'));
  const dir = path.join(root, 'problems', 'search-a-2d-matrix');
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'transcripts'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'attempts'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'submissions'), { recursive: true });

  const events = [
    { at: at('2026-07-30T14:48:35.508Z'), type: 'attempt_started', data: { attemptId: A, mode: 'think_aloud' } },
    { at: at('2026-07-30T14:48:51.147Z'), type: 'recorded_audio', data: { attemptId: A, seconds: 15, transcript: 'one.json' } },
    { at: at('2026-07-30T14:50:51.345Z'), type: 'recorded_audio', data: { attemptId: A, seconds: 120, transcript: 'two.json' } },
    // No attemptId on these — exactly how the log has recorded them historically.
    { at: at('2026-07-30T14:51:43.000Z'), type: 'ran_locally', data: {} },
    { at: at('2026-07-30T14:51:44.000Z'), type: 'run_result', data: { ok: true, passed: 0, total: 2, totalMs: 70 } },
    { at: at('2026-07-30T14:54:38.000Z'), type: 'submitted', data: { submissionId: 2087661968, submissionUrl: 'https://leetcode.com/submissions/detail/2087661968/' } },
    { at: at('2026-07-30T14:54:40.000Z'), type: 'verdict', data: { accepted: true, verdict: 'Accepted', passed: 133, total: 133, runtime: '0 ms' } },
    { at: at('2026-07-30T14:54:41.000Z'), type: 'attempt_ended', data: { attemptId: A, elapsedSeconds: 366 } },
    // A SECOND attempt, same sitting file. None of this may reach attempt A.
    { at: at('2026-07-30T15:20:00.000Z'), type: 'attempt_started', data: { attemptId: B, mode: 'think_aloud' } },
    { at: at('2026-07-30T15:20:30.000Z'), type: 'run_result', data: { ok: true, passed: 2, total: 2, totalMs: 12 } },
    { at: at('2026-07-30T15:21:00.000Z'), type: 'attempt_ended', data: { attemptId: B, elapsedSeconds: 60 } },
  ];
  await fsp.writeFile(
    path.join(dir, 'sessions', '2026-07-30T14-48-35-509Z.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  // The 120s cut lands mid-sentence; that is the recorder's artefact, not a pause.
  await fsp.writeFile(path.join(dir, 'transcripts', 'one.json'), JSON.stringify({
    text: 'Okay, this is my second attempt, and the idea is', durationSeconds: 15, words: [{ word: 'Okay,' }],
  }));
  await fsp.writeFile(path.join(dir, 'transcripts', 'two.json'), JSON.stringify({
    text: 'clear now, so let me code it up.', durationSeconds: 120, words: [{ word: 'clear' }],
  }));

  await fsp.writeFile(path.join(dir, 'attempts', '2026-07-30T14-51-43-000Z.py'), 'def f():\n    pass\n');
  await fsp.writeFile(path.join(dir, 'attempts', '2026-07-30T14-54-30-000Z.py'), 'def f():\n    return True\n');
  // Belongs to attempt B's window, not A's.
  await fsp.writeFile(path.join(dir, 'attempts', '2026-07-30T15-20-25-000Z.py'), 'def f():\n    return False\n');

  await fsp.writeFile(path.join(dir, 'submissions', '2087661968.py'), 'def f():\n    return True\n');

  await fsp.writeFile(path.join(dir, 'chats.jsonl'),
    JSON.stringify({ at: '2026-07-30T14:53:00.000Z', ask: 'why the else?', answer: 'Because the loop must end.', attemptId: A, tools: [] }) + '\n'
    // Asked during A, filed 80 seconds AFTER Stop — a long answer, which is the normal
    // case. Only the id can claim this; the window has already closed on it.
    + JSON.stringify({ at: '2026-07-30T14:56:01.000Z', ask: 'and the complexity?', answer: 'Log n times log m.', attemptId: A, tools: [] }) + '\n'
    + JSON.stringify({ at: '2026-07-30T15:20:40.000Z', ask: 'and now?', answer: 'Different attempt.', attemptId: B, tools: [] }) + '\n');

  return { root, dir };
}

test('an attempt gathers only its own events, including the ones with no id', async () => {
  const { root } = await fixture();
  const attempt = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });

  const runs = attempt.events.filter((e) => e.type === 'run_result');
  assert.equal(runs.length, 1, 'attempt B\'s run bled in');
  assert.equal(runs[0].data.passed, 0);

  // ran_locally and submitted carry no attemptId in the historical log; the window is the
  // only thing that can claim them, and it must claim them correctly.
  assert.equal(attempt.submissions.length, 1);
  assert.equal(attempt.submissions[0].id, 2087661968);
  assert.equal(attempt.submissions[0].code, 'def f():\n    return True\n', 'the submitted code is read back');
});

test('the id beats the window: a turn keyed to another attempt never crosses over', async () => {
  const { root } = await fixture();
  const a = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });
  const b = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: B });
  // The second one finished after Stop. The window would drop it; the id keeps it, which
  // is the whole point — an identifier is a stronger claim than a clock.
  assert.deepEqual(a.chats.map((c) => c.ask), ['why the else?', 'and the complexity?']);
  assert.deepEqual(b.chats.map((c) => c.ask), ['and now?']);
});

test('code snapshots are claimed by window, and only the ones inside it', async () => {
  const { root } = await fixture();
  const a = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });
  assert.deepEqual(a.snapshots.map((s) => s.name), [
    '2026-07-30T14-51-43-000Z.py',
    '2026-07-30T14-54-30-000Z.py',
  ]);
});

test('an unbroken stretch of talking is one block, however the recorder chopped it', async () => {
  const { root } = await fixture();
  const a = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });
  const md = renderAttempt(a);

  // The 120s cut fell between "the idea is" and "clear now", and across a minute boundary
  // too. Both are artefacts of the recorder. What is real is that nothing was DONE between
  // them, so they are one stretch of thinking under one heading — chunk-stamped inside it
  // so a long stretch stays navigable, but never split into two documents.
  const block = /thinking aloud\n\n((?:>.*\n?)+)/.exec(md);
  assert.ok(block, `no thinking-aloud block:\n${md.slice(0, 500)}`);
  assert.match(block[1], /`00:15`  Okay, this is my second attempt, and the idea is$/m);
  assert.match(block[1], /`02:15`  clear now, so let me code it up\.$/m);
  assert.equal((md.match(/thinking aloud/g) ?? []).length, 1, 'the stretch was split in two');
});

test('a missing transcript is reported as missing, never as silence', async () => {
  const { root, dir } = await fixture();
  await fsp.rm(path.join(dir, 'transcripts', 'two.json'));
  const a = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });
  const md = renderAttempt(a);
  assert.match(md, /transcript missing on disk/);
  assert.match(md, /1 of 2 recordings have no transcript/);
  // And what did survive is still there — a gap does not discard the rest.
  assert.match(md, /Okay, this is my second attempt/);
});

test('the header states the outcome and the counts, taken from the log and not computed twice', async () => {
  const { root } = await fixture();
  const md = renderAttempt(await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A }));
  assert.match(md, /\*\*Outcome\*\* Accepted 133\/133/);
  assert.match(md, /\*\*Ran it\*\* 1 times/);
  assert.match(md, /\*\*Submitted\*\* 1 time$/m);
  assert.match(md, /\*\*Took\*\* 6 minutes/);
});

test('an attempt with no end is said to have no end, not quietly closed', async () => {
  const { root, dir } = await fixture();
  const file = path.join(dir, 'sessions', '2026-07-30T14-48-35-509Z.jsonl');
  const kept = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean)
    .filter((l) => !l.includes(`"attempt_ended"`) || !l.includes(A));
  await fsp.writeFile(file, kept.join('\n') + '\n');

  const a = await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A });
  assert.equal(a.ended, null);
  assert.match(renderAttempt(a), /has no end event/);
});

test('the document is derived: same raw in, same bytes out', async () => {
  const { root } = await fixture();
  const once = renderAttempt(await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A }));
  const twice = renderAttempt(await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A }));
  assert.equal(once, twice, 'regenerating must not produce a different file');
});

test('every attempt in the workspace is found, oldest first', async () => {
  const { root } = await fixture();
  assert.deepEqual(await listAttempts(root, 'search-a-2d-matrix'), [A, B]);
});

test('a snapshot filename is read back as the instant it was written', () => {
  assert.equal(msFromSnapshotName('2026-07-30T14-51-43-000Z.py'), Date.parse('2026-07-30T14:51:43.000Z'));
  assert.equal(msFromSnapshotName('not-a-snapshot.py'), null);
  assert.equal(msFromSnapshotName('2026-07-30T14-51-43-000Z.txt'), null);
});

test('the diff shows what changed, not the whole file', () => {
  const before = 'a\nb\nc\nd\ne\nf\ng\n';
  const after = 'a\nb\nc\nCHANGED\ne\nf\ng\n';
  const changed = diffLines(before, after).filter((l) => l.kind !== ' ');
  assert.deepEqual(changed, [{ kind: '-', text: 'd' }, { kind: '+', text: 'CHANGED' }]);
});

test('entries come out in time order across every store', async () => {
  const { root } = await fixture();
  const entries = buildEntries(await gatherAttempt({ root, slug: 'search-a-2d-matrix', attemptId: A }));
  const times = entries.map((e) => e.at);
  assert.deepEqual(times, [...times].sort((x, y) => x - y));
  // Speech, code, a run, a coach turn, a submission and a verdict all in one stream.
  const kinds = new Set(entries.map((e) => e.kind));
  for (const kind of ['said', 'code', 'run', 'coach', 'submitted', 'verdict']) {
    assert.ok(kinds.has(kind), `${kind} never made it into the timeline`);
  }
});
