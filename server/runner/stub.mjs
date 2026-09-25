// Reading LeetCode's own Python stub, to settle what `manual` actually means.
//
// `manual: true` in metaData means LeetCode's judge does something to the printed input
// before calling you. Sometimes that something changes the arguments completely:
//
//   linked-list-cycle    metaData: (head: ListNode, pos: integer)   stub: hasCycle(head)
//   lowest-common-...    metaData: (root: TreeNode, p: int, q: int) stub: (root, p: TreeNode, q: TreeNode)
//   clone-graph          metaData: (edges: integer[][]) -> boolean  stub: cloneGraph(node: Node) -> Node
//
// and sometimes it changes nothing we can see:
//
//   number-of-islands    metaData: (grid: character[][]) -> integer stub: numIslands(grid: List[List[str]]) -> int
//
// The first three cannot be run from the printed example. The fourth can, and refusing it
// costs the user one of the most-practised problems on the list for no reason.
//
// The tell is not a judgement call: it is whether metaData and the stub describe the SAME
// call. Both come from LeetCode, both are published per problem, and comparing them is
// mechanical. When they agree the printed input IS the argument list. When they disagree,
// metaData is describing the judge's setup rather than your function, and we refuse.
//
// This is consulted ONLY for `manual` problems. Everything else classifies exactly as it
// did before, so a stub this file cannot parse can never take away a problem that works.

/** `List[List[int]]` -> {base:'integer', depth:2}. Quotes, Optional and unions stripped. */
export function pythonType(raw) {
  let text = String(raw ?? '').trim().replace(/^['"]|['"]$/g, '').trim();
  let depth = 0;
  for (let guard = 0; guard < 16; guard += 1) {
    const before = text;
    text = text.replace(/^Optional\[(.+)\]$/i, '$1').trim();
    // `X | None`, `Union[X, None]`
    text = text.replace(/^Union\[(.+?),\s*None\]$/i, '$1').trim();
    text = text.replace(/\s*\|\s*None$/i, '').trim();
    text = text.replace(/^['"]|['"]$/g, '').trim();
    const listed = /^(?:List|list|Sequence|Iterable)\[(.+)\]$/.exec(text);
    if (listed) {
      text = listed[1].trim();
      depth += 1;
    }
    if (text === before) break;
  }
  return { base: canonical(text), depth };
}

/** LeetCode's own type name, in the same terms. */
export function leetType(raw) {
  const text = String(raw ?? '').trim();
  let depth = 0;
  let rest = text;
  for (let guard = 0; guard < 16; guard += 1) {
    const inner = /^[Ll]ist<(.+)>$/.exec(rest);
    if (inner) { rest = inner[1].trim(); depth += 1; continue; }
    if (rest.endsWith('[]')) { rest = rest.slice(0, -2).trim(); depth += 1; continue; }
    break;
  }
  return { base: canonical(rest), depth };
}

/**
 * One name per family, so the two vocabularies can be compared.
 *
 * `character` collapses into `string` because Python has no char type — LeetCode's
 * `character[]` is annotated `List[str]` in every stub, and treating that as a
 * disagreement would refuse reverse-string and every grid problem.
 */
function canonical(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (['int', 'integer', 'long'].includes(t)) return 'integer';
  if (['float', 'double'].includes(t)) return 'double';
  if (['str', 'string', 'char', 'character'].includes(t)) return 'string';
  if (['bool', 'boolean'].includes(t)) return 'boolean';
  if (['none', 'nonetype', 'void'].includes(t)) return 'void';
  return t;
}

/**
 * The signature LeetCode's python3 stub declares.
 * @returns {{name:string, params:Array<{name:string,type:string}>, returnType:string}|null}
 */
export function parsePythonStub(code) {
  if (typeof code !== 'string' || code.trim() === '') return null;
  for (const line of code.split('\n')) {
    if (/^\s*#/.test(line)) continue;                       // the commented-out node classes
    const m = /^\s+def\s+(\w+)\s*\(\s*self\s*,?([^)]*)\)\s*(?:->\s*(.+?))?\s*:/.exec(line);
    if (!m) continue;
    if (m[1] === '__init__') continue;
    const params = (m[2] ?? '')
      .split(',')
      .map((piece) => piece.trim())
      .filter((piece) => piece !== '')
      .map((piece) => {
        const [head, ...typeParts] = piece.split(':');
        const type = typeParts.join(':').split('=')[0].trim();
        return { name: head.split('=')[0].trim(), type };
      });
    return { name: m[1], params, returnType: (m[3] ?? '').trim() };
  }
  return null;
}

const same = (a, b) => a.base === b.base && a.depth === b.depth;

/**
 * Do metaData and the stub describe the same call?
 *
 * Everything must line up: the method name, the parameter names in order, every parameter
 * type, and the return type. A single disagreement means metaData is describing the
 * judge's setup rather than the function you write, and the printed example cannot be
 * used as an argument list.
 *
 * Missing information is a disagreement. An unannotated stub says nothing, and "it did not
 * contradict us" is not the same as "it agreed".
 *
 * @returns {{agrees:boolean, why:string}}
 */
export function stubAgreesWithMeta(meta, stubCode) {
  const stub = parsePythonStub(stubCode);
  if (!stub) return { agrees: false, why: 'the Python stub for this problem could not be read' };
  if (stub.name !== meta?.name) {
    return { agrees: false, why: `the judge calls ${meta?.name} and the stub defines ${stub.name}` };
  }

  const metaParams = Array.isArray(meta.params) ? meta.params : [];
  if (metaParams.length !== stub.params.length) {
    return {
      agrees: false,
      why: `the test input has ${metaParams.length} value(s) per case but your function takes ${stub.params.length}`,
    };
  }
  for (const [i, p] of metaParams.entries()) {
    const s = stub.params[i];
    if (p?.name !== s.name) {
      return { agrees: false, why: `argument ${i + 1} is "${p?.name}" in the test input and "${s.name}" in your function` };
    }
    if (s.type === '') return { agrees: false, why: `argument "${s.name}" has no type in the stub` };
    if (!same(leetType(p?.type), pythonType(s.type))) {
      return { agrees: false, why: `"${s.name}" is ${p?.type} in the test input and ${s.type} in your function` };
    }
  }

  if (stub.returnType === '') return { agrees: false, why: 'the stub does not say what the function returns' };
  if (!same(leetType(meta?.return?.type ?? 'void'), pythonType(stub.returnType))) {
    return {
      agrees: false,
      why: `the judge expects ${meta?.return?.type} back and your function returns ${stub.returnType}`,
    };
  }
  return { agrees: true, why: '' };
}
