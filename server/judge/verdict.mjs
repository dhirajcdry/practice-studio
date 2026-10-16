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

/** The public page for one submission on LeetCode. */
export function submissionUrl(id) {
  return `https://leetcode.com/submissions/detail/${id}/`;
}

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
 * The `POST /api/submit/record` 200 body, as docs/API-CONTRACT-P2.md Phase 4 specifies.
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

/* ===================== NeetCode (premium problems) ===================== */
//
// Premium LeetCode problems are judged on neetcode.io instead. The Studio Connector
// clicks NeetCode's own Submit button and reads the verdict NeetCode renders on its page
// (extension/background.js, docs/SUBMITTING.md "Premium problems: NeetCode"). There is
// no status code to lean on, so the rule here is the text NeetCode prints:
//
//   accepted  ⇔  the scraped status is exactly "Accepted"
//
// Not "contains accepted", not a CSS class, not "all tests passed". The LeetCode rules
// above are untouched by any of this.

const NEETCODE_ORIGIN = 'https://neetcode.io/';
export const NEETCODE_DETAILS_MAX = 4000;

const NEETCODE_KIND_BY_STATUS = {
  'wrong answer': 'wrong_answer',
  'time limit exceeded': 'time_limit',
  'memory limit exceeded': 'memory_limit',
  'output limit exceeded': 'output_limit',
  'runtime error': 'runtime_error',
  'compilation error': 'compile_error',
  'compile error': 'compile_error',
};

function shortText(value, max) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' ? null : s.slice(0, max);
}

function count(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** A neetcode.io link, or null. Anything else the page might hand us is dropped. */
export function neetcodeUrl(value) {
  return typeof value === 'string' && value.startsWith(NEETCODE_ORIGIN) && value.length <= 500 ? value : null;
}

/**
 * The verdict payload for a NeetCode result, in the same shape as `buildVerdict` so the
 * panel, meta.json and the session log need no second vocabulary. `statusCode` and the
 * percentiles are null because NeetCode has no such things.
 *
 * `result` is what the Connector scraped: `{ status, passed, total, memory, time,
 * details, url }`. A missing field stays missing; nothing is defaulted into a number.
 */
/**
 * NeetCode prints a failing input as `name=value` lines ("n=5\nedges=[[0,1]]"); Studio's
 * cases, like LeetCode's, are the bare values one per line. Lines without a `name=`
 * prefix are kept as they are.
 */
export function neetcodeInputToTestcase(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return text.trim().split(/\r?\n/).map((line) => line.replace(/^\s*[A-Za-z_]\w*\s*=\s*/, '')).join('\n');
}

export function buildNeetCodeVerdict(result, submissionId) {
  const status = shortText(result?.status, 120);
  const accepted = status === 'Accepted';
  const details = typeof result?.details === 'string' && result.details.trim() !== ''
    ? result.details.trim().slice(0, NEETCODE_DETAILS_MAX)
    : null;
  return {
    ok: true,
    accepted,
    verdict: status ?? 'Unknown',
    statusCode: null,
    passed: count(result?.passed),
    total: count(result?.total),
    runtime: shortText(result?.time, 40),
    memory: shortText(result?.memory, 40),
    runtimePercentile: null,
    memoryPercentile: null,
    submissionId,
    submissionUrl: neetcodeUrl(result?.url),
    source: 'neetcode',
    failure: accepted ? null : {
      kind: NEETCODE_KIND_BY_STATUS[(status ?? '').toLowerCase()] ?? 'other',
      statusMsg: status ?? 'Unknown verdict',
      // NeetCode's console text, verbatim: the failing input, output and expected, or the
      // error. The headline already says the status, so `message` does not repeat it.
      message: null,
      // The labelled blocks, when NeetCode showed them, in the same fields a LeetCode
      // failure uses, so the panel lists them and offers the input as a test case.
      lastTestcase: neetcodeInputToTestcase(result?.input),
      output: shortText(result?.output, NEETCODE_DETAILS_MAX),
      expectedOutput: shortText(result?.expected, NEETCODE_DETAILS_MAX),
      fullRuntimeError: shortText(result?.error, NEETCODE_DETAILS_MAX),
      consoleOutput: result?.input || result?.error ? null : details,
    },
  };
}
