// A temp workspace with two-sum cached the way the problem route caches it, for the
// tutor-tool tests. Never the real ~/LeetCodeTutor.

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const META = {
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]' },
};

export const STATEMENT = '<p>Given an array of integers <code>nums</code>&nbsp;and an integer <code>target</code>, return <em>indices of the two numbers</em>.</p>'
  + '<p><strong class="example">Example 1:</strong></p><pre><strong>Input:</strong> nums = [2,7,11,15], target = 9\n<strong>Output:</strong> [0,1]\n</pre>'
  + '<p><strong class="example">Example 2:</strong></p><pre><strong>Input:</strong> nums = [3,2,4], target = 6\n<strong>Output:</strong> [1,2]\n</pre>'
  + '<p><strong>Constraints:</strong></p><ul><li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li></ul>';

export const WORKING = [
  'class Solution:',
  '    def twoSum(self, nums, target):',
  '        seen = {}',
  '        for i, n in enumerate(nums):',
  '            if target - n in seen:',
  '                return [seen[target - n], i]',
  '            seen[n] = i',
  '',
].join('\n');

export async function workspace({ cached = true, solution = WORKING } = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-tools-'));
  if (cached) {
    const dir = path.join(root, 'cache', 'leetcode');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'two-sum.json'), JSON.stringify({
      slug: 'two-sum',
      fetchedAt: '2026-10-01T00:00:00.000Z',
      complete: true,
      question: {
        title: 'Two Sum',
        content: STATEMENT,
        exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
        metaData: JSON.stringify(META),
        codeSnippets: [{ langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums: List[int], target: int) -> List[int]:\n        ' }],
      },
    }));
  }
  if (solution !== null) {
    await fsp.mkdir(path.join(root, 'problems', 'two-sum'), { recursive: true });
    await fsp.writeFile(path.join(root, 'problems', 'two-sum', 'solution.py'), solution);
  }
  return { root, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}
