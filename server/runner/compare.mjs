// Semantic comparison, per the contract: never assert a failure you cannot justify.
//
// Three honest verdicts, not two:
//   passed: true   — equal, or equal as an unordered collection (a real pass, with a note)
//   passed: false  — the values genuinely differ
//   passed: null   — "differs from expected", shown side by side, because we cannot tell
//                    whether this problem accepts the ordering the user produced
//
// Floats compare with tolerance; LeetCode's own bar is 1e-5.

export const FLOAT_TOLERANCE = 1e-5;

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function numbersClose(a, b, tol) {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= tol || diff <= tol * Math.max(Math.abs(a), Math.abs(b));
}

/** Deep equality with float tolerance. Ints and floats of equal value compare equal. */
export function deepEqual(a, b, tol = FLOAT_TOLERANCE) {
  if (a === b) return true;
  if (isNum(a) && isNum(b)) return numbersClose(a, b, tol);
  if (typeof a === 'boolean' || typeof b === 'boolean') return a === b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) if (!deepEqual(a[i], b[i], tol)) return false;
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i += 1) {
      if (ka[i] !== kb[i]) return false;
      if (!deepEqual(a[ka[i]], b[ka[i]], tol)) return false;
    }
    return true;
  }
  return false;
}

/** A stable key for multiset comparison. Floats are rounded so tolerance survives sorting. */
function canonical(value) {
  if (isNum(value)) {
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function multisetEqual(a, b) {
  if (a.length !== b.length) return false;
  const ka = a.map(canonical).sort();
  const kb = b.map(canonical).sort();
  for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return false;
  return true;
}

function sortInner(list) {
  return list.map((v) => (Array.isArray(v) ? [...v].map(canonical).sort() : canonical(v)));
}

/**
 * @param {object} [opts]
 * @param {'lenient'|'unknown'|'strict'} [opts.order] how much the order of a returned array
 *   is allowed to differ from the expected one.
 *
 *   `strict`  — order IS the answer, so a reordering is a failure. Set for a linked list or
 *               tree (they reach here as arrays, and the leniency below would score a
 *               reverseList that reversed nothing as a pass) and for an in-place array
 *               problem like sortColors, where a solution that did nothing at all leaves
 *               exactly the same items in exactly the wrong order.
 *   `unknown` — some problems in this family accept any order and some do not, and nothing
 *               in metaData says which. Shown side by side as the third verdict rather than
 *               guessed either way.
 *   `lenient` — the default, and the long-standing behaviour for ordinary returns.
 * @returns {{passed:boolean|null, orderInsensitive?:boolean, note?:string}}
 */
export function compareValues(actual, expected, { tol = FLOAT_TOLERANCE, order = 'lenient' } = {}) {
  if (deepEqual(actual, expected, tol)) return { passed: true };

  if (order !== 'strict' && Array.isArray(actual) && Array.isArray(expected)) {
    if (multisetEqual(actual, expected)) {
      if (order === 'unknown') {
        return {
          passed: null,
          note:
            'The same items as expected, in a different order. Some problems of this kind '
            + 'accept any order and some do not, so this is shown rather than judged.',
        };
      }
      return {
        passed: true,
        orderInsensitive: true,
        note: 'Same items as expected, in a different order — this problem accepts any order.',
      };
    }
    const innerA = sortInner(actual);
    const innerB = sortInner(expected);
    if (
      actual.length === expected.length &&
      innerA.map((x) => JSON.stringify(x)).sort().join('|') ===
        innerB.map((x) => JSON.stringify(x)).sort().join('|')
    ) {
      return {
        passed: null,
        note:
          'Differs from expected only by the order of items inside each group. Many problems ' +
          'accept this and some do not, so this is shown rather than judged.',
      };
    }
  }

  return { passed: false };
}

/** Render a value the way LeetCode prints it, for the `actual` field. */
export function formatValue(value) {
  return JSON.stringify(value) ?? 'null';
}
