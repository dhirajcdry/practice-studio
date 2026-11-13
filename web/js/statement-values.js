// How an example's value is laid out. Pure text in, pure text out. The comma between two
// parameters becomes a line break and a long grid gets a line per row; no character of any
// value is added, removed or changed.

/** Walk `text`, calling `visit(index, depth)` for each character outside a string literal. */
function scan(text, visit) {
  let depth = 0, quote = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{' || ch === '(') depth++;
    visit(i, depth, ch);
    if (ch === ']' || ch === '}' || ch === ')') depth--;
  }
}

/** `a = [1,2], b = 3` becomes one parameter per line. A lone value is returned unchanged. */
export function splitParameters(text) {
  const cuts = [];
  scan(text, (i, depth, ch) => {
    if (ch === ',' && depth === 0 && /^\s*[A-Za-z_]\w*\s*=(?!=)/.test(text.slice(i + 1))) cuts.push(i);
  });
  if (!cuts.length || !/^\s*[A-Za-z_]\w*\s*=(?!=)/.test(text)) return [text];
  const parts = [];
  let from = 0;
  for (const cut of cuts) { parts.push(text.slice(from, cut).trim()); from = cut + 1; }
  parts.push(text.slice(from).trim());
  return parts;
}

/** A list of lists longer than `limit` characters gets one inner list per line, aligned. */
export function stackRows(text, limit = 36) {
  const open = text.indexOf('[[');
  if (open < 0 || text.length <= limit) return text;
  const breaks = [];
  scan(text, (i, depth, ch) => { if (ch === ',' && depth === 1 && i > open && text[i - 1] === ']') breaks.push(i); });
  if (!breaks.length) return text;
  const indent = ' '.repeat(open + 1);
  let out = '', from = 0;
  for (const at of breaks) { out += text.slice(from, at + 1) + '\n' + indent; from = at + 1; while (text[from] === ' ') from++; }
  return out + text.slice(from);
}

/** The layout of one example value: parameters on their own lines, grids stacked by row. */
export function formatValue(text) {
  return splitParameters(String(text)).map(part => stackRows(part)).join('\n');
}
