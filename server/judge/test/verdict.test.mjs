// Verdict shaping. Pure functions, real judge bodies, no network of any kind.

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildVerdict, buildFailure, parseRuntimeMs, parseMemoryMb } from '../verdict.mjs';
import { ACCEPTED_CHECK } from './helpers.mjs';

test('the real observed Accepted response maps to the contract payload', () => {
  const v = buildVerdict(ACCEPTED_CHECK, 2081220750);
  assert.deepEqual(v, {
    ok: true,
    accepted: true,
    verdict: 'Accepted',
    statusCode: 10,
    passed: 64,
    total: 64,
    runtime: '3 ms',
    memory: '20.4 MB',
    runtimePercentile: 53.86,
    memoryPercentile: 58.13,
    submissionId: 2081220750,
    submissionUrl: 'https://leetcode.com/submissions/detail/2081220750/',
    failure: null,
  });
});

test('state SUCCESS with a non-10 status_code is NOT accepted', () => {
  for (const statusCode of [11, 12, 13, 14, 15, 20, 21, 30]) {
    const v = buildVerdict(
      { state: 'SUCCESS', status_code: statusCode, status_msg: 'Something', run_success: true },
      1,
    );
    assert.equal(v.accepted, false, `status_code ${statusCode} must not be accepted`);
    assert.notEqual(v.failure, null, `status_code ${statusCode} must carry a failure`);
  }
});

test('a SUCCESS state alone never implies acceptance even when run_success is true', () => {
  const v = buildVerdict(
    { state: 'SUCCESS', run_success: true, status_code: 11, status_msg: 'Wrong Answer' },
    7,
  );
  assert.equal(v.accepted, false);
});

test('wrong answer carries the judge\'s own failing testcase, output and expectation', () => {
  const check = {
    state: 'SUCCESS',
    status_code: 11,
    status_msg: 'Wrong Answer',
    run_success: true,
    total_correct: 34,
    total_testcases: 57,
    input: '[3,2,4]\n6',
    last_testcase: '[3,2,4]\n6',
    code_output: '[0,1]',
    expected_output: '[1,2]',
    std_output: 'debug line\n',
  };
  const v = buildVerdict(check, 42);
  assert.equal(v.accepted, false);
  assert.equal(v.verdict, 'Wrong Answer');
  assert.equal(v.passed, 34);
  assert.equal(v.total, 57);
  assert.equal(v.failure.kind, 'wrong_answer');
  assert.equal(v.failure.lastTestcase, '[3,2,4]\n6');
  assert.equal(v.failure.output, '[0,1]');
  assert.equal(v.failure.expectedOutput, '[1,2]');
  assert.equal(v.failure.stdout, 'debug line\n');
  // The judge's words, not a paraphrase.
  assert.match(v.failure.message, /\[3,2,4\]/);
  assert.match(v.failure.message, /\[1,2\]/);
});

test('code_output arriving as an array is rendered, not stringified as an object', () => {
  const f = buildFailure({ status_code: 11, status_msg: 'Wrong Answer', code_output: ['[0,1]', '[1,2]'] });
  assert.equal(f.output, '[0,1]\n[1,2]');
});

test('time limit exceeded names the input it choked on', () => {
  const v = buildVerdict(
    {
      state: 'SUCCESS',
      status_code: 14,
      status_msg: 'Time Limit Exceeded',
      run_success: true,
      total_correct: 51,
      total_testcases: 57,
      last_testcase: '[1,2,3,...]\n99999',
      status_runtime: 'N/A',
      status_memory: 'N/A',
    },
    9,
  );
  assert.equal(v.accepted, false);
  assert.equal(v.failure.kind, 'time_limit');
  assert.equal(v.failure.lastTestcase, '[1,2,3,...]\n99999');
  assert.equal(v.failure.statusMsg, 'Time Limit Exceeded');
  assert.equal(v.passed, 51);
});

test('compile error shows full_compile_error verbatim and tolerates absent test counts', () => {
  const v = buildVerdict(
    {
      state: 'SUCCESS',
      status_code: 20,
      status_msg: 'Compile Error',
      run_success: false,
      compile_error: "Line 5: SyntaxError: invalid syntax",
      full_compile_error: "Line 5: SyntaxError: invalid syntax\n        return ans\n                  ^\n1 error",
    },
    11,
  );
  assert.equal(v.accepted, false);
  assert.equal(v.passed, null);
  assert.equal(v.total, null);
  assert.equal(v.failure.kind, 'compile_error');
  assert.equal(v.failure.message, v.failure.compileError);
  assert.match(v.failure.message, /1 error/);
});

test('runtime error shows the full traceback, not the one-line summary', () => {
  const v = buildVerdict(
    {
      state: 'SUCCESS',
      status_code: 15,
      status_msg: 'Runtime Error',
      run_success: false,
      runtime_error: 'IndexError: list index out of range',
      full_runtime_error:
        'IndexError: list index out of range\n    ...traceback...\nLine 5 in twoSum (Solution.py)',
      last_testcase: '[3,3]\n6',
      total_correct: 12,
      total_testcases: 57,
    },
    13,
  );
  assert.equal(v.failure.kind, 'runtime_error');
  assert.match(v.failure.message, /Line 5 in twoSum/);
  assert.equal(v.failure.lastTestcase, '[3,3]\n6');
});

test('an unknown status_code still surfaces the judge\'s status_msg verbatim', () => {
  const v = buildVerdict({ state: 'SUCCESS', status_code: 99, status_msg: 'Some New Verdict' }, 1);
  assert.equal(v.accepted, false);
  assert.equal(v.failure.kind, 'other');
  assert.equal(v.failure.message, 'Some New Verdict');
});

test('runtime and memory display strings parse to numbers, and N/A does not', () => {
  assert.equal(parseRuntimeMs('3 ms'), 3);
  assert.equal(parseRuntimeMs('1234 ms'), 1234);
  assert.equal(parseRuntimeMs('N/A'), null);
  assert.equal(parseRuntimeMs(null), null);
  assert.equal(parseMemoryMb('20.4 MB'), 20.4);
  assert.equal(parseMemoryMb('N/A'), null);
});
