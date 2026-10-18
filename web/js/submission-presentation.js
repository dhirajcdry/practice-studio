// Facts available to the submission view. Missing measurements and missing records
// have different meanings; keep that distinction independent of DOM rendering.
export function submissionPresentation(submission) {
  const old = !submission.detailFile && !submission.failure && !submission.details;
  const metrics = [];
  if (submission.accepted) {
    for (const [name, field, unit, percentile] of [
      ['Runtime', 'runtimeMs', 'ms', 'beatsRuntimePct'],
      ['Memory', 'memoryMb', 'MB', 'beatsMemoryPct'],
    ]) {
      const detail = submission.details?.[name.toLowerCase()];
      const value = detail?.display || (Number.isFinite(submission[field]) ? `${submission[field]} ${unit}` : null);
      if (value) metrics.push({ name, value, percentile: detail?.percentile ?? submission[percentile] });
    }
  }
  return {
    metrics,
    missing: old ? 'Not kept for submissions before Oct 18' : "LeetCode didn't return this.",
    old,
    tests: Number.isFinite(submission.testsPassed) && Number.isFinite(submission.testsTotal),
  };
}

/** A common prefix/suffix leaves exactly the first differing range highlighted. */
export function firstDifference(expected, actual) {
  let start = 0;
  while (start < expected.length && start < actual.length && expected[start] === actual[start]) start++;
  let endExpected = expected.length;
  let endActual = actual.length;
  while (endExpected > start && endActual > start && expected[endExpected - 1] === actual[endActual - 1]) {
    endExpected--;
    endActual--;
  }
  return { start, endExpected, endActual };
}
