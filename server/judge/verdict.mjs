// Turning LeetCode's `/check/` body into the contract's verdict payload.
//
// Two rules govern everything here:
//
//   1. `state: "SUCCESS"` means judging FINISHED. Acceptance is `status_code === 10` and
//      nothing else — not `run_success`, not `status_msg`, not "no failure fields present".
//   2. Show the judge's own words. The failing input, expected vs actual, the compile
//      error, the traceback — verbatim. Never a paraphrase, never a reconstruction.
//
// Interim polls omit fields entirely rather than nulling them, so every read is guarded.

import { submissionUrl } from './client.mjs';

export const ACCEPTED_STATUS_CODE = 10;

const KIND_BY_STATUS = {
  11: 'wrong_answer',
  12: 'memory_limit',
  13: 'output_limit',
  14: 'time_limit',
  15: 'runtime_error',
  20: 'compile_error',
  21: 'unknown_error',
  30: 'judge_timeout',
};

function str(value) {
  if (typeof value === 'string') return value;
  // `code_output` is an array for a run and a string for a submit. Handle both rather than
  // rendering "[object Object]" at the user.
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n');
  if (value === null || value === undefined) return null;
  return String(value);
}

function nonEmpty(value) {
  const s = str(value);
  return typeof s === 'string' && s !== '' ? s : null;
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The `failure` object: whichever of the judge's own artefacts came back.
 * Null when and only when the verdict is Accepted.
 */
export function buildFailure(check) {
  const statusCode = num(check?.status_code);
  if (statusCode === ACCEPTED_STATUS_CODE) return null;

  const kind = KIND_BY_STATUS[statusCode] ?? 'other';
  const failure = {
    kind,
    // status_msg verbatim — the fallback for any code this table does not know.
    statusMsg: nonEmpty(check?.status_msg) ?? 'Unknown verdict',
    message: null,
    lastTestcase: nonEmpty(check?.last_testcase) ?? nonEmpty(check?.input),
    output: nonEmpty(check?.code_output),
    expectedOutput: nonEmpty(check?.expected_output),
    stdout: nonEmpty(check?.std_output),
    compileError: nonEmpty(check?.full_compile_error) ?? nonEmpty(check?.compile_error),
    runtimeError: nonEmpty(check?.full_runtime_error) ?? nonEmpty(check?.runtime_error),
  };

  // `message` is the single thing a minimal UI can show. It is always a quote from the
  // judge, picked by what actually came back — compile errors first, because when the code
  // never built there is no testcase to talk about.
  failure.message =
    failure.compileError ??
    failure.runtimeError ??
    (failure.kind === 'wrong_answer' && failure.expectedOutput !== null
      ? `Wrong answer on input:\n${failure.lastTestcase ?? '(input not returned)'}\nOutput: ${failure.output ?? '(none)'}\nExpected: ${failure.expectedOutput}`
      : failure.lastTestcase
        ? `${failure.statusMsg} on input:\n${failure.lastTestcase}`
        : failure.statusMsg);

  return failure;
}

/**
 * The `POST /api/submit` 200 body, exactly as docs/API-CONTRACT-P2.md Phase 4 specifies.
 */
export function buildVerdict(check, submissionId) {
  const statusCode = num(check?.status_code);
  return {
    ok: true,
    // The one line that matters. Not `state === 'SUCCESS'`, not `run_success`.
    accepted: statusCode === ACCEPTED_STATUS_CODE,
    verdict: nonEmpty(check?.status_msg) ?? 'Unknown',
    statusCode,
    passed: num(check?.total_correct),
    total: num(check?.total_testcases),
    runtime: nonEmpty(check?.status_runtime),
    memory: nonEmpty(check?.status_memory),
    runtimePercentile: num(check?.runtime_percentile),
    memoryPercentile: num(check?.memory_percentile),
    submissionId,
    submissionUrl: submissionUrl(submissionId),
    failure: buildFailure(check),
  };
}

/** "3 ms" → 3, "1 ms" → 1, "N/A" → null. Display strings stay display strings; this is
 *  only for the numeric column meta.json already uses. */
export function parseRuntimeMs(display) {
  if (typeof display !== 'string') return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*ms$/i.exec(display.trim());
  return m ? Number(m[1]) : null;
}

/** "20.4 MB" → 20.4. */
export function parseMemoryMb(display) {
  if (typeof display !== 'string') return null;
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*mb$/i.exec(display.trim());
  return m ? Number(m[1]) : null;
}
