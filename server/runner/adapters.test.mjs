// The problems whose printed example is not their argument list.
//
// Every metaData, stub, exampleTestcases and Output below is copied verbatim from
// LeetCode's GraphQL question for that slug. [VERIFIED 2026-07-28]
//
// Half of these tests are the correct solution passing. The other half matter more: the
// wrong solution that the adapter must not wave through. `return node` for clone-graph
// and `return head` for copy-list-with-random-pointer are the exact solutions those two
// problems exist to rule out, and an adapter that flattened whatever came back would
// score both of them green.

import test from 'node:test';
import assert from 'node:assert/strict';

import { adapterFor, adaptedExpected, adaptedSlugs, normaliseQuadTree } from './adapters.mjs';
import { classifyProblem } from './meta.mjs';
import { runCode } from './run.mjs';

const py = (...lines) => lines.join('\n') + '\n';

/* ------------------------------------------------------------------ the guard rail */

const CYCLE_META = {
  name: 'hasCycle',
  params: [{ name: 'head', type: 'ListNode' }, { name: 'pos', type: 'integer' }],
  return: { type: 'boolean' },
  manual: true,
};

test('an adapter only applies to metaData shaped the way it was written for', () => {
  assert.ok(adapterFor('linked-list-cycle', CYCLE_META));

  // The whole safety of adapters.mjs. If LeetCode reshapes a problem, the recipe written
  // for the old shape must stop applying rather than run something else against it.
  assert.equal(adapterFor('linked-list-cycle', { ...CYCLE_META, name: 'hasCycleV2' }), null);
  assert.equal(
    adapterFor('linked-list-cycle', { ...CYCLE_META, params: [{ name: 'head', type: 'ListNode' }] }),
    null,
  );
  assert.equal(adapterFor('linked-list-cycle', { ...CYCLE_META, return: { type: 'integer' } }), null);
  assert.equal(adapterFor('two-sum', CYCLE_META), null, 'a slug with no recipe has no recipe');
});

test('a problem whose metaData moved goes back to being refused, not adapted', () => {
  const moved = { ...CYCLE_META, params: [{ name: 'head', type: 'ListNode' }] };
  const shape = classifyProblem(moved, { slug: 'linked-list-cycle' });
  assert.equal(shape.kind, 'unsupported');
  assert.match(shape.message, /submitting to LeetCode still works/i);
});

test('the classifier only reaches for a recipe when it knows which problem it is', () => {
  assert.equal(classifyProblem(CYCLE_META).kind, 'unsupported', 'no slug, no recipe');
  assert.equal(classifyProblem(CYCLE_META, { slug: 'linked-list-cycle' }).kind, 'function');
});

test('every slug with a recipe is spelled the way LeetCode spells it', () => {
  for (const slug of adaptedSlugs()) {
    assert.match(slug, /^[a-z0-9-]+$/, slug);
  }
  assert.ok(adaptedSlugs().length >= 12);
});

/* ------------------------------------------- the answers printed as a sentence */

test('"tail connects to node index 1" is an index, and "no cycle" is nothing', () => {
  assert.deepEqual(adaptedExpected('cycle-index', 'tail connects to node index 1'), { ok: true, value: 1 });
  assert.deepEqual(adaptedExpected('cycle-index', 'no cycle'), { ok: true, value: null });
  assert.equal(adaptedExpected('cycle-index', 'something else').ok, false);
});

test("\"Intersected at '8'\" is a value, and \"No intersection\" is nothing", () => {
  assert.deepEqual(adaptedExpected('intersection-value', "Intersected at '8'"), { ok: true, value: 8 });
  assert.deepEqual(adaptedExpected('intersection-value', 'No intersection'), { ok: true, value: null });
});

test('a round trip is expected to give back exactly what went in', () => {
  // encode-and-decode-strings is premium: LeetCode serves no description to scrape, and
  // none is needed.
  assert.deepEqual(adaptedExpected('echo-input', null, [['a', 'b']]), { ok: true, value: ['a', 'b'] });
  assert.equal(adaptedExpected('echo-input', null, []).ok, false);
});

test('a quad tree node that is not a leaf has no value to compare', () => {
  // The statement says either value is acceptable there, so comparing it would fail
  // correct answers that happened to write the other one.
  assert.deepEqual(normaliseQuadTree([[0, 0], [1, 0], [1, 1]]), [[0, 1], [1, 0], [1, 1]]);
  assert.deepEqual(normaliseQuadTree([[0, 1], null]), [[0, 1], null]);
});

/* --------------------------------------------------------------- end to end */

/** The real thing: LeetCode's own metaData, examples and Output lines. */
async function run(slug, metaData, exampleTestcases, outputs, code) {
  return runCode({
    slug,
    code,
    metaData,
    exampleTestcases,
    descriptionHtml: outputs.map((o) => `<pre><strong>Output:</strong> ${o}</pre>`).join(''),
  });
}

test('linked-list-cycle: the second line ties the tail back, and is not a case of its own', async () => {
  const r = await run(
    'linked-list-cycle',
    CYCLE_META,
    '[3,2,0,-4]\n1\n[1,2]\n0\n[1]\n-1',
    ['true', 'true', 'false'],
    py(
      'class Solution:',
      '    def hasCycle(self, head):',
      '        slow = fast = head',
      '        while fast and fast.next:',
      '            slow, fast = slow.next, fast.next.next',
      '            if slow is fast: return True',
      '        return False',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.cases.length, 3, 'six lines, two per case — not six cases');
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
});

test('linked-list-cycle: always answering true fails the list that has no cycle', async () => {
  const r = await run(
    'linked-list-cycle',
    CYCLE_META,
    '[3,2,0,-4]\n1\n[1]\n-1',
    ['true', 'false'],
    py('class Solution:', '    def hasCycle(self, head):', '        return True'),
  );
  assert.equal(r.cases[1].passed, false);
});

const CLONE_GRAPH_META = {
  name: 'cloneGraph',
  params: [{ name: 'edges', type: 'integer[][]' }],
  return: { type: 'boolean' },
  manual: true,
};

test('clone-graph: an adjacency list in, an adjacency list out', async () => {
  const r = await run(
    'clone-graph',
    CLONE_GRAPH_META,
    '[[2,4],[1,3],[2,4],[1,3]]\n[[]]\n[]',
    ['[[2,4],[1,3],[2,4],[1,3]]', '[[]]', '[]'],
    py(
      'class Solution:',
      '    def cloneGraph(self, node):',
      '        if not node: return None',
      '        m = {}',
      '        def dfs(n):',
      '            if n in m: return m[n]',
      '            c = Node(n.val)',
      '            m[n] = c',
      '            for nb in n.neighbors: c.neighbors.append(dfs(nb))',
      '            return c',
      '        return dfs(node)',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
});

test('clone-graph: `return node` is caught — it is the graph, not a copy of it', async () => {
  // Serialise the answer without checking identity and this scores 3/3, on the one
  // solution the problem exists to rule out.
  const r = await run(
    'clone-graph',
    CLONE_GRAPH_META,
    '[[2,4],[1,3],[2,4],[1,3]]',
    ['[[2,4],[1,3],[2,4],[1,3]]'],
    py('class Solution:', '    def cloneGraph(self, node):', '        return node'),
  );
  assert.notEqual(r.cases[0].passed, true);
  assert.match(r.cases[0].error?.message ?? '', /rather than a copy/i);
});

const COPY_RANDOM_META = {
  name: 'copyRandomList',
  params: [{ name: 'head', type: 'ListNode' }],
  return: { type: 'ListNode' },
  manual: true,
};

test('copy-list-with-random-pointer: [value, random index] in and out', async () => {
  const r = await run(
    'copy-list-with-random-pointer',
    COPY_RANDOM_META,
    '[[7,null],[13,0],[11,4],[10,2],[1,0]]\n[[1,1],[2,1]]',
    ['[[7,null],[13,0],[11,4],[10,2],[1,0]]', '[[1,1],[2,1]]'],
    py(
      'class Solution:',
      '    def copyRandomList(self, head):',
      '        m = {}',
      '        cur = head',
      '        while cur:',
      '            m[cur] = Node(cur.val)',
      '            cur = cur.next',
      '        cur = head',
      '        while cur:',
      '            m[cur].next = m.get(cur.next)',
      '            m[cur].random = m.get(cur.random)',
      '            cur = cur.next',
      '        return m.get(head)',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
});

test('copy-list-with-random-pointer: a copy that forgets the random pointers fails', async () => {
  const r = await run(
    'copy-list-with-random-pointer',
    COPY_RANDOM_META,
    '[[7,null],[13,0],[11,4],[10,2],[1,0]]',
    ['[[7,null],[13,0],[11,4],[10,2],[1,0]]'],
    py(
      'class Solution:',
      '    def copyRandomList(self, head):',
      '        if not head: return None',
      '        vals = []',
      '        c = head',
      '        while c: vals.append(c.val); c = c.next',
      '        first = Node(vals[0])',
      '        cur = first',
      '        for v in vals[1:]:',
      '            cur.next = Node(v); cur = cur.next',
      '        return first',
    ),
  );
  assert.equal(r.cases[0].passed, false, 'the values line up; the random pointers do not');
});

const LCA_META = {
  name: 'lowestCommonAncestor',
  params: [
    { name: 'root', type: 'TreeNode' },
    { name: 'p', type: 'integer' },
    { name: 'q', type: 'integer' },
  ],
  return: { type: 'TreeNode' },
  manual: true,
};

const LCA_BST = py(
  'class Solution:',
  '    def lowestCommonAncestor(self, root, p, q):',
  '        while root:',
  '            if p.val < root.val and q.val < root.val: root = root.left',
  '            elif p.val > root.val and q.val > root.val: root = root.right',
  '            else: return root',
);

test('lowest-common-ancestor: the values are looked up as nodes, and the answer is a value', async () => {
  const r = await run(
    'lowest-common-ancestor-of-a-binary-search-tree',
    LCA_META,
    '[6,2,8,0,4,7,9,null,null,3,5]\n2\n8\n[6,2,8,0,4,7,9,null,null,3,5]\n2\n4\n[2,1]\n2\n1',
    ['6', '2', '2'],
    LCA_BST,
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
  assert.equal(r.cases[0].actual, '6', 'LeetCode prints the value, not the subtree');
});

test('lowest-common-ancestor: always returning the root is caught', async () => {
  const r = await run(
    'lowest-common-ancestor-of-a-binary-search-tree',
    LCA_META,
    '[6,2,8,0,4,7,9,null,null,3,5]\n2\n4',
    ['2'],
    py('class Solution:', '    def lowestCommonAncestor(self, root, p, q):', '        return root'),
  );
  assert.equal(r.cases[0].passed, false);
});

test('serialize-and-deserialize: a Codec that hides the tree on self does not survive', async () => {
  // Two instances, as the stub's own footer spells out. One instance and this passes.
  const r = await run(
    'serialize-and-deserialize-binary-tree',
    { name: 'Codec', params: [{ name: 'root', type: 'TreeNode' }], return: { type: 'string' }, manual: true },
    '[1,2,3,null,null,4,5]',
    ['[1,2,3,null,null,4,5]'],
    py(
      'class Codec:',
      '    def serialize(self, root):',
      '        self.saved = root',
      '        return "x"',
      '',
      '    def deserialize(self, data):',
      '        return getattr(self, "saved", None)',
    ),
  );
  assert.notEqual(r.cases[0].passed, true, JSON.stringify(r.cases[0]));
});

const MOUNTAIN_META = {
  name: 'findInMountainArray',
  params: [{ name: 'mountainArr', type: 'integer[]' }, { name: 'target', type: 'integer' }],
  return: { type: 'integer' },
  manual: true,
};

const LINEAR_SCAN = py(
  'class Solution:',
  '    def findInMountainArray(self, target, mountainArr):',
  '        for i in range(mountainArr.length()):',
  '            if mountainArr.get(i) == target: return i',
  '        return -1',
);

test('find-in-mountain-array: the arguments arrive in the stub\'s order, not metaData\'s', async () => {
  const r = await run(
    'find-in-mountain-array',
    MOUNTAIN_META,
    '[1,2,3,4,5,3,1]\n3\n[0,1,2,4,2,1]\n3',
    ['2', '-1'],
    LINEAR_SCAN,
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
  // LeetCode's published examples are 6 and 7 long, so a linear scan passes them there
  // too. Saying how much of the budget went is the honest way to show that.
  assert.match(r.cases[0].note ?? '', /Used \d+ of the 100 allowed/);
});

test('find-in-mountain-array: the call budget is real on a case worth the name', async () => {
  const r = await runCode({
    slug: 'find-in-mountain-array',
    code: LINEAR_SCAN,
    metaData: MOUNTAIN_META,
    testcases: `${JSON.stringify([...Array(150).keys()])}\n149`,
    expectedOverrides: [null],
    exampleTestcases: '[1,2,3]\n3',
  });
  assert.equal(r.cases[0].passed, false);
  assert.match(r.cases[0].error?.message ?? '', /more than 100 times/);
});

test('construct-quad-tree: level order, four slots a node, trailing nulls trimmed', async () => {
  const r = await run(
    'construct-quad-tree',
    {
      name: 'construct',
      params: [{ name: 'grid', type: 'integer[][]' }],
      return: { type: 'list<list<integer>>' },
      manual: true,
    },
    '[[0,1],[1,0]]',
    ['[[0,1],[1,0],[1,1],[1,1],[1,0]]'],
    py(
      'class Solution:',
      '    def construct(self, grid):',
      '        def build(r, c, n):',
      '            if n == 1:',
      '                return Node(grid[r][c] == 1, True, None, None, None, None)',
      '            h = n // 2',
      '            tl = build(r, c, h); tr = build(r, c+h, h)',
      '            bl = build(r+h, c, h); br = build(r+h, c+h, h)',
      '            kids = [tl, tr, bl, br]',
      '            if all(k.isLeaf for k in kids) and len({k.val for k in kids}) == 1:',
      '                return Node(tl.val, True, None, None, None, None)',
      '            return Node(True, False, tl, tr, bl, br)',
      '        return build(0, 0, len(grid))',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.cases[0].actual, '[[0,1],[1,0],[1,1],[1,1],[1,0]]');
  assert.equal(r.cases[0].passed, true);
});

test('guess-number: the pick reaches the solution through guess(), not as an argument', async () => {
  const r = await run(
    'guess-number-higher-or-lower',
    {
      name: 'guessNumber',
      params: [{ name: 'n', type: 'integer' }, { name: 'pick', type: 'integer' }],
      return: { type: 'integer' },
      manual: true,
    },
    '10\n6\n1\n1\n2\n1',
    ['6', '1', '1'],
    py(
      'class Solution:',
      '    def guessNumber(self, n):',
      '        lo, hi = 1, n',
      '        while lo <= hi:',
      '            mid = (lo + hi) // 2',
      '            r = guess(mid)',
      '            if r == 0: return mid',
      '            if r < 0: hi = mid - 1',
      '            else: lo = mid + 1',
      '        return -1',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
});

test('intersection-of-two-linked-lists: five lines of setup, two arguments', async () => {
  const r = await run(
    'intersection-of-two-linked-lists',
    {
      name: 'getIntersectionNode',
      params: [
        { name: 'intersectVal', type: 'integer' },
        { name: 'listA', type: 'ListNode' },
        { name: 'listB', type: 'ListNode' },
        { name: 'skipA', type: 'integer' },
        { name: 'skipB', type: 'integer' },
      ],
      return: { type: 'ListNode' },
      manual: true,
    },
    '8\n[4,1,8,4,5]\n[5,6,1,8,4,5]\n2\n3\n2\n[1,9,1,2,4]\n[3,2,4]\n3\n1\n0\n[2,6,4]\n[1,5]\n3\n2',
    ["Intersected at '8'", "Intersected at '2'", 'No intersection'],
    py(
      'class Solution:',
      '    def getIntersectionNode(self, headA, headB):',
      '        a, b = headA, headB',
      '        while a is not b:',
      '            a = a.next if a else headB',
      '            b = b.next if b else headA',
      '        return a',
    ),
  );
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.cases.length, 3, 'fifteen lines, five per case');
  assert.equal(r.summary.passed, 3, JSON.stringify(r.cases));
});

test('encode-and-decode-strings: the answer is what went in', async () => {
  const r = await runCode({
    slug: 'encode-and-decode-strings',
    metaData: {
      name: 'encode',
      params: [{ name: 'dummy_input', type: 'list<string>' }],
      return: { type: 'list<string>' },
      manual: true,
    },
    // Premium: LeetCode serves no description at all, so there is nothing to scrape.
    exampleTestcases: '["Hello","World"]\n[""]',
    descriptionHtml: null,
    code: py(
      'class Codec:',
      '    def encode(self, strs):',
      '        return "".join(str(len(s)) + "#" + s for s in strs)',
      '',
      '    def decode(self, s):',
      '        out, i = [], 0',
      '        while i < len(s):',
      '            j = s.index("#", i)',
      '            n = int(s[i:j])',
      '            out.append(s[j+1:j+1+n])',
      '            i = j + 1 + n',
      '        return out',
    ),
  });
  assert.equal(r.ok, true, r.error?.message);
  assert.equal(r.summary.passed, 2, JSON.stringify(r.cases));
});
