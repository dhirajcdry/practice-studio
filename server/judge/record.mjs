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

/** The `submissions[]` entry, in the shape server/stats/aggregate.mjs already reads
 *  (`at` + `verdict`), plus the fields the judge actually returned. */
export function submissionEntry(verdict, { at = isoWithOffset(), codeFile = null } = {}) {
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
    source: 'studio',
  };
}

/**
 * Append one verdict to meta.json, preserving every other field.
 * @returns {Promise<{ written: boolean, reason?: string }>} never throws — failing to
 * record a verdict must not turn a successful submission into an error at the user.
 */
export async function recordVerdict({ root, slug, verdict, at = isoWithOffset(), codeFile = null }) {
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
  submissions.push(submissionEntry(verdict, { at, codeFile }));

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
    });
    return { written: true };
  } catch (err) {
    return { written: false, reason: err?.message ?? 'append failed' };
  }
}
