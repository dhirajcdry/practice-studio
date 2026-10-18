// Read and merge the server-owned submission history. The browser and coach both use
// these helpers; neither path contacts a judge or trusts a client supplied file path.
import fsp from 'node:fs/promises';
import path from 'node:path';

import { readSubmissionDetails } from './record.mjs';

export function mergeSubmissionDetails(previous, next) {
  const merged = { ...(previous ?? {}) };
  for (const [key, value] of Object.entries(next ?? {})) {
    if (key === 'runtime' || key === 'memory') {
      merged[key] = { ...(previous?.[key] ?? {}) };
      for (const [field, metric] of Object.entries(value ?? {})) {
        if ((metric !== null && (!Array.isArray(metric) || metric.length)) || merged[key][field] === undefined) {
          merged[key][field] = metric;
        }
      }
    } else if (value !== null || merged[key] === undefined) {
      merged[key] = value;
    }
  }
  return merged;
}

function metaFile(root, slug) {
  return path.join(root, 'problems', slug, 'meta.json');
}

/** Read the server-owned submission rows and their optional sidecars. */
export async function readSubmissions({ root, slug }) {
  let meta;
  try {
    meta = JSON.parse(await fsp.readFile(metaFile(root, slug), 'utf8'));
  } catch {
    return [];
  }

  const rows = Array.isArray(meta?.submissions)
    ? [...meta.submissions].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    : [];
  const dir = path.resolve(root, 'problems', slug, 'submissions');

  return Promise.all(rows.map(async (row) => {
    const sidecar = await readSubmissionDetails({ root, slug, submissionId: row.submissionId });
    let code = null;
    if (typeof row.codeFile === 'string' && /^submissions\/[^/\\]+\.py$/.test(row.codeFile)) {
      const file = path.resolve(root, 'problems', slug, row.codeFile);
      try {
        const real = await fsp.realpath(file);
        const realDir = await fsp.realpath(dir);
        if (path.dirname(real) === realDir) code = await fsp.readFile(real, 'utf8');
      } catch {
        // An old or missing code copy should not hide the verdict row.
      }
    }
    return {
      ...row,
      detailFile: sidecar ? `submissions/${row.submissionId}.json` : row.detailFile ?? null,
      runtimeMs: sidecar?.details?.runtime?.ms ?? row.runtimeMs,
      memoryMb: sidecar?.details?.memory?.mb ?? row.memoryMb,
      beatsRuntimePct: sidecar?.details?.runtime?.percentile ?? row.beatsRuntimePct,
      beatsMemoryPct: sidecar?.details?.memory?.percentile ?? row.beatsMemoryPct,
      code,
      failure: sidecar?.failure ?? null,
      details: sidecar?.details ?? null,
      leadUp: sidecar?.leadUp ?? null,
      hasDetails: Boolean(sidecar?.details),
    };
  }));
}

export function submissionSummary(rows) {
  const accepted = rows.filter((row) => row.accepted);
  const best = (field, percentile, key) => {
    const known = accepted.filter((row) => Number.isFinite(row[field]));
    if (!known.length) return null;
    const row = known.reduce((a, b) => (a[field] <= b[field] ? a : b));
    return { [key]: row[field], percentile: row[percentile] ?? null, submissionId: row.submissionId };
  };
  return {
    total: rows.length,
    accepted: accepted.length,
    firstAcceptedAt: accepted.at(-1)?.at ?? null,
    bestRuntime: best('runtimeMs', 'beatsRuntimePct', 'ms'),
    bestMemory: best('memoryMb', 'beatsMemoryPct', 'mb'),
  };
}

/**
 * When a submission happened, said the way a person would: "12 min ago", "yesterday 14:20",
 * "Oct 12 09:15". A bare clock time is not enough, because the tutor has no idea what "09:05"
 * means without a date and the current time, and a three-day-old TLE would read as this
 * morning's.
 */
export function submittedWhen(at, now = Date.now()) {
  const then = Date.parse(at);
  if (!Number.isFinite(then)) return null;
  const minutes = Math.round((now - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const date = new Date(then);
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now);
  if (date.toDateString() === today.toDateString()) return `${Math.round(minutes / 60)} h ago (today ${clock})`;
  const yesterday = new Date(now);
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${clock}`;
  return `${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${clock}`;
}

/** "8 min after the previous submission": how fast the learner went back to the judge. */
function gapFromPrevious(row, previous) {
  const gap = Date.parse(row?.at) - Date.parse(previous?.at);
  if (!Number.isFinite(gap) || gap < 0) return null;
  const minutes = Math.round(gap / 60_000);
  if (minutes < 1) return 'under a minute after the previous submission';
  if (minutes < 120) return `${minutes} min after the previous submission`;
  return `${Math.round(minutes / 60)} h after the previous submission`;
}

/** The lead-up the server recorded at submit time, as one sentence of facts. */
function leadUpText(leadUp) {
  if (!leadUp) return null;
  const facts = [];
  if (Number.isFinite(leadUp.minutes)) facts.push(`${leadUp.minutes} min into the session`);
  if (Number.isFinite(leadUp.localRuns)) facts.push(`${leadUp.localRuns} local run${leadUp.localRuns === 1 ? '' : 's'} before it`);
  if (Number.isFinite(leadUp.coachAsks) && leadUp.coachAsks > 0) facts.push(`asked the coach ${leadUp.coachAsks}×`);
  return facts.length ? facts.join(', ') : null;
}

// Model projections are allowlisted: UI histograms and storage metadata never enter a turn.
// Timing is included because it changes the advice: a submit two minutes after a TLE with
// no local runs in between is a different habit from one after twenty minutes of testing.
export function modelSubmission(row, { code = true, now = Date.now(), previous = null } = {}) {
  const result = {};
  for (const key of ['submissionId', 'at', 'verdict', 'accepted', 'testsPassed', 'testsTotal',
    'runtimeMs', 'memoryMb', 'beatsRuntimePct', 'beatsMemoryPct', 'failureKind']) {
    if (row[key] != null) result[key] = row[key];
  }
  const when = submittedWhen(row.at, now);
  if (when) result.when = when;
  const gap = gapFromPrevious(row, previous);
  if (gap) result.sincePrevious = gap;
  const leadUp = leadUpText(row.leadUp);
  if (leadUp) result.leadUp = leadUp;
  const blocks = {};
  for (const source of [row.details, row.failure]) {
    for (const key of ['kind', 'lastTestcase', 'input', 'expectedOutput', 'expected', 'codeOutput',
      'output', 'actual', 'stdout', 'stdOutput', 'compileError', 'runtimeError', 'fullRuntimeError',
      'traceback', 'error', 'message', 'statusMsg']) {
      const value = source?.[key];
      if (typeof value === 'string') blocks[key] = value.length > 1500
        ? `${value.slice(0, 1500)} (trimmed, ${value.length} chars total)` : value;
    }
  }
  if (Object.keys(blocks).length) result.failure = blocks;
  if (code) result.code = row.code;
  return result;
}

// One bounded line keeps history from growing the cost of every coach question.
export function compactSubmissions(rows, now = Date.now()) {
  if (!rows.length) return '';
  const latest = rows[0];
  const tests = Number.isFinite(latest.testsTotal) ? ` ${latest.testsPassed ?? '?'}/${latest.testsTotal}` : '';
  const when = submittedWhen(latest.at, now) ?? 'at an unknown time';
  const best = submissionSummary(rows).bestRuntime;
  const accepted = best ? `; best accepted ${best.ms} ms${best.percentile == null ? '' : `, beats ${Math.round(best.percentile)}%`}` : '';
  return `Submissions: ${rows.length} (latest ${String(latest.verdict).slice(0, 40)}${tests}, ${when}${accepted})`.slice(0, 199);
}

export function submissionModelLine(row, { now = Date.now(), previous = null } = {}) {
  const value = modelSubmission(row, { code: false, now, previous });
  delete value.failure;
  return Object.entries(value).map(([key, item]) => `${key}=${item}`).join(' ');
}
