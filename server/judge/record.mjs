// Recording a completed verdict.
//
// Two destinations, both owned by the server (never the coach):
//
//   sessions/<id>.jsonl   append-only `submitted` and `verdict` events, via SessionLog
//   meta.json             the verdict appended to `submissions[]`
//
// meta.json is MERGED, never rewritten from scratch: it carries hand-written notes,
// catalog identity, first/last seen dates and a submission history that predates this
// module. Clobbering any of that to record one verdict would be a bad trade. The write is
// temp-file + rename so a crash mid-write cannot truncate it, and a meta.json that cannot
// be parsed is left strictly alone rather than "repaired" into a new file.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { isoWithOffset } from '../coach/sessions.mjs';
import { parseRuntimeMs, parseMemoryMb } from './verdict.mjs';
import { normaliseLeetCodeDetails, DETAILS_MAX } from './details.mjs';

// Kept as compatibility exports for callers that recorded submissions before the
// read/merge code moved to its own module.
export { readSubmissions, submissionSummary } from './submissions.mjs';

function metaFile(root, slug) {
  return path.join(root, 'problems', slug, 'meta.json');
}

async function writeAtomic(file, text) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text, 'utf8');
  try {
    await fsp.rename(tmp, file);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Keep the exact bytes that were submitted, beside the verdict they earned.
 *
 * Without this a submission list is a row of verdicts with nothing behind them: you can
 * see that attempt three was accepted and attempt two was not, and never see what
 * changed between them. The buffer on disk is only ever the *latest* code, so the
 * history has to be written at the moment it is sent.
 */
export async function saveSubmittedCode({ root, slug, submissionId, code }) {
  if (!root || !slug || !submissionId || typeof code !== 'string') return null;
  const name = `${submissionId}.py`;
  const file = path.join(root, 'problems', slug, 'submissions', name);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, code, 'utf8');
    return `submissions/${name}`;
  } catch {
    return null; // a lost copy must never fail the submission it belongs to
  }
}

const safeId = (id) => /^(?:[1-9][0-9]*|nc-[0-9]+)$/.test(String(id));
export async function saveSubmissionDetails({ root, slug, submissionId, record }) {
  if (!root || !slug || !safeId(submissionId)) return null;
  const file = path.join(root, 'problems', slug, 'submissions', `${submissionId}.json`);
  try {
    await writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
    return `submissions/${submissionId}.json`;
  } catch {
    return null;
  }
}
export async function readSubmissionDetails({ root, slug, submissionId }) {
  if (!safeId(submissionId)) return null;
  try {
    const record = JSON.parse(await fsp.readFile(path.join(root, 'problems', slug, 'submissions', `${submissionId}.json`), 'utf8'));
    return record?.schemaVersion === 1 ? record : null;
  } catch {
    return null;
  }
}
export function deriveLeadUp(events, at) {
  const end = Date.parse(at);
  const known = (events || []).filter(e => Number.isFinite(Date.parse(e.at)) && Date.parse(e.at) <= end);
  // A session can predate the explicit problem_opened/attempt_started markers. In that
  // case its first recorded event is the only honest start time. An attempt marker wins
  // when present, and the newest one is the active attempt.
  const starts = known.reduce((indexes, event, index) => {
    if (event.type === 'attempt_started') indexes.push(index);
    return indexes;
  }, []);
  const start = starts.length ? starts.at(-1) : 0;
  if (!known.length || start < 0) return null;
  const sitting = known.slice(start);
  const previous = sitting.findLastIndex((event) => event.type === 'submitted');
  const between = sitting.slice(previous + 1);
  return {
    minutes: Math.max(0, Math.round((end - Date.parse(sitting[0].at)) / 60000)),
    localRuns: between.filter((event) => event.type === 'ran_locally').length,
    coachAsks: between.filter((event) => event.type === 'asked_coach').length,
  };
}
export async function submissionLeadUp(sessionLog, slug, at) {
  try {
    return deriveLeadUp((await sessionLog.currentSessionEvents(slug)).events, at);
  } catch {
    return null;
  }
}
// Sidecars carry UI diagnostics, never arbitrary response fields or another code copy.
function savedFailure(failure) {
  if (!failure) return null;
  const result = {};
  for (const key of ['kind', 'statusMsg', 'message', 'lastTestcase', 'input', 'output',
    'expectedOutput', 'stdout', 'compileError', 'runtimeError', 'fullRuntimeError', 'error']) {
    if (typeof failure[key] === 'string') result[key] = failure[key].slice(0, DETAILS_MAX);
  }
  return result;
}
export function sidecarRecord(verdict, at, details, leadUp) {
  return {
    schemaVersion: 1,
    submissionId: String(verdict.submissionId),
    source: verdict.source === 'neetcode' ? 'neetcode' : 'studio',
    at,
    verdict: submissionEntry(verdict, { at }),
    failure: savedFailure(verdict.failure),
    details: normaliseLeetCodeDetails(details),
    leadUp,
  };
}
/** The `submissions[]` entry, in the shape server/stats/aggregate.mjs already reads
 *  (`at` + `verdict`), plus the fields the judge actually returned. */
export function submissionEntry(verdict, { at = isoWithOffset(), codeFile = null, detailFile = null } = {}) {
  return {
    at,
    codeFile,
    verdict: verdict.verdict,
    statusCode: verdict.statusCode,
    accepted: verdict.accepted === true,
    runtimeMs: parseRuntimeMs(verdict.runtime),
    memoryMb: parseMemoryMb(verdict.memory),
    testsPassed: verdict.passed,
    testsTotal: verdict.total,
    beatsRuntimePct: verdict.runtimePercentile,
    beatsMemoryPct: verdict.memoryPercentile,
    submissionId: verdict.submissionId,
    submissionUrl: verdict.submissionUrl,
    // 'studio' is a LeetCode verdict Studio recorded; 'neetcode' is a premium problem
    // judged on neetcode.io (verdict.mjs, buildNeetCodeVerdict).
    source: verdict.source === 'neetcode' ? 'neetcode' : 'studio',
    failureKind: verdict.failure?.kind ?? null,
    detailFile,
  };
}

/**
 * Append one verdict to meta.json, preserving every other field.
 * @returns {Promise<{ written: boolean, reason?: string }>} never throws — failing to
 * record a verdict must not turn a successful submission into an error at the user.
 */
export async function recordVerdict({ root, slug, verdict, at = isoWithOffset(), codeFile = null, detailFile = null }) {
  const file = metaFile(root, slug);

  let existing = null;
  try {
    existing = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      existing = null;
    } else {
      // A meta.json that exists but will not parse is somebody's hand-edited file. Leaving
      // it untouched loses this verdict; overwriting it could lose everything else.
      return { written: false, reason: 'meta.json exists but could not be parsed; it was left untouched.' };
    }
  }

  if (existing !== null && (typeof existing !== 'object' || Array.isArray(existing))) {
    return { written: false, reason: 'meta.json is not a JSON object; it was left untouched.' };
  }

  const base = existing ?? { schemaVersion: 1, slug, sessions: [] };
  const submissions = Array.isArray(base.submissions) ? base.submissions.slice() : [];
  if (verdict.submissionId != null && submissions.some((s) => String(s?.submissionId) === String(verdict.submissionId))) {
    return { written: true, duplicate: true };
  }
  submissions.push(submissionEntry(verdict, { at, codeFile, detailFile }));

  const merged = { ...base, slug: base.slug ?? slug, submissions, lastSeen: dayOf(at) ?? base.lastSeen };

  try {
    await writeAtomic(file, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (err) {
    return { written: false, reason: `meta.json could not be written (${err?.code ?? 'error'}).` };
  }
  return { written: true };
}

function dayOf(at) {
  return typeof at === 'string' && at.length >= 10 ? at.slice(0, 10) : null;
}

/**
 * The two session events. Best-effort in the same sense: a log failure is reported in the
 * response's `recorded` block rather than swallowed, but it never fails the submission.
 */
export async function logSubmitted(sessionLog, slug, data) {
  if (!sessionLog?.appendEvent) return { written: false, reason: 'no session log' };
  try {
    await sessionLog.appendEvent(slug, 'submitted', data);
    return { written: true };
  } catch (err) {
    return { written: false, reason: err?.message ?? 'append failed' };
  }
}

export async function logVerdict(sessionLog, slug, verdict) {
  if (!sessionLog?.appendEvent) return { written: false, reason: 'no session log' };
  try {
    await sessionLog.appendEvent(slug, 'verdict', {
      accepted: verdict.accepted === true,
      verdict: verdict.verdict,
      statusCode: verdict.statusCode,
      passed: verdict.passed,
      total: verdict.total,
      runtime: verdict.runtime,
      memory: verdict.memory,
      runtimePercentile: verdict.runtimePercentile,
      memoryPercentile: verdict.memoryPercentile,
      submissionId: verdict.submissionId,
      failureKind: verdict.failure?.kind ?? null,
      // Only NeetCode verdicts carry these, so LeetCode events keep their exact shape.
      ...(verdict.source === 'neetcode' ? { source: 'neetcode', submissionUrl: verdict.submissionUrl } : {}),
    });
    return { written: true };
  } catch (err) {
    return { written: false, reason: err?.message ?? 'append failed' };
  }
}
