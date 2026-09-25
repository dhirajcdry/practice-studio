// Unit tests for the pure parts: metaData classification, testcase/expected parsing,
// semantic comparison, traceback rewriting. No python is spawned here.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMetaData, classifyProblem, baseTypeOf, isSupportedType } from './meta.mjs';
import {
  buildCases,
  expectedOutputsFromHtml,
  groupLines,
  parseLeadingJson,
  parsePrefixExpected,
  testcaseLines,
} from './testcases.mjs';
import { compareValues, deepEqual } from './compare.mjs';
import { rewriteTraceback, summarize } from './traceback.mjs';

// [VERIFIED 2026-07-25] copied from ~/LeetCodeTutor/cache/leetcode/two-sum.json
const TWO_SUM_META =
  '{\n  "name": "twoSum",\n  "params": [\n    {\n      "name": "nums",\n      "type": "integer[]"\n    },\n    {\n      "name": "target",\n      "type": "integer"\n    }\n  ],\n  "return": {\n    "type": "integer[]",\n    "size": 2\n  },\n  "manual": false\n}';

const LRU_META = {
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
};

test('metaData: parses LeetCode\'s JSON string, and passes an object through', () => {
  const meta = parseMetaData(TWO_SUM_META);
  assert.equal(meta.name, 'twoSum');
  assert.equal(parseMetaData(meta), meta);
  assert.equal(parseMetaData('not json'), null);
  assert.equal(parseMetaData(null), null);
});

test('types: containers are stripped down to the scalar underneath', () => {
  assert.equal(baseTypeOf('integer[][]'), 'integer');
  assert.equal(baseTypeOf('list<list<integer>>'), 'integer');
  assert.equal(baseTypeOf('list<string>'), 'string');
  assert.equal(baseTypeOf('ListNode'), 'listnode');
  assert.ok(isSupportedType('double'));
  assert.ok(isSupportedType('TreeNode'));
  assert.ok(isSupportedType('list<ListNode>'));
  // `Node` is three different classes across three problem families and metaData does not
  // say which. Building the wrong one would produce a verdict we cannot justify.
  assert.ok(!isSupportedType('Node'));
});

test('classify: an ordinary function problem', () => {
  const shape = classifyProblem(parseMetaData(TWO_SUM_META));
  assert.equal(shape.kind, 'function');
  assert.equal(shape.name, 'twoSum');
  assert.equal(shape.params.length, 2);
});

test('classify: linked-list and tree problems are driven, with their types carried through', () => {
  const shape = classifyProblem({
    name: 'reverseList',
    params: [{ name: 'head', type: 'ListNode' }],
    return: { type: 'ListNode' },
  });
  assert.equal(shape.kind, 'function');
  // The driver builds [1,2,3] into a linked list only because these survive to it.
  assert.equal(shape.params[0].type, 'ListNode');
  assert.equal(shape.returnType, 'ListNode');
});

test('classify: a `manual` problem is refused rather than run against the wrong input', () => {
  // "Linked List Cycle": LeetCode ties the tail to node `pos` itself, so the printed
  // example is a list of values AND a position that the signature has no parameter for.
  // Running it as written would call hasCycle([3,2,0,-4]) and then hasCycle(1) — two
  // fabricated cases whose verdicts mean nothing.
  const shape = classifyProblem({
    name: 'hasCycle',
    params: [{ name: 'head', type: 'ListNode' }],
    return: { type: 'boolean' },
    manual: true,
  });
  assert.equal(shape.kind, 'unsupported');
  assert.match(shape.message, /builds this problem's test input by hand/i);
  assert.match(shape.message, /submitting to LeetCode still works/i);
});

test('classify: a graph/n-ary `Node` is still refused — one name, three classes', () => {
  const shape = classifyProblem({
    name: 'cloneGraph',
    params: [{ name: 'node', type: 'Node' }],
    return: { type: 'Node' },
  });
  assert.equal(shape.kind, 'unsupported');
  assert.match(shape.message, /submitting to LeetCode still works/i);
});

test('classify: in-place (void) problems are unsupported rather than guessed at', () => {
  const shape = classifyProblem({
    name: 'sortColors',
    params: [{ name: 'nums', type: 'integer[]' }],
    return: { type: 'void' },
  });
  assert.equal(shape.kind, 'unsupported');
  assert.match(shape.message, /in place/i);
});

test('classify: a design problem is detected as design, not mistaken for a function', () => {
  const shape = classifyProblem(LRU_META);
  assert.equal(shape.kind, 'design');
  assert.equal(shape.classname, 'LRUCache');
  assert.deepEqual(shape.methods.map((m) => m.name), ['get', 'put']);
});

test('classify: a design problem whose methods return a node type is unsupported', () => {
  const shape = classifyProblem({
    classname: 'Thing',
    constructor: { params: [] },
    methods: [{ name: 'head', params: [], return: { type: 'ListNode' } }],
  });
  assert.equal(shape.kind, 'unsupported');
});

test('testcases: lines group per parameter, and a ragged blob is refused', () => {
  const lines = testcaseLines('[2,7,11,15]\n9\n[3,2,4]\r\n6');
  assert.deepEqual(lines, ['[2,7,11,15]', '9', '[3,2,4]', '6']);
  assert.deepEqual(groupLines(lines, 2).cases, [
    ['[2,7,11,15]', '9'],
    ['[3,2,4]', '6'],
  ]);
  const bad = groupLines(['a', 'b', 'c'], 2);
  assert.equal(bad.ok, false);
  assert.match(bad.message, /do not divide evenly/);
});

test('expected outputs are scraped from the description HTML, entities decoded', () => {
  const html =
    '<pre>\n<strong>Input:</strong> nums = [2,7,11,15]\n<strong>Output:</strong> [0,1]\n</pre>' +
    '<pre>\n<strong>Input:</strong> s = &quot;ab&quot;\n<strong>Output:</strong> &quot;ba&quot;\n<strong>Explanation:</strong> nope\n</pre>';
  assert.deepEqual(expectedOutputsFromHtml(html), ['[0,1]', '"ba"']);
});

test('the word "Output:" in prose does not shift the expected values by one', () => {
  const html =
    '<p>Return the Output: in any order.</p>' +
    '<pre><strong>Output:</strong> [1]\n</pre><pre><strong>Output:</strong> [2]\n</pre>';
  assert.deepEqual(expectedOutputsFromHtml(html), ['[1]', '[2]']);
});

test('a JSON value followed by prose still parses', () => {
  assert.deepEqual(parseLeadingJson('[[1,2],[3]] (order does not matter)').value, [[1, 2], [3]]);
  assert.equal(parseLeadingJson('true').value, true);
  assert.equal(parseLeadingJson('').ok, false);
});

test('buildCases pairs inputs with the expected output of the same index', () => {
  const built = buildCases({
    perCase: 2,
    testcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
    descriptionHtml:
      '<pre><strong>Output:</strong> [0,1]\n</pre><pre><strong>Output:</strong> [1,2]\n</pre>',
  });
  assert.equal(built.ok, true);
  assert.equal(built.cases.length, 2);
  assert.deepEqual(built.cases[0].values, [[2, 7, 11, 15], 9]);
  assert.deepEqual(built.cases[1].expectedValue, [1, 2]);
  assert.equal(built.cases[0].input, '[2,7,11,15]\n9');
});

test('buildCases marks a case with no published expected answer', () => {
  const built = buildCases({ perCase: 1, testcases: '[1,2]', descriptionHtml: '' });
  assert.equal(built.cases[0].hasExpected, false);
});

test('compare: floats match inside 1e-5, and do not outside it', () => {
  assert.ok(deepEqual(0.6666666, 0.66667));
  assert.ok(deepEqual([1.0, 2.00000001], [1, 2]));
  assert.ok(!deepEqual(1.0, 1.001));
  assert.equal(compareValues(2.00000, 2).passed, true);
  assert.equal(compareValues(2.5, 2.0).passed, false);
});

test('compare: a different order of the same items is a pass with a note, not a failure', () => {
  const v = compareValues([[-1, 0, 1], [-1, -1, 2]], [[-1, -1, 2], [-1, 0, 1]]);
  assert.equal(v.passed, true);
  assert.equal(v.orderInsensitive, true);
  assert.match(v.note, /different order/i);
});

test('compare: order inside each group is reported as "differs", never asserted either way', () => {
  const v = compareValues([[2, 1], [4, 3]], [[1, 2], [3, 4]]);
  assert.equal(v.passed, null);
  assert.match(v.note, /Differs from expected/);
});

test('compare: genuinely different values are a real failure', () => {
  assert.equal(compareValues([0, 2], [0, 1]).passed, false);
  assert.equal(compareValues([], [0, 1]).passed, false);
  assert.equal(compareValues('abc', 'abd').passed, false);
  assert.equal(compareValues(true, 1).passed, false);
});

test('traceback: driver frames are removed and solution.py keeps the user\'s line numbers', () => {
  const raw = [
    'Traceback (most recent call last):',
    '  File "/var/folders/x/studio-run-abc/_studio_driver.py", line 148, in main',
    '    value = getattr(target(), cfg["name"])(*cfg["args"])',
    '            ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~^^^^^^^^^^^^^^',
    '  File "/private/var/folders/x/studio-run-abc/solution.py", line 5, in twoSum',
    '    return [x // y]',
    '            ~~^^~~',
    'ZeroDivisionError: integer division or modulo by zero',
    '',
  ].join('\n');

  const out = rewriteTraceback(raw, { dir: '/var/folders/x/studio-run-abc' });
  assert.ok(!out.text.includes('_studio_driver'), out.text);
  assert.ok(!out.text.includes('/var/folders'), out.text);
  assert.ok(!out.text.includes('/private'), out.text);
  assert.match(out.text, /File "solution\.py", line 5, in twoSum/);
  assert.match(out.text, /ZeroDivisionError: integer division or modulo by zero$/);
  assert.equal(out.line, 5);
  assert.equal(out.blamesUserCode, true);
  assert.equal(summarize(raw), 'ZeroDivisionError: integer division or modulo by zero');
});

test('traceback: a SyntaxError has no frame, so the line comes out of the report itself', () => {
  const raw = [
    'Traceback (most recent call last):',
    '  File "/tmp/studio-run-1/_studio_driver.py", line 130, in main',
    '    import solution as user_module',
    '  File "/tmp/studio-run-1/solution.py", line 2',
    '    def twoSum(self, nums, target)',
    '                                  ^',
    "SyntaxError: expected ':'",
  ].join('\n');
  const out = rewriteTraceback(raw, { dir: '/tmp/studio-run-1' });
  assert.equal(out.line, 2);
  assert.ok(!out.text.includes('_studio_driver'));
  assert.match(out.text, /File "solution\.py", line 2/);
});

test('traceback: empty in, empty out — no invented blame', () => {
  const out = rewriteTraceback('', {});
  assert.equal(out.text, '');
  assert.equal(out.line, null);
  assert.equal(out.blamesUserCode, false);
});

// -------------------------------------------------------------- order and prefixes

test('expected: "2, nums = [2,2,_,_]" is the first two entries, not the number 2', () => {
  assert.deepEqual(parsePrefixExpected('2, nums = [2,2,_,_]'), { ok: true, value: [2, 2] });
  assert.deepEqual(parsePrefixExpected('5, nums = [0,1,4,0,3,_,_,_]'), { ok: true, value: [0, 1, 4, 0, 3] });
  assert.deepEqual(parsePrefixExpected('0, nums = [_,_]'), { ok: true, value: [] });
  // Read plainly this line yields the COUNT, which would fail correct code against an array.
  assert.equal(parseLeadingJson('2, nums = [2,2,_,_]').value, 2);
});

test('expected: a line that is not in that form is refused rather than half-read', () => {
  assert.equal(parsePrefixExpected('[1,2,3]').ok, false);
  assert.equal(parsePrefixExpected('true').ok, false);
  assert.equal(parsePrefixExpected(null).ok, false);
});

test('compare: strict order refuses the "any order" allowance', () => {
  // Same items, wrong order. Lenient calls it a pass; strict must not.
  assert.equal(compareValues([1, 2, 3], [3, 2, 1]).passed, true);
  assert.equal(compareValues([1, 2, 3], [3, 2, 1], { order: 'strict' }).passed, false);
  assert.equal(compareValues([1, 2, 3], [3, 2, 1], { order: 'unknown' }).passed, null);
  // Strict does not make equal things unequal.
  assert.equal(compareValues([1, 2, 3], [1, 2, 3], { order: 'strict' }).passed, true);
});
