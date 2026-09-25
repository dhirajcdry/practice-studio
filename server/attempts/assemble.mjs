// One attempt, assembled into one file you can read.
//
// The raw capture was never the problem — it is complete and correctly timestamped. The
// problem was that it lands in six places keyed six ways, and nothing ever put it back
// together:
//
//   sessions/<sitting>.jsonl        every event, rolled on a 45-minute gap
//   transcripts/<ts>-think_aloud.json   what was said, chopped every 120 seconds
//   attempts/<ts>.py                the code as it stood at each Run
//   submissions/<id>.py             exactly what went to LeetCode
//   chats.jsonl                     coach turns, appended forever
//   solution.py                     where it ended up
//
// So a 17-minute attempt was 10 transcript files whose chunk boundaries cut mid-sentence,
// plus 22 events in a file that also held a different attempt, plus code snapshots named
// by wall clock in a different timezone format. All of it true, none of it readable.
//
// This produces `attempts/<attemptId>/attempt.md`: one document, in time order, where
// what was said sits next to what was done. The tutor reads one file per attempt.
//
// TWO RULES.
//
//   1. This is DERIVED. Every byte comes from the raw stores, which are never modified.
//      A bug here costs a regeneration, never a recording. `scripts/rebuild-attempts.mjs`
//      rebuilds every attempt from scratch, and the result must be identical.
//   2. It never invents. If the spoken text is missing, the timeline says so rather than
//      leaving a quiet gap that reads like silence. A summary of a sitting that never
//      happened is worse than no summary.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Speech is captured in 120s chunks; anything under this is a fragment, not a pause. */
export const CHUNK_SECONDS = 120;

/* ------------------------------- reading the raw ------------------------------- */

async function readJsonl(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* a bad line is skipped, never rewritten */ }
  }
  return out;
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function listDir(dir) {
  try {
    return (await fsp.readdir(dir)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

/** Session filenames and event `at` are different clocks — compare on epoch ms, always. */
const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? null : t;
};

/** attempts/<ts>.py is named in UTC with : and . replaced by -. Recover the instant. */
export function msFromSnapshotName(name) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.py$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s, milli] = m;
  return Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s}.${milli}Z`);
}

/* --------------------------------- gathering --------------------------------- */

/**
 * Everything that belongs to one attempt, from every store.
 *
 * The bracket is `attempt_started` → `attempt_ended`. Events carrying the attemptId are
 * taken on the key; events that do not carry one (runs and submissions, historically) are
 * taken on the time window. An attempt is a contiguous stretch of one person's attention,
 * so the window is sound — but the key wins wherever it exists, because a clock is a
 * weaker claim than an identifier.
 */
export async function gatherAttempt({ root, slug, attemptId }) {
  const dir = path.join(root, 'problems', slug);
  const sessionFiles = (await listDir(path.join(dir, 'sessions'))).filter((n) => n.endsWith('.jsonl'));

  let started = null;
  let ended = null;
  let events = [];

  for (const name of sessionFiles) {
    const all = await readJsonl(path.join(dir, 'sessions', name));
    const startAt = all.find((e) => e.type === 'attempt_started' && e.data?.attemptId === attemptId);
    if (!startAt) continue;
    const endAt = all.find((e) => e.type === 'attempt_ended' && e.data?.attemptId === attemptId);
    started = startAt;
    ended = endAt ?? null;

    const from = ms(startAt.at);
    // An attempt with no end is one that is still open, or one whose end was lost to a
    // crash. Take everything after the start rather than nothing.
    const to = endAt ? ms(endAt.at) : Number.POSITIVE_INFINITY;

    events = all.filter((e) => {
      const own = e.data?.attemptId;
      if (own) return own === attemptId;
      const at = ms(e.at);
      if (at === null) return false;
      // The verdict for the last submission can land a second or two after Stop.
      return at >= from && at <= to + 30_000;
    });
    break;
  }

  if (!started) return null;

  const from = ms(started.at);
  const to = ended ? ms(ended.at) : Number.POSITIVE_INFINITY;

  /* the spoken track, de-chunked */
  const speech = [];
  for (const event of events) {
    if (event.type !== 'recorded_audio') continue;
    const name = event.data?.transcript;
    if (!name) {
      speech.push({ at: ms(event.at), text: null, seconds: event.data?.seconds ?? null, file: null });
      continue;
    }
    const body = await readJson(path.join(dir, 'transcripts', name));
    speech.push({
      at: ms(event.at),
      // The chunk's own recordedAt is when transcription finished; `at` is the event. Same
      // instant in practice, but prefer the event so everything sorts on one clock.
      text: typeof body?.text === 'string' ? body.text.trim() : null,
      seconds: body?.durationSeconds ?? event.data?.seconds ?? null,
      file: name,
    });
  }
  speech.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));

  /* code as it stood at each Run */
  const snapshots = [];
  for (const name of await listDir(path.join(dir, 'attempts'))) {
    const at = msFromSnapshotName(name);
    if (at === null || at < from || at > to + 30_000) continue;
    snapshots.push({ at, name, code: await fsp.readFile(path.join(dir, 'attempts', name), 'utf8') });
  }
  snapshots.sort((a, b) => a.at - b.at);

  /* what was actually submitted */
  const submissions = [];
  for (const event of events) {
    if (event.type !== 'submitted') continue;
    const id = event.data?.submissionId;
    const file = id ? path.join(dir, 'submissions', `${id}.py`) : null;
    let code = null;
    if (file) {
      try { code = await fsp.readFile(file, 'utf8'); } catch { code = null; }
    }
    submissions.push({ at: ms(event.at), id: id ?? null, code, ...event.data });
  }

  /* coach turns — keyed where the key exists, windowed where it does not */
  const chats = (await readJsonl(path.join(dir, 'chats.jsonl'))).filter((turn) => {
    if (turn.attemptId) return turn.attemptId === attemptId;
    const at = ms(turn.at);
    return at !== null && at >= from && at <= to;
  });

  return { slug, attemptId, dir, started, ended, events, speech, snapshots, submissions, chats };
}

/** Every attempt this problem has a start event for, oldest first. */
export async function listAttempts(root, slug) {
  const dir = path.join(root, 'problems', slug, 'sessions');
  const ids = [];
  for (const name of (await listDir(dir)).filter((n) => n.endsWith('.jsonl'))) {
    for (const event of await readJsonl(path.join(dir, name))) {
      if (event.type === 'attempt_started' && event.data?.attemptId) ids.push(event.data.attemptId);
    }
  }
  return [...new Set(ids)].sort();
}
