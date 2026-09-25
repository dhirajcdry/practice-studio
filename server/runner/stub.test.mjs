// What `manual: true` actually means for one problem, settled against LeetCode's own stub.
//
// Every metaData and stub below is copied verbatim from the GraphQL question for that
// slug. [VERIFIED 2026-07-28]

import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePythonStub, pythonType, leetType, stubAgreesWithMeta } from './stub.mjs';
import { classifyProblem } from './meta.mjs';

test('the stub signature is read off the def line, past the commented-out node class', () => {
  const stub = parsePythonStub(
    '# Definition for singly-linked list.\n'
    + '# class ListNode:\n'
    + '#     def __init__(self, x):\n'
    + '#         self.val = x\n'
    + '\n'
    + 'class Solution:\n'
    + '    def hasCycle(self, head: Optional[ListNode]) -> bool:\n'
    + '        ',
  );
  assert.equal(stub.name, 'hasCycle', 'the commented __init__ must not be mistaken for the method');
  assert.deepEqual(stub.params, [{ name: 'head', type: 'Optional[ListNode]' }]);
  assert.equal(stub.returnType, 'bool');
});

test('the two type vocabularies line up where they mean the same thing', () => {
  // Python has no char, so LeetCode's character[] is annotated List[str] everywhere.
  assert.deepEqual(leetType('character[][]'), pythonType('List[List[str]]'));
  assert.deepEqual(leetType('integer'), pythonType('int'));
  assert.deepEqual(leetType('list<integer>'), pythonType('List[int]'));
  assert.deepEqual(leetType('ListNode'), pythonType("Optional[ListNode]"));
  assert.deepEqual(leetType('TreeNode'), pythonType("'TreeNode'"));
  // ...and not where they do not.
  assert.notDeepEqual(leetType('ListNode'), pythonType("'Optional[Node]'"));
  assert.notDeepEqual(leetType('integer'), pythonType("'TreeNode'"));
  assert.notDeepEqual(leetType('integer[]'), pythonType('int'));
});

// --- the real ones -------------------------------------------------------------------

const NUMBER_OF_ISLANDS = {
  meta: {
    name: 'numIslands',
    params: [{ name: 'grid', type: 'character[][]' }],
    return: { type: 'integer' },
    manual: true,
  },
  stub: 'class Solution:\n    def numIslands(self, grid: List[List[str]]) -> int:\n        ',
};

const LINKED_LIST_CYCLE = {
  meta: {
    name: 'hasCycle',
    params: [{ name: 'head', type: 'ListNode' }, { name: 'pos', type: 'integer' }],
    return: { type: 'boolean' },
    manual: true,
  },
  stub: 'class Solution:\n    def hasCycle(self, head: Optional[ListNode]) -> bool:\n        ',
};

test('number-of-islands is `manual` and still runnable — metaData and the stub agree', () => {
  assert.equal(stubAgreesWithMeta(NUMBER_OF_ISLANDS.meta, NUMBER_OF_ISLANDS.stub).agrees, true);
  const shape = classifyProblem(NUMBER_OF_ISLANDS.meta, { pythonStub: NUMBER_OF_ISLANDS.stub });
  assert.equal(shape.kind, 'function', 'refusing this costs one of the most-practised problems for nothing');
});

test('linked-list-cycle is refused, and says which argument does not exist', () => {
  // metaData is (head, pos) because the judge ties the tail to node `pos`. The function
  // you write takes head alone. Running the printed example would call hasCycle twice on
  // fabricated input.
  const verdict = stubAgreesWithMeta(LINKED_LIST_CYCLE.meta, LINKED_LIST_CYCLE.stub);
  assert.equal(verdict.agrees, false);
  assert.match(verdict.why, /2 value\(s\) per case but your function takes 1/);
  assert.equal(classifyProblem(LINKED_LIST_CYCLE.meta, { pythonStub: LINKED_LIST_CYCLE.stub }).kind, 'unsupported');
});

test('lowest-common-ancestor is refused: the judge passes nodes, the example prints values', () => {
  const verdict = stubAgreesWithMeta(
    {
      name: 'lowestCommonAncestor',
      params: [
        { name: 'root', type: 'TreeNode' },
        { name: 'p', type: 'integer' },
        { name: 'q', type: 'integer' },
      ],
      return: { type: 'TreeNode' },
      manual: true,
    },
    "class Solution:\n    def lowestCommonAncestor(self, root: 'TreeNode', p: 'TreeNode', q: 'TreeNode') -> 'TreeNode':\n        ",
  );
  assert.equal(verdict.agrees, false, 'the names all match — only the types give this away');
  assert.match(verdict.why, /"p" is integer .* and 'TreeNode'/);
});

test('clone-graph is refused: metaData describes the judge\'s adjacency list, not your argument', () => {
  const verdict = stubAgreesWithMeta(
    {
      name: 'cloneGraph',
      params: [{ name: 'edges', type: 'integer[][]' }],
      return: { type: 'boolean' },
      manual: true,
    },
    "class Solution:\n    def cloneGraph(self, node: Optional['Node']) -> Optional['Node']:\n        ",
  );
  assert.equal(verdict.agrees, false);
  assert.match(verdict.why, /"edges" .* "node"/);
});

test('construct-quad-tree is refused on the return type alone', () => {
  const verdict = stubAgreesWithMeta(
    {
      name: 'construct',
      params: [{ name: 'grid', type: 'integer[][]' }],
      return: { type: 'list<list<integer>>' },
      manual: true,
    },
    "class Solution:\n    def construct(self, grid: List[List[int]]) -> 'Node':\n        ",
  );
  assert.equal(verdict.agrees, false, 'the argument matches; what comes back does not');
  assert.match(verdict.why, /returns 'Node'/);
});

test('no stub, or an unannotated one, is a refusal — silence is not agreement', () => {
  assert.equal(stubAgreesWithMeta(NUMBER_OF_ISLANDS.meta, null).agrees, false);
  assert.equal(stubAgreesWithMeta(NUMBER_OF_ISLANDS.meta, '').agrees, false);
  assert.equal(
    stubAgreesWithMeta(NUMBER_OF_ISLANDS.meta, 'class Solution:\n    def numIslands(self, grid):\n        ').agrees,
    false,
  );
  // ...and so classifying without one keeps the problem refused rather than guessing.
  assert.equal(classifyProblem(NUMBER_OF_ISLANDS.meta).kind, 'unsupported');
});

test('the stub is consulted for `manual` problems ONLY', () => {
  // A stub that flatly contradicts metaData must not take away a problem that works today.
  const meta = {
    name: 'twoSum',
    params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
    return: { type: 'integer[]' },
    manual: false,
  };
  const shape = classifyProblem(meta, { pythonStub: 'class Solution:\n    def somethingElse(self) -> None:\n        ' });
  assert.equal(shape.kind, 'function');
});
