// Regression tests for the judge-environment mismatch.
//
// LeetCode's own Python stubs are annotated `nums: List[int]` with no import anywhere,
// because their judge pre-imports typing. Annotations are evaluated when the `def` runs,
// so a bare interpreter raised NameError at import time and NO test case ran at all —
// which reads as "your code is broken" when the fault was entirely ours.
//
// This is the exact stub the user hit on Concatenation of Array.

import test from 'node:test';
import assert from 'node:assert/strict';

import { runCode } from './run.mjs';

const TWO_SUM_META = {
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]' },
};

const EXAMPLES = '[2,7,11,15]\n9\n[3,2,4]\n6\n[3,3]\n6';
const EXPECTED_HTML = '<pre>Output: [0,1]</pre><pre>Output: [1,2]</pre><pre>Output: [0,1]</pre>';

/** `params` is everything after `self, `, including any `) -> Return` tail. */
function solve(params, returns = '') {
  return [
    'class Solution:',
    `    def twoSum(self, ${params})${returns}:`,
    '        seen = {}',
    '        for i, n in enumerate(nums):',
    '            if target - n in seen:',
    '                return [seen[target - n], i]',
    '            seen[n] = i',
    '',
  ].join('\n');
}

async function run(code) {
  return runCode({
    code,
    metaData: TWO_SUM_META,
    exampleTestcases: EXAMPLES,
    descriptionHtml: EXPECTED_HTML,
  });
}

test("LeetCode's own stub annotations import without a typing import", async () => {
  const result = await run(solve('nums: List[int], target: int', ' -> List[int]'));
  assert.equal(result.error, null, `expected no error, got: ${JSON.stringify(result.error)}`);
  assert.equal(result.ok, true);
  assert.equal(result.summary.passed, 3);
});

test('an explicit typing import still works and is not shadowed', async () => {
  const code = `from typing import List\n${solve('nums: List[int], target: int')}`;
  const result = await run(code);
  assert.equal(result.error, null);
  assert.equal(result.summary.passed, 3);
});

test('Optional / Dict / Tuple annotations resolve too', async () => {
  const result = await run(solve('nums: List[int], target: int', ' -> Optional[List[int]]'));
  assert.equal(result.error, null);
  assert.equal(result.summary.passed, 3);
});

test('Counter and defaultdict are in scope without an import, as on LeetCode', async () => {
  const code = [
    'class Solution:',
    '    def twoSum(self, nums, target):',
    '        counts = Counter(nums)',
    '        buckets = defaultdict(list)',
    '        seen = {}',
    '        for i, n in enumerate(nums):',
    '            if target - n in seen:',
    '                return [seen[target - n], i]',
    '            seen[n] = i',
    '',
  ].join('\n');
  const result = await run(code);
  assert.equal(result.error, null);
  assert.equal(result.summary.passed, 3);
});

test('injecting the namespace does not shift the user\'s line numbers', async () => {
  // The whole reason these names go into builtins rather than being prepended to the
  // file: the traceback must point at the line the user sees in their editor.
  const code = [
    'class Solution:',
    '    def twoSum(self, nums: List[int], target: int) -> List[int]:',
    '        return nums[999]',
    '',
  ].join('\n');
  const result = await run(code);
  const failing = result.cases.find((c) => c.error);
  assert.ok(failing, 'expected a case to raise');
  assert.match(failing.error.traceback, /line 3/);
  assert.match(failing.error.traceback, /solution\.py/);
  assert.doesNotMatch(failing.error.traceback, /_studio_driver/);
});

test('a genuinely missing module is still reported as the user\'s import error', async () => {
  const result = await run(`import definitely_not_a_real_module\n${solve('nums, target')}`);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'compile');
  assert.match(result.error.message, /definitely_not_a_real_module/);
});
