// A line diff, in about eighty lines, because pulling in a diff library for this would be
// a supply-chain question on a machine that holds a session cookie.
//
// Classic Myers-style LCS over lines. Solution files are hundreds of lines at most, so the
// O(n*m) table is irrelevant here — but it is still capped, and past the cap we say so
// plainly rather than either hanging or pretending there was no change.

const MAX_CELLS = 4_000_000; // ~2000x2000 lines

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const table = new Uint32Array((n + 1) * (m + 1));
  const w = m + 1;
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + (j + 1)] + 1
          : Math.max(table[(i + 1) * w + j], table[i * w + (j + 1)]);
    }
  }
  return { table, w };
}

/**
 * @param {string} before
 * @param {string} after
 * @returns {{ ops: Array<{ kind: ' '|'+'|'-', line: string }>, added: number, removed: number, truncated: boolean }}
 */
export function diffLines(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');

  if ((a.length + 1) * (b.length + 1) > MAX_CELLS) {
    return { ops: [], added: b.length, removed: a.length, truncated: true };
  }

  const { table, w } = lcsTable(a, b);
  const ops = [];
  let i = 0;
  let j = 0;
  let added = 0;
  let removed = 0;

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ kind: ' ', line: a[i] });
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j] >= table[i * w + (j + 1)]) {
      ops.push({ kind: '-', line: a[i] });
      removed += 1;
      i += 1;
    } else {
      ops.push({ kind: '+', line: b[j] });
      added += 1;
      j += 1;
    }
  }
  while (i < a.length) {
    ops.push({ kind: '-', line: a[i] });
    removed += 1;
    i += 1;
  }
  while (j < b.length) {
    ops.push({ kind: '+', line: b[j] });
    added += 1;
    j += 1;
  }

  return { ops, added, removed, truncated: false };
}

/**
 * Render a diff with `context` unchanged lines around each change, eliding the rest.
 * Returns null when nothing changed, so callers can say "unchanged" rather than printing
 * an empty block the model has to interpret.
 */
export function unifiedDiff(before, after, { context = 3 } = {}) {
  const { ops, added, removed, truncated } = diffLines(before, after);
  if (truncated) {
    return { text: '(the file changed too much to diff usefully)', added, removed, truncated };
  }
  if (added === 0 && removed === 0) return null;

  const keep = new Array(ops.length).fill(false);
  for (let k = 0; k < ops.length; k += 1) {
    if (ops[k].kind === ' ') continue;
    for (let d = -context; d <= context; d += 1) {
      const idx = k + d;
      if (idx >= 0 && idx < ops.length) keep[idx] = true;
    }
  }

  const out = [];
  let eliding = false;
  for (let k = 0; k < ops.length; k += 1) {
    if (keep[k]) {
      out.push(`${ops[k].kind}${ops[k].line}`);
      eliding = false;
    } else if (!eliding) {
      out.push('@@ ...');
      eliding = true;
    }
  }

  return { text: out.join('\n'), added, removed, truncated: false };
}
