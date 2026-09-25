import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildStats,
  readProblemDir,
  readSessionFile,
  statusOf,
  attemptStampOf,
  MIN_SAMPLES,
} from '../aggregate.mjs';

/* ------------------------------------------------------------------ fixtures */

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-stats-'));
}

/** Write a session log verbatim — including deliberately broken bytes. */
async function writeSession(root, slug, id, raw) {
  const dir = path.join(root, 'problems', slug, 'sessions');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${id}.jsonl`), raw, 'utf8');
}

function line(at, type, data) {
  return `${JSON.stringify(data === undefined ? { at, type } : { at, type, data })}\n`;
}

async function writeAttempts(root, slug, stamps) {
  const dir = path.join(root, 'problems', slug, 'attempts');
  await fsp.mkdir(dir, { recursive: true });
  for (const stamp of stamps) await fsp.writeFile(path.join(dir, `${stamp}.py`), 'pass\n', 'utf8');
}

/** A catalog shaped like the real one, small enough to reason about. */
const CATALOG = {
  patterns: ['Arrays & Hashing', 'Two Pointers', 'Graphs'],
  problems: [
    { slug: 'two-sum', title: 'Two Sum', number: 1, pattern: 'Arrays & Hashing', difficulty: 'Easy', lists: { blind75: true, neetcode150: true, neetcode250: true } },
    { slug: 'valid-anagram', title: 'Valid Anagram', number: 242, pattern: 'Arrays & Hashing', difficulty: 'Easy', lists: { blind75: true, neetcode150: true, neetcode250: true } },
    { slug: 'contains-duplicate', title: 'Contains Duplicate', number: 217, pattern: 'Arrays & Hashing', difficulty: 'Easy', lists: { blind75: false, neetcode150: true, neetcode250: true } },
    { slug: 'valid-palindrome', title: 'Valid Palindrome', number: 125, pattern: 'Two Pointers', difficulty: 'Easy', lists: { blind75: true, neetcode150: true, neetcode250: true } },
    { slug: 'number-of-islands', title: 'Number of Islands', number: 200, pattern: 'Graphs', difficulty: 'Medium', lists: { blind75: true, neetcode150: true, neetcode250: true } },
  ],
};

/* ------------------------------------------------------------------ zero data */

test('a workspace that does not exist reports absence, not zeros dressed as facts', async () => {
  const root = path.join(await tempRoot(), 'nope');
  const stats = await buildStats({ root, catalog: CATALOG });

  assert.equal(stats.workspace.exists, false);
  assert.equal(stats.workspace.problemDirs, 0);
  assert.equal(stats.workspace.eventsRead, 0);
  assert.equal(stats.totals.attempted, 0);
  assert.equal(stats.totals.accepted, 0);
  assert.deepEqual(stats.problems, []);
  assert.deepEqual(stats.activity, []);
  assert.deepEqual(stats.recent, []);

  // The denominators are still real — they come from the catalog, not from practice.
  assert.equal(stats.lists.blind75.total, 4);
  assert.equal(stats.lists.neetcode250.total, 5);
  assert.equal(stats.patterns.length, 3);
  assert.equal(stats.patterns.find((p) => p.name === 'Graphs').total, 1);

  // And no signal claims to mean anything.
  for (const signal of Object.values(stats.signals)) {
    assert.equal(signal.meaningful, false, `${signal.label} must not be meaningful with no data`);
    assert.equal(signal.samples, 0);
  }
});

test('an empty problems/ directory is distinguishable from a missing workspace', async () => {
  const root = await tempRoot();
  await fsp.mkdir(path.join(root, 'problems'), { recursive: true });
  const stats = await buildStats({ root, catalog: CATALOG });

  assert.equal(stats.workspace.exists, true);
  assert.equal(stats.workspace.problemDirs, 0);
  assert.equal(stats.totals.attempted, 0);
});

test('no catalog means no coverage denominators are invented', async () => {
  const root = await tempRoot();
  const stats = await buildStats({ root, catalog: null });
  assert.equal(stats.curriculum.available, false);
  assert.equal(stats.curriculum.problems, 0);
  assert.deepEqual(stats.patterns, []);
  assert.equal(stats.lists.blind75.total, 0);
});

/* ------------------------------------------------------------------ one problem */

test('one problem, opened only: attempted, not solved, and no thinking-time sample', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1', line('2026-07-25T15:23:12.938-04:00', 'problem_opened'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.attempted, 1);
  assert.equal(stats.totals.accepted, 0);
  assert.equal(stats.problems.length, 1);
  assert.equal(stats.problems[0].status, 'attempted');
  assert.equal(stats.problems[0].acceptedAt, null);
  assert.equal(stats.signals.thinkingTime.samples, 0);
  assert.equal(stats.activity.length, 1);
  assert.equal(stats.activity[0].date, '2026-07-25');
  assert.equal(stats.activity[0].events, 1);
});

test('attempt snapshots count as activity even when nothing was logged', async () => {
  const root = await tempRoot();
  await writeAttempts(root, 'two-sum', ['2026-07-25T19-10-23-549Z', '2026-07-25T19-10-29-765Z']);

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.attemptFiles, 2);
  assert.equal(stats.problems[0].status, 'attempted');
  assert.equal(stats.problems[0].attempts, 2);
  assert.equal(stats.activity[0].attempts, 2);
  assert.equal(stats.activity[0].events, 0, 'no session log means no events, and it must not borrow the attempt count');
});

test('NOTES.md alone is "notes only" — it is not evidence of a solve or an attempt', async () => {
  const root = await tempRoot();
  const dir = path.join(root, 'problems', 'valid-anagram');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'NOTES.md'), '# Valid Anagram\n', 'utf8');

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems[0].status, 'notes-only');
  assert.equal(stats.totals.notesOnly, 1);
  assert.equal(stats.totals.attempted, 0);
  assert.equal(stats.totals.accepted, 0);
});

test('passing the example tests locally is never reported as an accepted verdict', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:02:00.000-04:00', 'run_result', { ok: true, summary: { passed: 3, total: 3 } }));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems[0].status, 'local-pass');
  assert.equal(stats.totals.accepted, 0, 'local pass must not inflate the solved count');
  assert.equal(stats.totals.localPassOnly, 1);
  assert.equal(stats.lists.blind75.accepted, 0);
  assert.equal(stats.lists.blind75.attempted, 1);
});

test('a partial local pass is not a pass', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'run_result', { summary: { passed: 2, total: 3 } }));
  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems[0].status, 'attempted');
});

test('an accepted verdict event marks the problem solved and credits its lists', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:20:00.000-04:00', 'submitted') +
    line('2026-07-25T10:20:04.000-04:00', 'verdict', { verdict: 'Accepted', status_code: 10 }));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.accepted, 1);
  assert.equal(stats.problems[0].acceptedSource, 'session log');
  assert.equal(stats.lists.blind75.accepted, 1);
  assert.equal(stats.lists.neetcode250.accepted, 1);
  assert.equal(stats.patterns.find((p) => p.name === 'Arrays & Hashing').accepted, 1);
});

test('a rejected verdict is not quietly rounded up to accepted', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:20:04.000-04:00', 'verdict', { verdict: 'Wrong Answer', status_code: 11 }));
  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.accepted, 0);
  assert.equal(stats.problems[0].status, 'attempted');
});

test('meta.json submissions are read as accepted verdicts and labelled as such', async () => {
  const root = await tempRoot();
  const dir = path.join(root, 'problems', 'valid-anagram');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({
    slug: 'valid-anagram',
    submissions: [
      { at: '2026-07-24', verdict: 'Wrong Answer' },
      { at: '2026-07-25T09:28:00', verdict: 'Accepted', runtimeMs: 49 },
    ],
  }), 'utf8');

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.accepted, 1);
  assert.equal(stats.problems[0].acceptedSource, 'meta.json');
  assert.equal(stats.problems[0].acceptedAt, '2026-07-25T09:28:00');
});

/* --------------------------------------------- malformed and truncated JSONL */

test('a torn final line is skipped, counted, and never crashes the read', async () => {
  const root = await tempRoot();
  const good = line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:00:09.000-04:00', 'first_keystroke');
  // A crash mid-write leaves exactly this: a prefix of a JSON object, no newline.
  await writeSession(root, 'two-sum', 's1', `${good}{"at":"2026-07-25T10:01:00.000-04:00","ty`);

  const parsed = await readSessionFile(path.join(root, 'problems', 'two-sum', 'sessions', 's1.jsonl'));
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.badLines, 1);

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.workspace.skippedLines, 1);
  assert.equal(stats.workspace.eventsRead, 2);
  assert.equal(stats.signals.thinkingTime.samples, 1, 'the readable events still count');
  assert.ok(stats.warnings.some((w) => w.includes('Skipped 1 unreadable line')));
});

test('garbage of every shape is skipped rather than fatal', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1', [
    'not json at all',
    '[1,2,3]',                                   // valid JSON, wrong shape
    'null',
    '"a bare string"',
    '{"at":"2026-07-25T10:00:00.000-04:00"}',    // no type
    '{"at":"2026-07-25T10:00:00.000-04:00","type":"teleported"}', // type nobody writes
    JSON.stringify({ at: '2026-07-25T10:00:00.000-04:00', type: 'problem_opened' }),
    '',
    '   ',
  ].join('\n'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.workspace.eventsRead, 1);
  assert.equal(stats.workspace.skippedLines, 6);
  assert.equal(stats.problems[0].status, 'attempted');
});

test('an entirely empty session file is not an error and not a session-worth of activity', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1', '');
  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.workspace.eventsRead, 0);
  assert.equal(stats.workspace.skippedLines, 0);
  // A folder holding one empty log records nothing at all — not a solve, not an attempt,
  // and not "notes", which would imply prose that does not exist.
  assert.equal(stats.problems[0].status, 'empty');
  assert.equal(stats.totals.attempted, 0);
});

test('an unparseable meta.json is reported, not silently treated as absent', async () => {
  const root = await tempRoot();
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'meta.json'), '{ "submissions": [ {', 'utf8');

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.totals.accepted, 0);
  assert.ok(stats.warnings.some((w) => w.includes('meta.json exists but could not be parsed')));
});

/* ------------------------------------------------------------ out-of-order events */

test('events written out of order are put back in time order before anything is measured', async () => {
  const root = await tempRoot();
  // first_keystroke physically precedes problem_opened in the file.
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:30.000-04:00', 'first_keystroke') +
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.thinkingTime.samples, 1);
  assert.equal(stats.problems[0].thinkingTimeMs, 30_000);
});

test('a keystroke with no recorded open produces no thinking-time number', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1', line('2026-07-25T10:00:30.000-04:00', 'first_keystroke'));
  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.thinkingTime.samples, 0);
  assert.equal(stats.problems[0].thinkingTimeMs, null);
});

test('events with unreadable timestamps are counted but never placed on the timeline', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('yesterday afternoon', 'problem_opened') +
    line('2026-07-25T10:00:00.000-04:00', 'asked_coach', { message: 'hint?' }));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.workspace.eventsRead, 2);
  assert.equal(stats.recent.length, 1, 'the undateable event cannot be placed in recent activity');
  assert.equal(stats.activity.length, 1);
});

/* -------------------------------------------------- a session with no end */

test('a session with only an open — no end, no close — is read normally', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 'open-session', line('2026-07-25T23:59:00.000-04:00', 'problem_opened'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems[0].sessions, 1);
  assert.equal(stats.problems[0].firstAt, stats.problems[0].lastAt);
  assert.equal(stats.signals.thinkingTime.samples, 0);
});

test('two sittings on one problem yield two thinking-time samples, not one', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-24T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-24T10:00:10.000-04:00', 'first_keystroke'));
  await writeSession(root, 'two-sum', 's2',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:00:40.000-04:00', 'first_keystroke'));

  const record = await readProblemDir(root, 'two-sum');
  assert.deepEqual(record.keystrokeSamples, [10_000, 40_000]);
  assert.equal(record.sessionCount, 2);
});

test('a second open inside one file starts a second measurement', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:00:05.000-04:00', 'first_keystroke') +
    line('2026-07-25T11:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T11:00:20.000-04:00', 'first_keystroke'));

  const record = await readProblemDir(root, 'two-sum');
  assert.deepEqual(record.keystrokeSamples, [5_000, 20_000]);
});

/* ------------------------------------------------------------ evidence thresholds */

test('a signal below its threshold reports the shortfall instead of a number', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:00:12.000-04:00', 'first_keystroke'));

  const stats = await buildStats({ root, catalog: CATALOG });
  const signal = stats.signals.thinkingTime;
  assert.equal(signal.samples, 1);
  assert.equal(signal.minSamples, MIN_SAMPLES.timeToFirstKeystroke);
  assert.equal(signal.meaningful, false);
  assert.equal(signal.medianMs, null, 'one sample must not be published as a median');
});

test('a signal at its threshold publishes a median computed from the samples', async () => {
  const root = await tempRoot();
  const slugs = ['two-sum', 'valid-anagram', 'contains-duplicate'];
  const gaps = [10_000, 30_000, 50_000];
  for (let i = 0; i < slugs.length; i += 1) {
    const start = new Date(Date.UTC(2026, 6, 25, 10, 0, 0));
    const typed = new Date(start.getTime() + gaps[i]);
    await writeSession(root, slugs[i], 's1',
      line(start.toISOString(), 'problem_opened') + line(typed.toISOString(), 'first_keystroke'));
  }

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.thinkingTime.samples, 3);
  assert.equal(stats.signals.thinkingTime.meaningful, true);
  assert.equal(stats.signals.thinkingTime.medianMs, 30_000);
  // All three are Arrays & Hashing, so that pattern also clears the bar.
  const arrays = stats.patterns.find((p) => p.name === 'Arrays & Hashing');
  assert.equal(arrays.thinkingSamples, 3);
  assert.equal(arrays.medianThinkingMs, 30_000);
  assert.equal(stats.patterns.find((p) => p.name === 'Graphs').medianThinkingMs, null);
});

test('a reveal with no solve counts as revealed-before-solving', async () => {
  const root = await tempRoot();
  await writeSession(root, 'number-of-islands', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:04:00.000-04:00', 'revealed_solution'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.reveals.revealedBeforeSolve, 1);
  assert.deepEqual(stats.signals.reveals.slugs, ['number-of-islands']);
  assert.equal(stats.signals.reveals.meaningful, false, 'one problem is not a reveal rate');
});

test('a reveal after an accepted verdict is not counted against the solve', async () => {
  const root = await tempRoot();
  await writeSession(root, 'number-of-islands', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:10:00.000-04:00', 'verdict', { verdict: 'Accepted' }) +
    line('2026-07-25T10:12:00.000-04:00', 'revealed_solution'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.reveals.revealedBeforeSolve, 0);
  assert.equal(stats.totals.accepted, 1);
});

test('attempts-per-solved only counts problems that were both solved and snapshotted', async () => {
  const root = await tempRoot();
  await writeAttempts(root, 'two-sum', ['2026-07-25T19-10-23-549Z', '2026-07-25T19-10-29-765Z']);
  await writeSession(root, 'two-sum', 's1', line('2026-07-25T19:20:00.000-04:00', 'verdict', { verdict: 'Accepted' }));
  // Solved but never snapshotted, and snapshotted but never solved: neither is a sample.
  await writeSession(root, 'valid-anagram', 's1', line('2026-07-25T19:20:00.000-04:00', 'verdict', { verdict: 'Accepted' }));
  await writeAttempts(root, 'valid-palindrome', ['2026-07-25T19-30-00-000Z']);

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.signals.attemptsPerSolved.samples, 1);
  assert.equal(stats.signals.attemptsPerSolved.meaningful, false);
  assert.equal(stats.signals.attemptsPerSolved.mean, null);
  assert.deepEqual(stats.signals.attemptsPerSolved.perProblem, [{ slug: 'two-sum', attempts: 2 }]);
});

/* ------------------------------------------------------------ catalog boundaries */

test('a problem folder outside the NeetCode 250 is shown but kept out of the percentages', async () => {
  const root = await tempRoot();
  await writeSession(root, 'some-random-problem', 's1', line('2026-07-25T10:00:00.000-04:00', 'problem_opened'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems.length, 1);
  assert.equal(stats.problems[0].inCatalog, false);
  assert.equal(stats.problems[0].title, null, 'no title is invented for a problem we do not have');
  assert.equal(stats.lists.neetcode250.attempted, 0);
  assert.equal(stats.totals.attempted, 1);
  assert.ok(stats.warnings.some((w) => w.includes('not in the NeetCode 250')));
});

/* ------------------------------------------------------------------ small units */

test('attempt filenames round-trip to the timestamp the writer meant', () => {
  assert.equal(attemptStampOf('2026-07-25T19-10-23-549Z.py'), '2026-07-25T19:10:23.549Z');
  assert.equal(attemptStampOf('solution.py'), null);
  assert.equal(attemptStampOf('2026-07-25.py'), null);
});

test('statusOf ranks the evidence, strongest first', () => {
  const base = { accepted: null, localPassAt: null, attempts: 0, eventCount: 0, hasNotes: false, hasMeta: false, hasSolutionFile: false };
  assert.equal(statusOf({ ...base, accepted: { at: 'x' }, localPassAt: 'y', attempts: 3 }), 'accepted');
  assert.equal(statusOf({ ...base, localPassAt: 'y', attempts: 3 }), 'local-pass');
  assert.equal(statusOf({ ...base, attempts: 3 }), 'attempted');
  assert.equal(statusOf({ ...base, eventCount: 1 }), 'attempted');
  assert.equal(statusOf({ ...base, hasNotes: true }), 'notes-only');
  assert.equal(statusOf(base), 'empty');
});

test('recent activity is newest first and carries only fields the event had', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1',
    line('2026-07-25T10:00:00.000-04:00', 'problem_opened') +
    line('2026-07-25T10:05:00.000-04:00', 'run_result', { summary: { passed: 2, total: 3 } }));
  await writeSession(root, 'valid-anagram', 's1',
    line('2026-07-25T12:00:00.000-04:00', 'asked_coach', { message: '  why   does this   TLE? ' }));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.recent[0].type, 'asked_coach');
  assert.equal(stats.recent[0].summary, 'why does this TLE?');
  assert.equal(stats.recent[0].title, 'Valid Anagram');
  assert.equal(stats.recent[1].summary, '2/3 example cases passed');
  assert.equal(stats.recent[2].summary, null);
});

test('a locally passing run is recognised in the shape the runner actually writes', async () => {
  // The runner writes { ok, passed, total, totalMs } flat on data — no `summary` object.
  // This suite used to assert only against a nested shape the app never emitted, so
  // `local-pass` passed its tests while never once occurring in a real workspace.
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's',
    line('2026-07-25T10:00:00.000-04:00', 'ran_locally', {})
    + line('2026-07-25T10:00:01.000-04:00', 'run_result', { ok: true, passed: 2, total: 2, totalMs: 59 }));

  const stats = await buildStats({ root, catalog: null });
  const record = stats.problems.find((p) => p.slug === 'two-sum');
  assert.equal(record.status, 'local-pass',
    'the example tests went green here and the record does not say so');
  assert.equal(stats.totals.localPassOnly, 1);
});

test('a partial local run is not a local pass', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's',
    line('2026-07-25T10:00:00.000-04:00', 'run_result', { ok: true, passed: 1, total: 2, totalMs: 40 }));
  const stats = await buildStats({ root, catalog: null });
  assert.equal(stats.problems.find((p) => p.slug === 'two-sum').status, 'attempted');
  assert.equal(stats.totals.localPassOnly, 0);
});

test('files that are not .jsonl or .py are ignored rather than mis-parsed', async () => {
  const root = await tempRoot();
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fsp.mkdir(path.join(dir, 'attempts'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'sessions', '.DS_Store'), 'binary junk', 'utf8');
  await fsp.writeFile(path.join(dir, 'attempts', 'notes.txt'), 'hi', 'utf8');
  await writeSession(root, 'two-sum', 's1', line('2026-07-25T10:00:00.000-04:00', 'problem_opened'));

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.workspace.skippedLines, 0);
  assert.equal(stats.problems[0].attempts, 0);
  assert.equal(stats.problems[0].sessions, 1);
});

test('one broken problem directory does not take the whole dashboard down', async () => {
  const root = await tempRoot();
  await writeSession(root, 'two-sum', 's1', line('2026-07-25T10:00:00.000-04:00', 'problem_opened'));
  // A directory whose sessions/ is a file, not a directory — readdir on it fails.
  const dir = path.join(root, 'problems', 'broken');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'sessions'), 'this is not a directory', 'utf8');

  const stats = await buildStats({ root, catalog: CATALOG });
  assert.equal(stats.problems.length, 2, 'the good problem is still reported');
  assert.ok(stats.problems.some((p) => p.slug === 'two-sum' && p.status === 'attempted'));
});
