// End-to-end tests: real python3, real subprocesses, real temp dirs.
//
// These are the tests that matter. Everything the contract calls a failure mode is
// asserted here as a *result*, and the timeout test checks that the process group is
// actually gone afterwards — a runaway that spawns a child must not outlive the run.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { runCode, createRunControl } from './run.mjs';
import { sandboxExecPath } from './execute.mjs';

const TWO_SUM = {
  metaData: {
    name: 'twoSum',
    params: [
      { name: 'nums', type: 'integer[]' },
      { name: 'target', type: 'integer' },
    ],
    return: { type: 'integer[]' },
  },
  exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
  descriptionHtml:
    '<pre><strong>Input:</strong> nums = [2,7,11,15], target = 9\n<strong>Output:</strong> [0,1]\n</pre>' +
    '<pre><strong>Input:</strong> nums = [3,2,4], target = 6\n<strong>Output:</strong> [1,2]\n</pre>',
};

const GOOD_TWO_SUM = `class Solution:
    def twoSum(self, nums, target):
        seen = {}
        for i, n in enumerate(nums):
            if target - n in seen:
                return [seen[target - n], i]
            seen[n] = i
        return []
`;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

test('sanity: the macOS sandbox is in use unless it was explicitly turned off', (t) => {
  if (process.env.STUDIO_NO_SANDBOX === '1') return t.skip('sandbox disabled for this run');
  assert.ok(
    process.platform !== 'darwin' || sandboxExecPath() !== null,
    'sandbox-exec should be found on macOS',
  );
});

test('a correct two-sum passes every case', async () => {
  const r = await runCode({ code: GOOD_TWO_SUM, ...TWO_SUM });
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.passed, 2);
  assert.deepEqual(r.cases.map((c) => c.passed), [true, true]);
  assert.equal(r.cases[0].input, '[2,7,11,15]\n9');
  assert.equal(r.cases[0].expected, '[0,1]');
  assert.equal(r.cases[0].actual, '[0,1]');
  assert.equal(r.cases[0].stdout, '');
});

test('a wrong answer is a failed case, not an error, and shows both values', async () => {
  const code = `class Solution:
    def twoSum(self, nums, target):
        return [0, 2]
`;
  const r = await runCode({ code, ...TWO_SUM });
  assert.equal(r.ok, true);
  assert.equal(r.summary.passed, 0);
  assert.equal(r.cases[0].passed, false);
  assert.equal(r.cases[0].actual, '[0,2]');
  assert.equal(r.cases[0].expected, '[0,1]');
  assert.equal(r.cases[0].error, undefined);
});

test('a syntax error is a compile error before any case runs', async () => {
  const code = `class Solution:
    def twoSum(self, nums, target)
        return []
`;
  const r = await runCode({ code, ...TWO_SUM });
  assert.equal(r.ok, false);
  assert.equal(r.cases.length, 0);
  assert.equal(r.error.kind, 'compile');
  assert.match(r.error.message, /SyntaxError/);
  assert.equal(r.error.line, 2);
  assert.ok(!r.error.traceback.includes('_studio_driver'), r.error.traceback);
  assert.match(r.error.traceback, /File "solution\.py", line 2/);
});

test('a missing import is also a compile error', async () => {
  const code = `import totally_not_a_real_module
class Solution:
    def twoSum(self, nums, target):
        return []
`;
  const r = await runCode({ code, ...TWO_SUM });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'compile');
  assert.match(r.error.message, /ModuleNotFoundError/);
});

test('a runtime exception blames the user\'s line, never the driver', async () => {
  const code = `class Solution:
    def twoSum(self, nums, target):
        total = 0
        for n in nums:
            total += n
        return [1 // 0]
`;
  const r = await runCode({ code, ...TWO_SUM });
  assert.equal(r.ok, true, 'a raising case is still a result, not a top-level error');
  const c = r.cases[0];
  assert.equal(c.passed, false);
  assert.equal(c.error.kind, 'runtime');
  assert.match(c.error.message, /ZeroDivisionError/);
  assert.equal(c.error.line, 6, 'the line of `return [1 // 0]` in solution.py');
  assert.ok(!c.error.traceback.includes('_studio_driver'), c.error.traceback);
  assert.ok(!c.error.traceback.includes('/var/folders'), c.error.traceback);
  assert.ok(!c.error.traceback.includes('/private/'), c.error.traceback);
  assert.match(c.error.traceback, /File "solution\.py", line 6, in twoSum/);
  // the second case still runs
  assert.equal(r.cases.length, 2);
});

test('the user\'s prints are captured per case and do not disturb the answer', async () => {
  const code = `class Solution:
    def twoSum(self, nums, target):
        print("debugging", nums)
        return [0, 1] if nums[0] == 2 else [1, 2]
`;
  const r = await runCode({ code, ...TWO_SUM });
  assert.equal(r.summary.passed, 2);
  assert.match(r.cases[0].stdout, /debugging \[2, 7, 11, 15\]/);
});

test('an infinite loop times out, the rest of the cases still run, and nothing survives', async () => {
  const marker = path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-orphan-')), 'child');
  const code = `import subprocess, sys, os
class Solution:
    def twoSum(self, nums, target):
        # a runaway that spawns: the grandchild must die with the group, not linger
        p = subprocess.Popen([sys.executable, "-c",
            "import time,sys\\ntime.sleep(4)\\nopen(sys.argv[1] + '.marker','w').write('alive')",
            ${JSON.stringify(marker)}])
        open(${JSON.stringify(marker)} + ".pid", "w").write(str(p.pid))
        while True:
            pass
`;
  const started = Date.now();
  const r = await runCode({ code, ...TWO_SUM, timeoutMs: 1200 });
  const elapsed = Date.now() - started;

  assert.equal(r.ok, true);
  assert.equal(r.cases[0].error.kind, 'timeout');
  assert.equal(r.cases[0].passed, false);
  assert.ok(elapsed < 6000, `should not have waited for both cases to hang: ${elapsed}ms`);
  assert.equal(r.cases.length, 2, 'the remaining case still runs after a timeout');

  const pid = Number(await fsp.readFile(`${marker}.pid`, 'utf8'));
  assert.ok(Number.isFinite(pid) && pid > 0, 'the grandchild recorded its pid');

  await sleep(3500); // long enough for the grandchild to have written its marker
  assert.equal(alive(pid), false, `grandchild ${pid} survived the process-group kill`);
  assert.equal(fs.existsSync(`${marker}.marker`), false, 'the grandchild kept running after the kill');

  await fsp.rm(path.dirname(marker), { recursive: true, force: true });
});

test('runaway output is capped and the case is stopped', async () => {
  const code = `class Solution:
    def twoSum(self, nums, target):
        while True:
            print("x" * 1000)
        return [0, 1]
`;
  const r = await runCode({ code, ...TWO_SUM, timeoutMs: 8000, outputCapBytes: 16 * 1024 });
  const c = r.cases[0];
  assert.equal(c.error.kind, 'output', JSON.stringify(c));
  assert.ok(c.stdout.length <= 16 * 1024 + 1, `stdout was ${c.stdout.length} bytes`);
  assert.equal(c.truncated, true);
});

test('order-insensitive results are reported as passed with a note', async () => {
  const meta = {
    name: 'threeSum',
    params: [{ name: 'nums', type: 'integer[]' }],
    return: { type: 'list<list<integer>>' },
  };
  const code = `class Solution:
    def threeSum(self, nums):
        return [[-1, 0, 1], [-1, -1, 2]]
`;
  const r = await runCode({
    code,
    metaData: meta,
    exampleTestcases: '[-1,0,1,2,-1,-4]',
    descriptionHtml: '<pre><strong>Output:</strong> [[-1,-1,2],[-1,0,1]]\n</pre>',
  });
  assert.equal(r.cases[0].passed, true);
  assert.equal(r.cases[0].orderInsensitive, true);
  assert.equal(r.summary.passed, 1);
});

test('floats compare with tolerance', async () => {
  const meta = {
    name: 'average',
    params: [{ name: 'salary', type: 'integer[]' }],
    return: { type: 'double' },
  };
  const code = `class Solution:
    def average(self, salary):
        return sum(salary) / len(salary)
`;
  const r = await runCode({
    code,
    metaData: meta,
    exampleTestcases: '[1,2,3]',
    descriptionHtml: '<pre><strong>Output:</strong> 2.00000\n</pre>',
  });
  assert.equal(r.cases[0].passed, true, JSON.stringify(r.cases[0]));
});

test('a case with no published expected answer is shown, never scored as a pass', async () => {
  const r = await runCode({
    code: GOOD_TWO_SUM,
    metaData: TWO_SUM.metaData,
    exampleTestcases: TWO_SUM.exampleTestcases,
    descriptionHtml: '', // no Output: anywhere
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.passed, 0);
  assert.equal(r.cases[0].passed, null);
  assert.equal(r.cases[0].actual, '[0,1]');
  assert.match(r.cases[0].note, /does not publish an expected answer/i);
});

// ------------------------------------------------------------------ nodes
//
// LeetCode prints a linked list as an array of its values and a tree as its level-order
// array. The judge builds the object before calling you and flattens what you return. So
// do we — which means the box shows what LeetCode shows, and so does the result.

const REVERSE_LIST_META = {
  name: 'reverseList',
  params: [{ name: 'head', type: 'ListNode' }],
  return: { type: 'ListNode' },
};

test('a linked list is built from its array and flattened back to one', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def reverseList(self, head):',
      '        prev = None',
      '        while head:',
      '            head.next, prev, head = prev, head, head.next',
      '        return prev',
    ].join('\n'),
    metaData: REVERSE_LIST_META,
    exampleTestcases: '[1,2,3,4,5]\n[1,2]\n[]',
    descriptionHtml:
      '<pre><strong>Output:</strong> [5,4,3,2,1]</pre>'
      + '<pre><strong>Output:</strong> [2,1]</pre>'
      + '<pre><strong>Output:</strong> []</pre>',
  });
  assert.equal(r.ok, true);
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
  assert.equal(r.cases[0].actual, '[5,4,3,2,1]');
  assert.equal(r.cases[2].actual, '[]', 'an empty list is [] and not null');
});

test('a linked list in the WRONG ORDER is a failure, never an "any order" pass', async () => {
  // The trap this exists for: a linked list arrives at the comparator as a plain array, and
  // the comparator's "same items, different order — this problem accepts any order"
  // allowance would turn a reverseList that reversed nothing into a green pass.
  const r = await runCode({
    code: 'class Solution:\n    def reverseList(self, head):\n        return head\n',
    metaData: REVERSE_LIST_META,
    exampleTestcases: '[1,2,3,4,5]',
    descriptionHtml: '<pre><strong>Output:</strong> [5,4,3,2,1]</pre>',
  });
  assert.equal(r.cases[0].passed, false);
  assert.equal(r.cases[0].orderInsensitive, undefined);
  assert.equal(r.summary.passed, 0);
});

test('a returned list that loops back on itself is reported, not followed forever', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def reverseList(self, head):',
      '        if head: head.next = head',
      '        return head',
    ].join('\n'),
    metaData: REVERSE_LIST_META,
    exampleTestcases: '[1,2,3]',
    descriptionHtml: '<pre><strong>Output:</strong> [3,2,1]</pre>',
    timeoutMs: 5000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.cases[0].passed, null, 'a cycle is not comparable, so it is not a verdict');
  assert.match(r.cases[0].note, /loops back on itself/i);
});

test('a tree is built level-order with nulls, and printed back the same way', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def invertTree(self, root):',
      '        if not root: return None',
      '        root.left, root.right = self.invertTree(root.right), self.invertTree(root.left)',
      '        return root',
    ].join('\n'),
    metaData: {
      name: 'invertTree',
      params: [{ name: 'root', type: 'TreeNode' }],
      return: { type: 'TreeNode' },
    },
    exampleTestcases: '[4,2,7,1,3,6,9]\n[]',
    descriptionHtml: '<pre><strong>Output:</strong> [4,7,2,9,6,3,1]</pre><pre><strong>Output:</strong> []</pre>',
  });
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
});

test('a tree with holes keeps its shape — [3,9,20,null,null,15,7] is depth 3', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def maxDepth(self, root):',
      '        if not root: return 0',
      '        return 1 + max(self.maxDepth(root.left), self.maxDepth(root.right))',
    ].join('\n'),
    metaData: {
      name: 'maxDepth',
      params: [{ name: 'root', type: 'TreeNode' }],
      return: { type: 'integer' },
    },
    exampleTestcases: '[3,9,20,null,null,15,7]\n[1,null,2]',
    descriptionHtml: '<pre><strong>Output:</strong> 3</pre><pre><strong>Output:</strong> 2</pre>',
  });
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
});

test('a list OF lists — merge k sorted lists takes [[1,4,5],[1,3,4]]', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def mergeKLists(self, lists):',
      '        vals = []',
      '        for node in lists:',
      '            while node:',
      '                vals.append(node.val); node = node.next',
      '        head = None',
      '        for v in sorted(vals, reverse=True):',
      '            head = ListNode(v, head)',
      '        return head',
    ].join('\n'),
    metaData: {
      name: 'mergeKLists',
      params: [{ name: 'lists', type: 'ListNode[]' }],
      return: { type: 'ListNode' },
    },
    exampleTestcases: '[[1,4,5],[1,3,4],[2,6]]\n[]\n[[]]',
    descriptionHtml:
      '<pre><strong>Output:</strong> [1,1,2,3,4,4,5,6]</pre>'
      + '<pre><strong>Output:</strong> []</pre><pre><strong>Output:</strong> []</pre>',
  });
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
});

test("the user's own ListNode class is the one that gets built", async () => {
  // People uncomment LeetCode's stub definition. If we built our own class beside theirs,
  // their `isinstance(node, ListNode)` would be false against an object that is a ListNode
  // in every way that matters.
  const r = await runCode({
    code: [
      'class ListNode:',
      '    def __init__(self, val=0, next=None):',
      '        self.val = val; self.next = next',
      '',
      'class Solution:',
      '    def reverseList(self, head):',
      '        assert head is None or isinstance(head, ListNode)',
      '        prev = None',
      '        while head:',
      '            head.next, prev, head = prev, head, head.next',
      '        return prev',
    ].join('\n'),
    metaData: REVERSE_LIST_META,
    exampleTestcases: '[1,2,3]',
    descriptionHtml: '<pre><strong>Output:</strong> [3,2,1]</pre>',
  });
  assert.equal(r.cases[0].passed, true, JSON.stringify(r.cases[0]));
});

test('returning the wrong kind of thing says so, and is not scored as a fail', async () => {
  const r = await runCode({
    code: 'class Solution:\n    def reverseList(self, head):\n        return [3,2,1]\n',
    metaData: REVERSE_LIST_META,
    exampleTestcases: '[1,2,3]',
    descriptionHtml: '<pre><strong>Output:</strong> [3,2,1]</pre>',
  });
  assert.equal(r.cases[0].passed, null);
  assert.match(r.cases[0].note, /returns a ListNode and your code returned a list/i);
});

test('a case that is not shaped like a linked list blames the case, not the code', async () => {
  const r = await runCode({
    code: 'class Solution:\n    def reverseList(self, head):\n        return head\n',
    metaData: REVERSE_LIST_META,
    testcases: '5',
    exampleTestcases: '5',
  });
  assert.equal(r.cases[0].passed, false);
  assert.equal(r.cases[0].error.kind, 'unsupported');
  assert.match(r.cases[0].error.message, /array of its values/i);
});

// ------------------------------------------------------- in place, per metaData
//
// The answer is the argument the solution mutated. Which argument is not a guess:
// `output.paramindex` says so, and `output.size: "ret"` says only the first N count.

test('an in-place problem is checked on the argument metaData names', async () => {
  const r = await runCode({
    code: 'class Solution:\n    def sortColors(self, nums):\n        nums.sort()\n',
    metaData: {
      name: 'sortColors',
      params: [{ name: 'nums', type: 'integer[]' }],
      return: { type: 'void' },
      output: { paramindex: 0 },
    },
    exampleTestcases: '[2,0,2,1,1,0]\n[2,0,1]',
    descriptionHtml: '<pre><strong>Output:</strong> [0,0,1,1,2,2]</pre><pre><strong>Output:</strong> [0,1,2]</pre>',
  });
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
});

test('an in-place solution that does NOTHING fails — the items match, the order is the answer', async () => {
  // The false pass this guards: an untouched array is a perfect multiset match against the
  // sorted one, so the comparator's "same items, any order" allowance would score a
  // solution that solved nothing as green.
  const r = await runCode({
    code: 'class Solution:\n    def sortColors(self, nums):\n        pass\n',
    metaData: {
      name: 'sortColors',
      params: [{ name: 'nums', type: 'integer[]' }],
      return: { type: 'void' },
      output: { paramindex: 0 },
    },
    exampleTestcases: '[2,0,2,1,1,0]',
    descriptionHtml: '<pre><strong>Output:</strong> [0,0,1,1,2,2]</pre>',
  });
  assert.equal(r.cases[0].passed, false);
  assert.equal(r.summary.passed, 0);
});

test('"Output: 2, nums = [2,2,_,_]" is read as the first 2 entries, not as the number 2', async () => {
  const r = await runCode({
    code: [
      'class Solution:',
      '    def removeElement(self, nums, val):',
      '        k = 0',
      '        for x in nums:',
      '            if x != val:',
      '                nums[k] = x; k += 1',
      '        return k',
    ].join('\n'),
    metaData: {
      name: 'removeElement',
      params: [{ name: 'nums', type: 'integer[]' }, { name: 'val', type: 'integer' }],
      return: { type: 'integer' },
      output: { paramindex: 0, size: 'ret' },
    },
    exampleTestcases: '[3,2,2,3]\n3',
    descriptionHtml: '<pre><strong>Output:</strong> 2, nums = [2,2,_,_]</pre>',
  });
  assert.equal(r.cases[0].passed, true, JSON.stringify(r.cases[0]));
  assert.equal(r.cases[0].actual, '[2,2]');
  assert.equal(r.cases[0].expected, '[2,2]', 'the compared value is the one displayed');
});

test('an in-place problem with no output spec is still refused rather than guessed', async () => {
  const r = await runCode({
    code: 'class Solution:\n    def mystery(self, nums):\n        nums.sort()\n',
    metaData: {
      name: 'mystery',
      params: [{ name: 'nums', type: 'integer[]' }],
      return: { type: 'void' },
    },
    exampleTestcases: '[3,1,2]',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'unsupported');
  assert.match(r.error.message, /did not say which argument/i);
});

test('a `manual` problem never runs — the printed example is not the whole input', async () => {
  const r = await runCode({
    code: 'class Solution:\n    def hasCycle(self, head):\n        return False\n',
    metaData: {
      name: 'hasCycle',
      params: [{ name: 'head', type: 'ListNode' }],
      return: { type: 'boolean' },
      manual: true,
    },
    exampleTestcases: '[3,2,0,-4]\n1',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'unsupported');
  assert.deepEqual(r.cases, [], 'better nothing than two fabricated cases');
  assert.match(r.error.message, /submitting to leetcode still works/i);
});

test('real LeetCode data: a cached problem runs straight from its cache entry', async (t) => {
  // Uses whatever the user has already opened. Skipped rather than failed on a fresh machine,
  // because this test is about real metaData, not about the cache being populated.
  const file = path.join(os.homedir(), 'LeetCodeTutor', 'cache', 'leetcode', 'two-sum.json');
  if (!fs.existsSync(file)) return t.skip('two-sum has not been fetched on this machine yet');
  const { question } = JSON.parse(await fsp.readFile(file, 'utf8'));
  const r = await runCode({
    code: GOOD_TWO_SUM,
    metaData: question.metaData, // the raw string LeetCode sends
    exampleTestcases: question.exampleTestcases,
    descriptionHtml: question.content,
  });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.summary.total, 3);
  assert.equal(r.summary.passed, 3);
});

// --- design problems -----------------------------------------------------------------

const LRU = {
  metaData: {
    classname: 'LRUCache',
    constructor: { params: [{ type: 'integer', name: 'capacity' }] },
    methods: [
      { name: 'get', params: [{ type: 'integer', name: 'key' }], return: { type: 'integer' } },
      {
        name: 'put',
        params: [
          { type: 'integer', name: 'key' },
          { type: 'integer', name: 'value' },
        ],
        return: { type: 'void' },
      },
    ],
    return: { type: 'void' },
    systemdesign: true,
  },
  exampleTestcases:
    '["LRUCache","put","put","get","put","get","get"]\n[[2],[1,1],[2,2],[1],[3,3],[2],[3]]',
  descriptionHtml:
    '<pre><strong>Output:</strong> [null,null,null,1,null,-1,3]\n</pre>',
};

const GOOD_LRU = `from collections import OrderedDict

class LRUCache:
    def __init__(self, capacity):
        self.cap = capacity
        self.d = OrderedDict()

    def get(self, key):
        if key not in self.d:
            return -1
        self.d.move_to_end(key)
        return self.d[key]

    def put(self, key, value):
        if key in self.d:
            self.d.move_to_end(key)
        self.d[key] = value
        if len(self.d) > self.cap:
            self.d.popitem(last=False)
`;

test('design problems are detected and driven as constructor + operations', async () => {
  const r = await runCode({ code: GOOD_LRU, ...LRU });
  assert.equal(r.ok, true, JSON.stringify(r.error));
  assert.equal(r.cases[0].actual, '[null,null,null,1,null,-1,3]');
  assert.equal(r.cases[0].passed, true);
});

test('a wrong design solution fails honestly', async () => {
  const code = GOOD_LRU.replace('return self.d[key]', 'return 99');
  const r = await runCode({ code, ...LRU });
  assert.equal(r.cases[0].passed, false);
  assert.equal(r.cases[0].actual, '[null,null,null,99,null,-1,99]');
});

test('a design problem the runner cannot drive returns unsupported, never a pass', async () => {
  const r = await runCode({
    code: 'class Codec:\n    pass\n',
    metaData: {
      classname: 'Codec',
      constructor: { params: [] },
      methods: [
        { name: 'serialize', params: [{ type: 'TreeNode', name: 'root' }], return: { type: 'string' } },
      ],
    },
    exampleTestcases: '[1,2,3]\n[[1]]',
  });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'unsupported');
});

test('a missing Solution class is a compile-time answer, not a crash', async () => {
  const r = await runCode({ code: 'x = 1\n', ...TWO_SUM });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'compile');
  assert.match(r.error.message, /does not define a class named Solution/);
});

test('a misnamed method is reported by name', async () => {
  const r = await runCode({ code: 'class Solution:\n    def two_sum(self):\n        pass\n', ...TWO_SUM });
  assert.equal(r.error.kind, 'compile');
  assert.match(r.error.message, /does not define a method named twoSum/);
});

test('empty code is refused without spawning anything', async () => {
  const r = await runCode({ code: '   ', ...TWO_SUM });
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'compile');
});

test('the temp workspace is wiped even when the run fails', async () => {
  const before = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('studio-run-'));
  await runCode({ code: 'class Solution:\n    def twoSum(self, a, b):\n        return [0,1]\n', ...TWO_SUM });
  await runCode({ code: 'def broken(', ...TWO_SUM });
  const after = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('studio-run-'));
  assert.deepEqual(after, before, 'left a workspace behind');
});

test('a run can be cancelled while it is hanging', async () => {
  const control = createRunControl();
  const code = 'class Solution:\n    def twoSum(self, nums, target):\n        while True:\n            pass\n';
  const promise = runCode({ code, ...TWO_SUM, timeoutMs: 30000, control });
  await sleep(700);
  control.cancel();
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.error.kind, 'cancelled');
});

test('the child cannot open a network connection', async () => {
  const meta = {
    name: 'probe',
    params: [{ name: 'x', type: 'integer' }],
    return: { type: 'string' },
  };
  const code = `import socket
class Solution:
    def probe(self, x):
        try:
            socket.create_connection(("93.184.216.34", 80), 2)
            return "connected"
        except BaseException as e:
            return "blocked"
`;
  const r = await runCode({
    code,
    metaData: meta,
    exampleTestcases: '1',
    descriptionHtml: '<pre><strong>Output:</strong> "blocked"\n</pre>',
    timeoutMs: 8000,
  });
  assert.equal(r.cases[0].actual, '"blocked"', JSON.stringify(r.cases[0]));
});
