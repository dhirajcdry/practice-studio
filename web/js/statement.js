// Turns a sanitized LeetCode statement into parts the page can lay out: the description,
// each example as labelled rows, the constraints, and any follow-up.
//
// LeetCode ships a statement as one run of paragraphs where an example is a bold line
// followed by a <pre> (or, in newer problems, a few paragraphs). Shown as it arrives, every
// example is the same grey box of monospace and the reader has to find "Output:" by eye.
// Nothing here invents content: every node is moved from the statement, never rewritten, and
// a statement this cannot read is returned exactly as it came.
import { el } from './dom.js';
import { button } from './ui/button.js';
import { formatValue } from './statement-values.js';

const LABELS = /^(Input|Output|Explanation|Note|Example)\s*:?\s*$/i;
const LINE_LABEL = /^\s*(Input|Output|Explanation|Note)\s*:\s?(.*)$/i;
const text = node => (node.textContent || '').replace(/ /g, ' ').trim();
const isElement = (node, tag) => node.nodeType === 1 && node.tagName === tag;

/** Which part a top-level node opens, if it is a heading line. */
function heading(node) {
  if (!isElement(node, 'P') && !/^H[1-6]$/.test(node.tagName || '')) return null;
  const words = text(node);
  const example = /^Example\s*(\d+)?\s*:?$/i.exec(words);
  if (example) return { kind: 'example', number: example[1] ? Number(example[1]) : null };
  if (/^Constraints\s*:?$/i.test(words)) return { kind: 'constraints' };
  if (/^Follow[\s-]?up\s*:/i.test(words)) return { kind: 'follow' };
  return null;
}

function trimEdges(fragment) {
  const first = fragment.firstChild, last = fragment.lastChild;
  if (first?.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s+/, '');
  if (last?.nodeType === 3) last.nodeValue = last.nodeValue.replace(/\s+$/, '');
  return fragment;
}

/** `<strong>Input:</strong> ...` runs inside one element become [{label, value}]. */
function labelledRows(source) {
  const rows = [];
  let current = null;
  for (const child of [...source.childNodes]) {
    const isLabel = (isElement(child, 'STRONG') || isElement(child, 'B')) && LABELS.test(text(child));
    if (isLabel) {
      current = { label: text(child).replace(/\s*:\s*$/, ''), value: document.createDocumentFragment() };
      rows.push(current);
    } else if (current) current.value.append(child.cloneNode(true));
    else if (text(child)) return []; // content before any label: not a labelled block
  }
  return rows.filter(row => text(row.value) || row.value.querySelector?.('img')).map(row => ({ ...row, value: trimEdges(row.value) }));
}

/** A plain-text block (`Input: ...` on its own lines, no bold) becomes the same rows. */
function lineRows(source) {
  const rows = [];
  for (const line of (source.textContent || '').split('\n')) {
    const hit = LINE_LABEL.exec(line);
    if (hit) rows.push({ label: hit[1][0].toUpperCase() + hit[1].slice(1).toLowerCase(), lines: [hit[2]] });
    else if (rows.length && line.trim()) rows.at(-1).lines.push(line.trim());
    else if (line.trim()) return [];
  }
  return rows.map(row => ({ label: row.label, value: document.createTextNode(row.lines.join('\n').trim()) }));
}

function exampleRows(nodes) {
  const rows = [], extras = [];
  // LeetCode sometimes writes "Explanation:" on a line of its own and lets a picture be the
  // explanation. The label then belongs to the picture that follows it, not to nothing.
  let openLabel = null;
  for (const node of nodes) {
    if (node.nodeType !== 1) continue;
    const isFigure = node.tagName === 'IMG' || (node.tagName === 'P' && node.querySelector('img') && !text(node));
    if (isFigure && openLabel) { rows.push({ label: openLabel, value: node, figure: true }); openLabel = null; continue; }
    if (isFigure) { extras.push({ figure: node }); continue; }
    openLabel = null;
    if (node.tagName === 'P' && LABELS.test(text(node)) && node.querySelector('strong, b')) { openLabel = text(node).replace(/\s*:\s*$/, ''); continue; }
    const found = labelledRows(node);
    if (found.length) { rows.push(...found); continue; }
    const lines = node.tagName === 'PRE' ? lineRows(node) : [];
    if (lines.length) rows.push(...lines);
    else extras.push({ raw: node });
  }
  return { rows, extras };
}

/** A value that is plain text is laid out (parameters per line, grids by row); marked-up values are left as they are. */
function laidOut(row) {
  if (row.figure || /^(Explanation|Note)$/i.test(row.label)) return row.value;
  const plain = row.value.nodeType === 3 || (row.value.childNodes && [...row.value.childNodes].every(node => node.nodeType === 3));
  return plain ? document.createTextNode(formatValue(row.value.textContent)) : row.value;
}

function exampleCard(example, index, onTry) {
  const { rows, extras } = exampleRows(example.nodes);
  const number = example.number ?? index + 1;
  const tryIt = onTry && onTry.available(number) ? button({ label: 'Open as test case', variant: 'quiet', className: 'ex-try', onClick: () => onTry.open(number) }) : null;
  return el('section', { class: 'stmt-example', dataset: { example: String(number) } }, [
    el('header', { class: 'ex-head' }, [el('strong', { text: `Example ${number}` }), tryIt]),
    el('div', { class: 'ex-body' }, [
    ...extras.filter(extra => extra.figure).map(extra => el('div', { class: 'ex-figure' }, extra.figure)),
    rows.length ? el('div', { class: 'ex-rows' }, rows.map(row => el('div', { class: 'ex-row' }, [
      el('span', { class: 'ex-label', text: row.label }),
      el('div', { class: 'ex-value' + (row.figure ? ' is-figure' : /^(Explanation|Note)$/i.test(row.label) ? ' is-prose' : '') }, laidOut(row)),
    ]))) : null,
    ]),
    ...extras.filter(extra => extra.raw).map(extra => el('div', { class: 'ex-raw rich' }, extra.raw)),
  ]);
}

/**
 * @param {HTMLElement} rich  the sanitized statement
 * @param {{ onTryExample?: { available: (number: number) => boolean, open: (number: number) => void } }} [options]
 *   `available` says whether example N exists as a test case; only those get the button.
 * @returns {HTMLElement} the structured statement, or `rich` itself when it has no examples to structure
 */
export function structureStatement(rich, { onTryExample = null } = {}) {
  const lead = [], examples = [], constraints = [], follow = [];
  let bucket = lead;
  for (const node of [...rich.childNodes]) {
    if (node.nodeType === 3 && !node.nodeValue.trim()) continue;
    const opens = node.nodeType === 1 ? heading(node) : null;
    if (opens?.kind === 'example') { examples.push({ number: opens.number, nodes: [] }); bucket = examples.at(-1).nodes; continue; }
    if (opens?.kind === 'constraints') { bucket = constraints; continue; }
    if (opens?.kind === 'follow') { bucket = follow; }
    bucket.push(node);
  }
  if (!examples.length || examples.some(example => !example.nodes.length)) return rich;

  // "Follow up:" keeps its sentence; only the bold label is replaced by the section's own.
  const followLabel = follow[0]?.querySelector?.('strong, b');
  if (followLabel && /^Follow[\s-]?up\s*:?$/i.test(text(followLabel))) followLabel.remove();

  return el('div', { class: 'stmt' }, [
    el('div', { class: 'stmt-lead rich' }, lead),
    el('div', { class: 'stmt-examples' }, [
      el('h3', { class: 'stmt-h', text: examples.length === 1 ? 'Example' : 'Examples' }),
      ...examples.map((example, index) => exampleCard(example, index, onTryExample)),
    ]),
    constraints.length || follow.length ? el('div', { class: 'stmt-rest' }, [
      constraints.length ? el('section', { class: 'stmt-constraints rich' }, [el('h3', { class: 'stmt-h', text: 'Constraints' }), ...constraints]) : null,
      follow.length ? el('aside', { class: 'stmt-follow rich' }, [el('h3', { class: 'stmt-h', text: 'Follow-up' }), ...follow]) : null,
    ]) : null,
  ]);
}
