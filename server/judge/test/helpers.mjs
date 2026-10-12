// Shared fixtures for the judge tests.

/** LeetCode's `/check/` body for a finished, accepted submission. */
export const ACCEPTED_CHECK = Object.freeze({
  state: 'SUCCESS',
  status_code: 10,
  status_msg: 'Accepted',
  run_success: true,
  total_correct: 64,
  total_testcases: 64,
  status_runtime: '3 ms',
  status_memory: '20.4 MB',
  runtime_percentile: 53.86,
  memory_percentile: 58.13,
  finished: true,
});
