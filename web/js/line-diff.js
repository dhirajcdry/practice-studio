// Hirschberg's LCS keeps memory linear even for a long saved solution.
function lengths(a, b) {
  let row = new Uint32Array(b.length + 1);
  for (const line of a) {
    const next = new Uint32Array(b.length + 1);
    for (let j = 0; j < b.length; j++) next[j + 1] = line === b[j] ? row[j] + 1 : Math.max(row[j + 1], next[j]);
    row = next;
  }
  return row;
}
function lcs(a, b) {
  if (!a.length || !b.length) return [];
  if (a.length === 1) return b.includes(a[0]) ? a : [];
  const mid = Math.floor(a.length / 2);
  const left = lengths(a.slice(0, mid), b);
  const right = lengths(a.slice(mid).reverse(), [...b].reverse());
  let split = 0;
  for (let j = 1; j <= b.length; j++) {
    if (left[j] + right[b.length - j] > left[split] + right[b.length - split]) split = j;
  }
  return [...lcs(a.slice(0, mid), b.slice(0, split)), ...lcs(a.slice(mid), b.slice(split))];
}
export function lineDiff(before, after) {
  const a = before === '' ? [] : String(before).split('\n');
  const b = after === '' ? [] : String(after).split('\n');
  const out = [];
  let i = 0;
  let j = 0;
  for (const text of lcs(a, b)) {
    while (a[i] !== text) out.push({ type: 'removed', text: a[i++] });
    while (b[j] !== text) out.push({ type: 'added', text: b[j++] });
    out.push({ type: 'same', text });
    i++;
    j++;
  }
  while (i < a.length) out.push({ type: 'removed', text: a[i++] });
  while (j < b.length) out.push({ type: 'added', text: b[j++] });
  return out;
}
