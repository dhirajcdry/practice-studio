// Phase 6 — the mirror. Reading ~/LeetCodeTutor/ and turning it into numbers.
//
// The one rule this file exists to enforce: **every number traces to a byte on disk.**
// Nothing here estimates, extrapolates, smooths, or fills a gap with a plausible value.
// Where the data cannot support a claim, the claim is not made — the metric reports how
// many samples it has and how many it needs, and the client says so out loud.
//
// Three distinctions that are easy to blur and dishonest to blur:
//
//   "0 solved"            we looked, and nothing on disk records a solve
//   "nothing recorded"    we looked, and there is no record at all — a different fact
//   "solved locally"      the example tests passed here; that is NOT an accepted verdict
//
// The session log is append-only and written by a process that can be killed mid-write,
// so a torn last line is expected, not exceptional. Every parse here skips what it cannot
// read and counts the skip, and no single bad byte may take an endpoint down.

import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * How much evidence a signal needs before it is allowed to say anything.
 * These are judgement calls, stated in one place, and shipped to the client so the UI can
 * say "needs 3, you have 1" instead of drawing a confident line through one point.
 */
export const MIN_SAMPLES = Object.freeze({
  timeToFirstKeystroke: 3, // per pattern, and overall
  revealRate: 5,           // problems that were either solved or revealed
  attemptsPerSolved: 3,    // solved problems that also have attempt snapshots
  pattern: 3,              // any per-pattern breakdown
});

const EVENT_TYPES_WE_READ = new Set([
  'problem_opened',
  'first_keystroke',
  'ran_locally',
  'run_result',
  'revealed_solution',
  'revealed_article',
  'asked_coach',
  'recorded_audio',
  'submitted',
  'verdict',
]);

/* ------------------------------------------------------------------ time helpers */

/** Parse an ISO-8601 stamp to ms, or null. Never throws, never guesses. */
export function msOf(value) {
  if (typeof value !== 'string' || value === '') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Local calendar date (YYYY-MM-DD) of an event stamp, preserving its own offset. */
export function dayOf(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : null;
}

/**
 * Attempt snapshots are named by the writer as `2026-07-25T19-10-23-549Z.py`.
 * That is a real timestamp with the colons and dot swapped for dashes; recovering it is
 * reading the filename, not inferring anything. Unrecognised names return null and are
 * counted as attempts but contribute no date.
 */
export function attemptStampOf(filename) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.py$/.exec(filename);
  if (!match) return null;
  const [, date, h, m, s, ms] = match;
  const iso = `${date}T${h}:${m}:${s}.${ms}Z`;
  return msOf(iso) === null ? null : iso;
}

/* ------------------------------------------------------------------ disk reading */

async function readDirSafe(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // missing directory is a fact, not an error
  }
}

/**
 * One session file. Unparseable lines are skipped and counted — never repaired, never
 * inferred. Events are returned in file order plus a timestamp-sorted view, because the
 * log is appended by concurrent handlers and "file order" is not guaranteed to be time
 * order once a queue is involved.
 */
export async function readSessionFile(file) {
  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    return { events: [], badLines: 0, unreadable: true };
  }
  const events = [];
  let badLines = 0;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      badLines += 1; // torn write or a hand edit. One event lost beats a rewritten history.
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      badLines += 1;
      continue;
    }
    if (typeof parsed.type !== 'string' || !EVENT_TYPES_WE_READ.has(parsed.type)) {
      badLines += 1; // a type nobody writes is a line we cannot honestly categorise
      continue;
    }
    events.push(parsed);
  }
  return { events, badLines, unreadable: false };
}

/** Sort a copy by timestamp; events with no usable timestamp keep their file order last. */
function inTimeOrder(events) {
  const stamped = [];
  const unstamped = [];
  for (const event of events) {
    const ms = msOf(event.at);
    if (ms === null) unstamped.push(event);
    else stamped.push({ event, ms });
  }
  stamped.sort((a, b) => a.ms - b.ms);
  return { ordered: stamped.map((s) => s.event), unstamped: unstamped.length };
}

function acceptedFromVerdictEvent(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return false;
  // LeetCode's own encoding is status_code 10; the contract does not pin a field name, so
  // we accept the three spellings we could plausibly be handed and nothing else.
  if (data.status_code === 10 || data.statusCode === 10) return true;
  if (data.accepted === true) return true;
  const verdict = typeof data.verdict === 'string' ? data.verdict : typeof data.status === 'string' ? data.status : '';
  return verdict.trim().toLowerCase() === 'accepted';
}

/**
 * Did every example case pass on this machine?
 *
 * Two shapes, and the flat one is the one that matters: the runner has always written
 * `{ ok, passed, total, totalMs }` directly on `data`, while this function only ever read
 * `data.summary.passed`. The stats tests agreed with the function rather than with the
 * app, so `local-pass` was never once produced from a real workspace — every locally
 * passing problem was quietly reported as merely "attempted". The nested shape is still
 * accepted so no existing log or fixture stops being readable.
 */
function allCasesPassed(event) {
  const source = event?.data?.summary && typeof event.data.summary === 'object'
    ? event.data.summary
    : event?.data;
  if (!source || typeof source !== 'object') return false;
  const { passed, total } = source;
  return Number.isFinite(passed) && Number.isFinite(total) && total > 0 && passed === total;
}

/* ------------------------------------------------------------------ per problem */

/**
 * Everything one problem directory can honestly tell us.
 * @returns a record whose every field is either read from disk or explicitly null.
 */
export async function readProblemDir(root, slug) {
  const dir = path.join(root, 'problems', slug);

  const record = {
    slug,
    allEvents: [],           // every readable event, kept once so nothing is re-parsed
    sessions: [],
    sessionCount: 0,
    eventCount: 0,
    badLines: 0,
    unreadableFiles: 0,
    attempts: 0,
    attemptStamps: [],
    hasNotes: false,
    hasMeta: false,
    metaUnreadable: false,
    hasSolutionFile: false,
    firstAt: null,
    lastAt: null,
    accepted: null,          // { at, source } — an actually recorded accepted verdict
    localPassAt: null,       // example tests passed here; not the same thing
    revealedSolutionAt: null,
    // Every submission, not only the ones that worked. A record that remembers just the
    // wins cannot show where someone is grinding against the judge.
    submissionCount: 0,
    rejectedCount: 0,
    verdicts: [],
    revealedArticleAt: null,
    askedCoach: 0,
    runs: 0,
    keystrokeSamples: [],    // ms from problem_opened to first_keystroke, per session
    outOfOrderEvents: 0,
    days: new Set(),
  };

  // --- sessions ---------------------------------------------------------------
  const sessionEntries = await readDirSafe(path.join(dir, 'sessions'));
  if (sessionEntries) {
    const names = sessionEntries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => e.name)
      .sort();
    for (const name of names) {
      const { events, badLines, unreadable } = await readSessionFile(path.join(dir, 'sessions', name));
      record.badLines += badLines;
      if (unreadable) {
        record.unreadableFiles += 1;
        continue;
      }
      record.sessionCount += 1;
      record.eventCount += events.length;

      const { ordered, unstamped } = inTimeOrder(events);
      record.outOfOrderEvents += unstamped;
      record.allEvents.push(...ordered);

      let openedAt = null;
      let keystrokeCounted = false;
      for (const event of ordered) {
        const at = typeof event.at === 'string' ? event.at : null;
        const ms = msOf(at);
        const day = dayOf(at);
        if (day) record.days.add(day);
        if (at && (record.firstAt === null || (ms !== null && ms < msOf(record.firstAt)))) record.firstAt = at;
        if (at && (record.lastAt === null || (ms !== null && ms > msOf(record.lastAt)))) record.lastAt = at;

        switch (event.type) {
          case 'problem_opened':
            if (ms !== null) { openedAt = ms; keystrokeCounted = false; }
            break;
          case 'first_keystroke':
            // Only meaningful with an open before it in the same sitting. A keystroke with
            // no recorded open is not a thinking-time measurement, so it is not counted.
            if (ms !== null && openedAt !== null && !keystrokeCounted && ms >= openedAt) {
              record.keystrokeSamples.push(ms - openedAt);
              keystrokeCounted = true;
            }
            break;
          case 'ran_locally':
            record.runs += 1;
            break;
          case 'run_result':
            if (allCasesPassed(event) && record.localPassAt === null) record.localPassAt = at;
            break;
          case 'revealed_solution':
            if (record.revealedSolutionAt === null) record.revealedSolutionAt = at;
            break;
          case 'revealed_article':
            if (record.revealedArticleAt === null) record.revealedArticleAt = at;
            break;
          case 'asked_coach':
            record.askedCoach += 1;
            break;
          case 'verdict':
            if (acceptedFromVerdictEvent(event) && record.accepted === null) {
              record.accepted = { at, source: 'session log' };
            }
            break;
          default:
            break;
        }
      }
      record.sessions.push({ id: name.slice(0, -'.jsonl'.length), events: ordered.length });
    }
  }

  // --- attempt snapshots ------------------------------------------------------
  const attemptEntries = await readDirSafe(path.join(dir, 'attempts'));
  if (attemptEntries) {
    for (const entry of attemptEntries) {
      if (!entry.isFile() || !entry.name.endsWith('.py')) continue;
      record.attempts += 1;
      const stamp = attemptStampOf(entry.name);
      if (stamp) {
        record.attemptStamps.push(stamp);
        const day = dayOf(stamp);
        if (day) record.days.add(day);
        if (record.firstAt === null || msOf(stamp) < msOf(record.firstAt)) record.firstAt = stamp;
        if (record.lastAt === null || msOf(stamp) > msOf(record.lastAt)) record.lastAt = stamp;
      }
    }
    record.attemptStamps.sort();
  }

  // --- meta.json --------------------------------------------------------------
  try {
    const raw = await fsp.readFile(path.join(dir, 'meta.json'), 'utf8');
    record.hasMeta = true;
    const meta = JSON.parse(raw);
    const submissions = Array.isArray(meta?.submissions) ? meta.submissions : [];
    for (const submission of submissions) {
      const verdict = typeof submission?.verdict === 'string' ? submission.verdict.trim().toLowerCase() : '';
      record.submissionCount += 1;
      if (typeof submission?.verdict === 'string') {
        record.verdicts.push({ verdict: submission.verdict, at: submission.at ?? null });
      }
      if (verdict !== 'accepted') {
        record.rejectedCount += 1;
        const rejectedDay = dayOf(submission?.at);
        if (rejectedDay) record.days.add(rejectedDay);
        const at = typeof submission.at === 'string' ? submission.at : null;
        if (at && (record.firstAt === null || (msOf(at) !== null && msOf(at) < msOf(record.firstAt)))) record.firstAt = at;
        if (at && (record.lastAt === null || (msOf(at) !== null && msOf(at) > msOf(record.lastAt)))) record.lastAt = at;
        continue;
      }
      const at = typeof submission.at === 'string' ? submission.at : null;
      const day = dayOf(at);
      if (day) record.days.add(day);
      if (record.accepted === null || (at && msOf(at) !== null && msOf(record.accepted.at) !== null && msOf(at) < msOf(record.accepted.at))) {
        record.accepted = { at, source: 'meta.json' };
      }
      if (at && (record.firstAt === null || (msOf(at) !== null && msOf(at) < msOf(record.firstAt)))) record.firstAt = at;
      if (at && (record.lastAt === null || (msOf(at) !== null && msOf(at) > msOf(record.lastAt)))) record.lastAt = at;
    }
  } catch (err) {
    // ENOENT means there is no meta.json, which is normal. Anything else means there is
    // one and we could not read it — a fact worth surfacing, not swallowing.
    if (err?.code !== 'ENOENT') {
      record.hasMeta = true;
      record.metaUnreadable = true;
    }
  }

  record.hasNotes = await exists(path.join(dir, 'NOTES.md'));
  record.hasSolutionFile = await exists(path.join(dir, 'solution.py'));
  return record;
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * What we are entitled to say about a problem, in order of strength.
 * Each status is a claim about the *record*, not about the user's ability.
 */
export function statusOf(record) {
  if (record.accepted) return 'accepted';
  if (record.localPassAt) return 'local-pass';
  if (record.attempts > 0 || record.eventCount > 0) return 'attempted';
  if (record.hasNotes || record.hasMeta || record.hasSolutionFile) return 'notes-only';
  return 'empty';
}

/* ------------------------------------------------------------------ aggregation */

function emptyBucket() {
  return { attempted: 0, accepted: 0, localPass: 0, notesOnly: 0, revealed: 0, keystrokeSamples: [] };
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Build the whole dashboard payload.
 *
 * @param {object} options
 * @param {string} options.root         workspace root, i.e. ~/LeetCodeTutor
 * @param {{problems:Array,patterns:Array}} [options.catalog]  the loaded Phase 1 catalog
 * @param {Date} [options.now]
 */
export async function buildStats({ root, catalog = null, now = new Date() }) {
  const warnings = [];
  const problemsRoot = path.join(root, 'problems');
  const dirEntries = await readDirSafe(problemsRoot);

  const workspace = {
    root,
    exists: dirEntries !== null,
    problemDirs: 0,
    withSessions: 0,
    withAttempts: 0,
    withNotes: 0,
    unreadableFiles: 0,
    skippedLines: 0,
    eventsRead: 0,
    sessionsRead: 0,
  };

  const slugs = dirEntries
    ? dirEntries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  workspace.problemDirs = slugs.length;

  const records = [];
  for (const slug of slugs) {
    try {
      records.push(await readProblemDir(root, slug));
    } catch (err) {
      // One unreadable directory must never cost the user the whole dashboard.
      warnings.push(`Could not read problems/${slug}: ${err?.message ?? 'unknown error'}`);
    }
  }

  const catalogProblems = Array.isArray(catalog?.problems) ? catalog.problems : [];
  const catalogPatterns = Array.isArray(catalog?.patterns) ? catalog.patterns : [];
  const bySlug = new Map(catalogProblems.map((p) => [p.slug, p]));

  // ---- curriculum denominators. Real, and known even with zero practice data. ----
  const patternTotals = new Map();
  for (const name of catalogPatterns) patternTotals.set(name, 0);
  const listTotals = { blind75: 0, neetcode150: 0, neetcode250: 0 };
  for (const problem of catalogProblems) {
    if (problem.pattern) {
      patternTotals.set(problem.pattern, (patternTotals.get(problem.pattern) ?? 0) + 1);
    }
    if (problem.lists?.blind75) listTotals.blind75 += 1;
    if (problem.lists?.neetcode150) listTotals.neetcode150 += 1;
    if (problem.lists?.neetcode250) listTotals.neetcode250 += 1;
  }

  const patternBuckets = new Map();
  for (const name of patternTotals.keys()) patternBuckets.set(name, emptyBucket());

  const listCounts = {
    blind75: { attempted: 0, accepted: 0 },
    neetcode150: { attempted: 0, accepted: 0 },
    neetcode250: { attempted: 0, accepted: 0 },
  };

  const totals = {
    attempted: 0,
    accepted: 0,
    localPassOnly: 0,
    notesOnly: 0,
    attemptFiles: 0,
    revealedSolution: 0,
    askedCoach: 0,
    runs: 0,
  };

  const problems = [];
  const activityByDay = new Map();
  const keystrokeSamples = [];
  const attemptsPerSolved = [];
  const offCatalog = [];

  for (const record of records) {
    workspace.unreadableFiles += record.unreadableFiles;
    workspace.skippedLines += record.badLines;
    workspace.eventsRead += record.eventCount;
    workspace.sessionsRead += record.sessionCount;
    if (record.sessionCount) workspace.withSessions += 1;
    if (record.attempts) workspace.withAttempts += 1;
    if (record.hasNotes) workspace.withNotes += 1;
    if (record.metaUnreadable) warnings.push(`problems/${record.slug}/meta.json exists but could not be parsed — it is not counted.`);
    if (record.badLines) warnings.push(`Skipped ${record.badLines} unreadable line${record.badLines === 1 ? '' : 's'} in problems/${record.slug}/sessions — the rest of that log was read normally.`);

    const entry = bySlug.get(record.slug) ?? null;
    if (!entry) offCatalog.push(record.slug);

    const status = statusOf(record);
    const counted = status === 'accepted' || status === 'local-pass' || status === 'attempted';

    totals.attemptFiles += record.attempts;
    totals.revealedSolution += record.revealedSolutionAt ? 1 : 0;
    totals.askedCoach += record.askedCoach;
    totals.runs += record.runs;
    if (status === 'accepted') totals.accepted += 1;
    if (status === 'local-pass') totals.localPassOnly += 1;
    if (status === 'notes-only') totals.notesOnly += 1;
    if (counted) totals.attempted += 1;

    if (entry) {
      const bucket = patternBuckets.get(entry.pattern) ?? emptyBucket();
      if (!patternBuckets.has(entry.pattern)) patternBuckets.set(entry.pattern, bucket);
      if (counted) bucket.attempted += 1;
      if (status === 'accepted') bucket.accepted += 1;
      if (status === 'local-pass') bucket.localPass += 1;
      if (status === 'notes-only') bucket.notesOnly += 1;
      if (record.revealedSolutionAt) bucket.revealed += 1;
      bucket.keystrokeSamples.push(...record.keystrokeSamples);

      for (const listName of ['blind75', 'neetcode150', 'neetcode250']) {
        if (!entry.lists?.[listName]) continue;
        if (counted) listCounts[listName].attempted += 1;
        if (status === 'accepted') listCounts[listName].accepted += 1;
      }
    }

    for (const ms of record.keystrokeSamples) {
      keystrokeSamples.push({ slug: record.slug, pattern: entry?.pattern ?? null, ms });
    }
    if (status === 'accepted' && record.attempts > 0) {
      attemptsPerSolved.push({ slug: record.slug, attempts: record.attempts });
    }

    for (const day of record.days) {
      const bucket = activityByDay.get(day) ?? { date: day, events: 0, attempts: 0, problems: new Set() };
      bucket.problems.add(record.slug);
      activityByDay.set(day, bucket);
    }
    // Attempts and events are counted into their own days separately — a day with four
    // code runs and no session log is a different day from one with four logged events.
    for (const stamp of record.attemptStamps) {
      const day = dayOf(stamp);
      const bucket = day && activityByDay.get(day);
      if (bucket) bucket.attempts += 1;
    }
    for (const event of record.allEvents) {
      const day = dayOf(event.at);
      const bucket = day && activityByDay.get(day);
      if (bucket) bucket.events += 1;
    }

    problems.push({
      slug: record.slug,
      title: entry?.title ?? null,
      number: entry?.number ?? null,
      pattern: entry?.pattern ?? null,
      difficulty: entry?.difficulty ?? null,
      inCatalog: entry !== null,
      status,
      attempts: record.attempts,
      events: record.eventCount,
      sessions: record.sessionCount,
      runs: record.runs,
      askedCoach: record.askedCoach,
      firstAt: record.firstAt,
      lastAt: record.lastAt,
      acceptedAt: record.accepted?.at ?? null,
      acceptedSource: record.accepted?.source ?? null,
      submissionCount: record.submissionCount,
      rejectedCount: record.rejectedCount,
      verdicts: record.verdicts,
      localPassAt: record.localPassAt,
      revealedSolutionAt: record.revealedSolutionAt,
      revealedArticleAt: record.revealedArticleAt,
      hasNotes: record.hasNotes,
      hasMeta: record.hasMeta,
      thinkingTimeMs: record.keystrokeSamples.length ? record.keystrokeSamples[0] : null,
    });
  }

  problems.sort((a, b) => {
    const ax = msOf(a.lastAt) ?? -1;
    const bx = msOf(b.lastAt) ?? -1;
    if (ax !== bx) return bx - ax;
    return a.slug.localeCompare(b.slug);
  });

  if (offCatalog.length) {
    warnings.push(
      `${offCatalog.length} problem folder${offCatalog.length === 1 ? '' : 's'} on disk ${offCatalog.length === 1 ? 'is' : 'are'} not in the NeetCode 250 (${offCatalog.join(', ')}). ${offCatalog.length === 1 ? 'It is' : 'They are'} listed under recent work but left out of the coverage percentages, which are percentages of that list.`,
    );
  }

  // ---- patterns ----
  const patterns = [...patternTotals.entries()].map(([name, total]) => {
    const bucket = patternBuckets.get(name) ?? emptyBucket();
    return {
      name,
      total,
      attempted: bucket.attempted,
      accepted: bucket.accepted,
      localPass: bucket.localPass,
      revealed: bucket.revealed,
      thinkingSamples: bucket.keystrokeSamples.length,
      medianThinkingMs: bucket.keystrokeSamples.length >= MIN_SAMPLES.timeToFirstKeystroke
        ? median(bucket.keystrokeSamples)
        : null,
    };
  });

  // ---- signals, each carrying its own evidence count ----
  const allKeystrokeMs = keystrokeSamples.map((s) => s.ms);
  const solvedOrRevealed = problems.filter((p) => p.status === 'accepted' || p.revealedSolutionAt);
  const revealedBeforeSolve = problems.filter((p) => {
    if (!p.revealedSolutionAt) return false;
    if (!p.acceptedAt) return true; // revealed and no recorded solve: the reveal came first
    const revealed = msOf(p.revealedSolutionAt);
    const accepted = msOf(p.acceptedAt);
    return revealed !== null && accepted !== null && revealed < accepted;
  });

  const attemptCounts = attemptsPerSolved.map((a) => a.attempts);

  const signals = {
    thinkingTime: {
      label: 'Time to first keystroke',
      what: 'How long you read before you start typing, measured from problem_opened to first_keystroke in the same sitting.',
      samples: allKeystrokeMs.length,
      minSamples: MIN_SAMPLES.timeToFirstKeystroke,
      meaningful: allKeystrokeMs.length >= MIN_SAMPLES.timeToFirstKeystroke,
      medianMs: allKeystrokeMs.length >= MIN_SAMPLES.timeToFirstKeystroke ? median(allKeystrokeMs) : null,
      byPattern: patterns
        .filter((p) => p.thinkingSamples > 0)
        .map((p) => ({ pattern: p.name, samples: p.thinkingSamples, medianMs: p.medianThinkingMs }))
        .sort((a, b) => b.samples - a.samples),
    },
    reveals: {
      label: 'Solution revealed before solving',
      what: 'A revealed_solution event with no earlier accepted verdict for that problem.',
      samples: solvedOrRevealed.length,
      minSamples: MIN_SAMPLES.revealRate,
      meaningful: solvedOrRevealed.length >= MIN_SAMPLES.revealRate,
      revealedBeforeSolve: revealedBeforeSolve.length,
      slugs: revealedBeforeSolve.map((p) => p.slug),
      byPattern: patterns
        .filter((p) => p.revealed > 0)
        .map((p) => ({ pattern: p.name, revealed: p.revealed, attempted: p.attempted }))
        .sort((a, b) => b.revealed - a.revealed),
    },
    attemptsPerSolved: {
      label: 'Attempts per solved problem',
      what: 'Counted from the attempt snapshots written every time you ran code, on problems with a recorded accepted verdict.',
      samples: attemptCounts.length,
      minSamples: MIN_SAMPLES.attemptsPerSolved,
      meaningful: attemptCounts.length >= MIN_SAMPLES.attemptsPerSolved,
      mean: attemptCounts.length >= MIN_SAMPLES.attemptsPerSolved ? mean(attemptCounts) : null,
      median: attemptCounts.length >= MIN_SAMPLES.attemptsPerSolved ? median(attemptCounts) : null,
      perProblem: attemptsPerSolved.sort((a, b) => b.attempts - a.attempts),
    },
  };

  const activity = [...activityByDay.values()]
    .map((b) => ({ date: b.date, events: b.events, attempts: b.attempts, problems: b.problems.size }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const recent = recentEvents(records, bySlug, 24);

  return {
    generatedAt: now.toISOString(),
    workspace,
    curriculum: {
      problems: catalogProblems.length,
      patterns: catalogPatterns.length,
      available: catalogProblems.length > 0,
    },
    totals,
    lists: {
      blind75: { total: listTotals.blind75, ...listCounts.blind75 },
      neetcode150: { total: listTotals.neetcode150, ...listCounts.neetcode150 },
      neetcode250: { total: listTotals.neetcode250, ...listCounts.neetcode250 },
    },
    patterns,
    problems,
    signals,
    activity,
    recent,
    warnings,
  };
}

/** The last N events across every problem, newest first. Only what was written. */
function recentEvents(records, bySlug, limit) {
  const all = [];
  for (const record of records) {
    for (const event of record.allEvents) {
      const ms = msOf(event.at);
      if (ms === null) continue; // an event with no readable time cannot be placed
      all.push({
        at: event.at,
        ms,
        slug: record.slug,
        title: bySlug.get(record.slug)?.title ?? null,
        type: event.type,
        summary: summarise(event),
      });
    }
  }
  all.sort((a, b) => b.ms - a.ms);
  return all.slice(0, limit).map(({ ms, ...rest }) => rest);
}

/** A one-line description of an event, built only from fields it actually carries. */
function summarise(event) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  if (event.type === 'run_result' && data.summary && typeof data.summary === 'object') {
    const { passed, total } = data.summary;
    if (Number.isFinite(passed) && Number.isFinite(total)) return `${passed}/${total} example cases passed`;
  }
  if (event.type === 'verdict') {
    if (typeof data.verdict === 'string') return data.verdict;
    if (data.status_code === 10) return 'Accepted';
  }
  if (event.type === 'asked_coach' && typeof data.message === 'string') {
    const text = data.message.trim().replace(/\s+/g, ' ');
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  }
  return null;
}
