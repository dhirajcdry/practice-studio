// LeetCode `metaData` — parsing, and deciding what shape of problem we can drive.
//
// metaData comes off the GraphQL question as a JSON *string*. Two shapes matter:
//
//   function problems: { name, params: [{name, type}], return: { type } }
//   design problems:   { classname, constructor: {params:[...]}, methods: [{name, params, return}] }
//
// Anything we cannot honestly drive is reported as `unsupported`, never guessed at.
// Faking a pass is the one failure this module refuses to have.

import { adapterFor } from './adapters.mjs';
import { stubAgreesWithMeta } from './stub.mjs';

/** Accepts the raw string LeetCode sends, or an already-parsed object. Never throws. */
export function parseMetaData(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The node classes LeetCode defines in every language stub. We can build these from the
 * same JSON array LeetCode prints, and turn them back into one, so they are supported the
 * same way a list of integers is.
 *
 * `Node` is deliberately NOT here. Three different problem families use that one name — a
 * graph node with `neighbors`, an n-ary tree node with `children`, and a list node with a
 * `random` pointer — and metaData does not say which. Guessing would mean building the
 * wrong object and reporting a verdict we cannot justify.
 */
const SUPPORTED_NODES = new Set(['listnode', 'treenode']);

const SUPPORTED_SCALARS = new Set([
  'integer',
  'long',
  'double',
  'float',
  'boolean',
  'string',
  'character',
  'char',
  'void',
  'null',
]);

/**
 * Strip the container syntax off a LeetCode type name.
 * `list<list<integer>>` -> `integer`, `integer[][]` -> `integer`, `ListNode` -> `listnode`.
 */
export function baseTypeOf(type) {
  if (typeof type !== 'string') return null;
  let t = type.trim().toLowerCase();
  // list<...>, List<...>
  for (let guard = 0; guard < 8; guard += 1) {
    const m = /^list<(.+)>$/.exec(t);
    if (!m) break;
    t = m[1].trim();
  }
  while (t.endsWith('[]')) t = t.slice(0, -2).trim();
  // a nested list<> can hide behind the [] strip
  if (/^list<.+>$/.test(t)) return baseTypeOf(t);
  return t;
}

/** A plain value: numbers, strings, booleans and lists of them. */
export function isSupportedScalarType(type) {
  const base = baseTypeOf(type);
  return base !== null && SUPPORTED_SCALARS.has(base);
}

/** `ListNode`, `TreeNode`, or any nesting of lists of them. */
export function isNodeType(type) {
  const base = baseTypeOf(type);
  return base !== null && SUPPORTED_NODES.has(base);
}

export function isSupportedType(type) {
  return isSupportedScalarType(type) || isNodeType(type);
}

function unsupported(message) {
  return { kind: 'unsupported', message };
}

const SUBMIT_STILL_WORKS =
  'Running locally does not handle this problem type yet — submitting to LeetCode still works.';

/**
 * @param {object} [opts]
 * @param {string|null} [opts.pythonStub] LeetCode's python3 code snippet. Consulted only
 *   for `manual` problems, to decide whether the printed input really is the argument list.
 * @param {string|null} [opts.slug] the problem, so a `manual` problem with a known recipe
 *   (adapters.mjs) can be driven instead of refused.
 * @returns {{kind:'function', name, params, returnType}
 *          |{kind:'design', classname, ctorParams, methods}
 *          |{kind:'unsupported', message}}
 */
export function classifyProblem(meta, { pythonStub = null, slug = null } = {}) {
  if (!meta || typeof meta !== 'object') {
    return unsupported(
      `This problem did not come with the function signature the local runner needs. ${SUBMIT_STILL_WORKS}`,
    );
  }

  if (typeof meta.classname === 'string' && meta.classname !== '') {
    return classifyDesign(meta);
  }

  // LeetCode marks a problem `manual` when its judge does something to the printed input
  // before calling you. Sometimes that changes the arguments completely — Linked List
  // Cycle's metaData is (head, pos) while the function you write takes only head — and
  // running it as written would report a verdict that means nothing.
  //
  // But sometimes it changes nothing we can see: number-of-islands is `manual` and its
  // metaData matches its stub exactly. Refusing that costs one of the most-practised
  // problems on the list for no reason.
  //
  // Which it is, is not a judgement call. Both metaData and the Python stub come from
  // LeetCode, and either they describe the same call or they do not. Without a stub to
  // check against we refuse, because "nothing contradicted us" is not agreement.
  // A recipe for exactly this problem, matched against a fingerprint of the metaData it
  // was written for. See adapters.mjs.
  const adapter = slug ? adapterFor(slug, meta) : null;

  if (meta.manual === true && adapter === null) {
    const verdict = stubAgreesWithMeta(meta, pythonStub);
    if (!verdict.agrees) {
      return unsupported(
        `LeetCode builds this problem's test input by hand — ${verdict.why} — so the local ` +
        `runner cannot reproduce it. ${SUBMIT_STILL_WORKS}`,
      );
    }
  }

  if (typeof meta.name !== 'string' || meta.name === '') {
    return unsupported(
      `This problem did not come with a function name the local runner could use. ${SUBMIT_STILL_WORKS}`,
    );
  }

  const params = Array.isArray(meta.params) ? meta.params : [];
  const returnType = meta?.return?.type ?? 'void';

  for (const p of params) {
    if (!isSupportedType(p?.type)) {
      return unsupported(
        `This problem takes a ${String(p?.type)} argument, which the local runner cannot build yet. ${SUBMIT_STILL_WORKS}`,
      );
    }
  }
  if (!isSupportedType(returnType)) {
    return unsupported(
      `This problem returns a ${String(returnType)}, which the local runner cannot check yet. ${SUBMIT_STILL_WORKS}`,
    );
  }
  // "Modify nums in-place" problems. Which argument holds the answer is not a guess:
  // metaData says so. `output.paramindex` is the argument to read back, and
  // `output.size: "ret"` means only the first N of it count, where N is what you returned
  // (remove-element, remove-duplicates). That is LeetCode's own rule, applied here.
  const outputSpec = meta.output;
  const paramIndex = Number.isInteger(outputSpec?.paramindex) ? outputSpec.paramindex : null;
  const answerFrom =
    paramIndex !== null && paramIndex >= 0 && paramIndex < params.length
      ? { paramIndex, sizeFromReturn: outputSpec?.size === 'ret' }
      : null;

  if (baseTypeOf(returnType) === 'void' && answerFrom === null) {
    return unsupported(
      `This problem is checked by modifying its input in place and did not say which argument ` +
      `holds the answer, so the local runner cannot check it. ${SUBMIT_STILL_WORKS}`,
    );
  }

  return {
    kind: 'function',
    name: meta.name,
    params: params.map((p) => ({ name: String(p?.name ?? ''), type: String(p?.type ?? '') })),
    returnType: String(returnType),
    answerFrom,
    adapter,
  };
}

function classifyDesign(meta) {
  const methods = Array.isArray(meta.methods) ? meta.methods : [];
  if (methods.length === 0) {
    return unsupported(
      `This is a class-design problem and its method list did not come through. ${SUBMIT_STILL_WORKS}`,
    );
  }
  const ctorParams = Array.isArray(meta?.constructor?.params) ? meta.constructor.params : [];

  for (const p of ctorParams) {
    if (!isSupportedScalarType(p?.type)) {
      return unsupported(
        `This class takes a ${String(p?.type)} constructor argument, which the local runner cannot build yet. ${SUBMIT_STILL_WORKS}`,
      );
    }
  }
  for (const m of methods) {
    if (typeof m?.name !== 'string' || m.name === '') {
      return unsupported(`This class-design problem has an unnamed method. ${SUBMIT_STILL_WORKS}`);
    }
    const mParams = Array.isArray(m.params) ? m.params : [];
    for (const p of mParams) {
      if (!isSupportedScalarType(p?.type)) {
        return unsupported(
          `Method ${m.name} takes a ${String(p?.type)} argument, which the local runner cannot build yet. ${SUBMIT_STILL_WORKS}`,
        );
      }
    }
    const rt = m?.return?.type ?? 'void';
    if (!isSupportedScalarType(rt)) {
      return unsupported(
        `Method ${m.name} returns a ${String(rt)}, which the local runner cannot check yet. ${SUBMIT_STILL_WORKS}`,
      );
    }
  }

  return {
    kind: 'design',
    classname: String(meta.classname),
    ctorParams: ctorParams.map((p) => ({ name: String(p?.name ?? ''), type: String(p?.type ?? '') })),
    methods: methods.map((m) => ({
      name: String(m.name),
      paramCount: Array.isArray(m.params) ? m.params.length : 0,
      returnType: String(m?.return?.type ?? 'void'),
    })),
  };
}
