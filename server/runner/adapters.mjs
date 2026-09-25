// The problems whose printed example is not their argument list.
//
// Most problems are driven straight from metaData: the lines are the arguments, the return
// value is the answer. A handful are not, because LeetCode's judge does setup of its own
// first — it ties a list's tail into a cycle, it hands your function an API object instead
// of an array, it defines a `guess()` you are supposed to call. metaData describes the
// TEST INPUT for those, not the call, which is why `manual: true` is on all of them.
//
// Each entry below says how to get from the one to the other. That is per-problem
// knowledge, and per-problem knowledge rots: if LeetCode reshapes a problem, a recipe
// written for the old shape would quietly run the wrong thing and report a verdict. So
// every entry carries a fingerprint of the metaData it was written against, checked on
// every run. A problem that no longer matches is refused, exactly as it was before this
// file existed — never adapted on a guess.
//
// Everything here is derived from LeetCode's own published data for that problem, checked
// against it on 2026-07-28: the metaData, the python3 stub, `exampleTestcases`, and the
// Output lines in the description. Nothing is from memory.

/**
 * `params` is written the way metaData spells it — "name:type,name:type" — so an entry can
 * be read against the real metaData without decoding anything.
 */
const ENTRIES = [
  {
    slugs: ['linked-list-cycle'],
    driver: 'cycle-list',
    fingerprint: { name: 'hasCycle', params: 'head:ListNode,pos:integer', returns: 'boolean' },
    order: 'strict',
    // [VERIFIED 2026-07-28] exampleTestcases "[3,2,0,-4]\n1\n[1,2]\n0\n[1]\n-1", Outputs true/true/false
    why: 'the second line is the index the tail is tied back to, which your function never sees',
  },
  {
    slugs: ['linked-list-cycle-ii'],
    driver: 'cycle-list',
    fingerprint: { name: 'detectCycle', params: 'head:ListNode,pos:integer', returns: 'ListNode' },
    answer: 'node-index',
    expected: 'cycle-index',
    order: 'strict',
    // [VERIFIED 2026-07-28] Outputs "tail connects to node index 1" / "no cycle"
    why: 'the second line is the index the tail is tied back to, and the answer is printed as that index',
  },
  {
    slugs: ['guess-number-higher-or-lower'],
    driver: 'guess-number',
    fingerprint: { name: 'guessNumber', params: 'n:integer,pick:integer', returns: 'integer' },
    order: 'strict',
    // [VERIFIED 2026-07-28] metaData ships the judge's own guess():
    //   if (num == pick) return 0; return (num > pick) ? -1 : 1;
    why: 'the second line is the number to find, which reaches your function through guess() rather than as an argument',
  },
  {
    slugs: ['copy-list-with-random-pointer'],
    driver: 'random-list',
    fingerprint: { name: 'copyRandomList', params: 'head:ListNode', returns: 'ListNode' },
    order: 'strict',
    // [VERIFIED 2026-07-28] "[[7,null],[13,0],[11,4],[10,2],[1,0]]" in and out
    why: 'each entry is [value, index the random pointer goes to], and the node class has a `random` field metaData does not mention',
  },
  {
    slugs: ['clone-graph'],
    driver: 'graph',
    fingerprint: { name: 'cloneGraph', params: 'edges:integer[][]', returns: 'boolean' },
    order: 'strict',
    // [VERIFIED 2026-07-28] "[[2,4],[1,3],[2,4],[1,3]]" in and out; "[[]]" is one lone node
    why: 'the input is an adjacency list the judge turns into nodes, and your function is handed the first node',
  },
  {
    slugs: ['construct-quad-tree'],
    driver: 'quad-tree',
    fingerprint: { name: 'construct', params: 'grid:integer[][]', returns: 'list<list<integer>>' },
    expected: 'quad-tree',
    order: 'strict',
    // [VERIFIED 2026-07-28] [[0,1],[1,0]] -> [[0,1],[1,0],[1,1],[1,1],[1,0]]
    why: 'the answer is a quad tree, printed level-order as [isLeaf, val] with four slots per node',
  },
  {
    slugs: [
      'lowest-common-ancestor-of-a-binary-search-tree',
      'lowest-common-ancestor-of-a-binary-tree',
    ],
    driver: 'lca',
    fingerprint: { name: 'lowestCommonAncestor', params: 'root:TreeNode,p:integer,q:integer', returns: 'TreeNode' },
    answer: 'node-value',
    order: 'strict',
    // [VERIFIED 2026-07-28] "[6,2,8,0,4,7,9,null,null,3,5]\n2\n8" -> Output 6
    why: 'the two lines after the tree are values, and the judge looks up those nodes before calling you',
  },
  {
    slugs: ['find-in-mountain-array'],
    driver: 'mountain-array',
    fingerprint: { name: 'findInMountainArray', params: 'mountainArr:integer[],target:integer', returns: 'integer' },
    order: 'strict',
    // [VERIFIED 2026-07-28] metaData ships the judge's MountainArray, including its 100-call budget
    why: 'your function is handed a MountainArray object, not the array, and takes it second rather than first',
  },
  {
    slugs: ['serialize-and-deserialize-binary-tree'],
    driver: 'codec-tree',
    target: 'Codec',
    methods: ['serialize', 'deserialize'],
    fingerprint: { name: 'Codec', params: 'root:TreeNode', returns: 'string' },
    order: 'strict',
    // [VERIFIED 2026-07-28] the stub's own footer: ser = Codec(); deser = Codec();
    //                       ans = deser.deserialize(ser.serialize(root))
    why: 'the answer is the tree that survives a round trip through your own two methods',
  },
  {
    slugs: ['encode-and-decode-strings'],
    driver: 'codec-strings',
    target: 'Codec',
    methods: ['encode', 'decode'],
    fingerprint: { name: 'encode', params: 'dummy_input:list<string>', returns: 'list<string>' },
    expected: 'echo-input',
    order: 'strict',
    // [VERIFIED 2026-07-28] LeetCode serves no description or stub for this one (it is
    // premium), so there is nothing to scrape. There is also nothing to scrape FOR: the
    // answer to a round trip is defined to be what went in.
    why: 'the answer is the list that survives a round trip through your own two methods',
  },
  {
    slugs: ['intersection-of-two-linked-lists'],
    driver: 'intersection',
    fingerprint: {
      name: 'getIntersectionNode',
      params: 'intersectVal:integer,listA:ListNode,listB:ListNode,skipA:integer,skipB:integer',
      returns: 'ListNode',
    },
    answer: 'node-value',
    expected: 'intersection-value',
    order: 'strict',
    // [VERIFIED 2026-07-28] Outputs "Intersected at '8'" / "No intersection"
    why: 'the five lines describe how the judge splices the two lists together; your function takes only the two heads',
  },
];

const BY_SLUG = new Map();
for (const entry of ENTRIES) for (const slug of entry.slugs) BY_SLUG.set(slug, entry);

/** How metaData spells this problem's parameters, for comparison with a fingerprint. */
export function paramSignature(meta) {
  return (Array.isArray(meta?.params) ? meta.params : [])
    .map((p) => `${p?.name}:${p?.type}`)
    .join(',');
}

/**
 * The adapter for this problem, or null.
 *
 * @returns {{driver:string, target:string|null, methods:string[]|null,
 *            answer:string|null, expected:string|null, order:string, why:string}|null}
 */
export function adapterFor(slug, meta) {
  const entry = BY_SLUG.get(slug);
  if (!entry) return null;
  // The fingerprint is the whole safety of this file. A problem whose metaData has moved
  // is not this problem any more, and running someone else's recipe against it would
  // produce a verdict with nothing behind it.
  if (meta?.name !== entry.fingerprint.name) return null;
  if (paramSignature(meta) !== entry.fingerprint.params) return null;
  if ((meta?.return?.type ?? 'void') !== entry.fingerprint.returns) return null;
  return {
    driver: entry.driver,
    // The class the solution lives in, and the methods it must define, when they are not
    // `Solution` and the metaData name.
    target: entry.target ?? null,
    methods: entry.methods ?? null,
    answer: entry.answer ?? null,
    expected: entry.expected ?? null,
    order: entry.order,
    why: entry.why,
  };
}

/** Every slug this file knows a recipe for. Used by the tests and the coverage audit. */
export function adaptedSlugs() {
  return [...BY_SLUG.keys()].sort();
}

/**
 * The expected answer, for the adapters whose description prints it as a sentence.
 *
 * @returns {{ok:true, value:any}|{ok:false}}
 */
export function adaptedExpected(rule, raw, caseValues) {
  if (rule === 'echo-input') {
    // A round trip's answer is what went in. Nothing is scraped because nothing is
    // published — and nothing needs to be.
    return Array.isArray(caseValues) && caseValues.length > 0
      ? { ok: true, value: caseValues[0] }
      : { ok: false };
  }
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return { ok: false };

  if (rule === 'cycle-index') {
    // "tail connects to node index 1"  |  "no cycle"
    const m = /node\s+index\s+(-?\d+)/i.exec(text);
    if (m) return { ok: true, value: Number(m[1]) };
    if (/no\s+cycle/i.test(text)) return { ok: true, value: null };
    return { ok: false };
  }

  if (rule === 'intersection-value') {
    // "Intersected at '8'"  |  "No intersection"
    const m = /intersected\s+at\s+'?(-?\d+)'?/i.exec(text);
    if (m) return { ok: true, value: Number(m[1]) };
    if (/no\s+intersection/i.test(text)) return { ok: true, value: null };
    return { ok: false };
  }

  if (rule === 'quad-tree') {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false };
    }
    return Array.isArray(parsed) ? { ok: true, value: normaliseQuadTree(parsed) } : { ok: false };
  }

  return { ok: false };
}

/**
 * A quad tree node that is not a leaf has no meaningful value — the statement says so
 * outright ("you can assign either value to it and it wont affect the result"). So the
 * non-leaf values are flattened on both sides before comparing, or a correct answer that
 * happened to write False where LeetCode wrote True would be reported as wrong.
 */
export function normaliseQuadTree(list) {
  if (!Array.isArray(list)) return list;
  return list.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return entry;
    const isLeaf = entry[0] ? 1 : 0;
    return [isLeaf, isLeaf ? (entry[1] ? 1 : 0) : 1];
  });
}
