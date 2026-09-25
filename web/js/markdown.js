// Escape-by-default markdown renderer for third-party article text.
//
// It builds DOM nodes directly and never assigns innerHTML, so raw HTML inside the
// markdown is rendered as literal text (escaped), exactly as the contract requires.
// Supported: headings, fenced code, lists, blockquotes, rules, pipe tables,
// paragraphs, and inline code/bold/italic/links (https only).
//
// The NeetCode articles also use `::tabs-start` / `::tabs-end` around one code block
// per language. Phase 1 is Python-only, so inside a tabs region we keep the Python
// block and drop the other twelve rather than printing the directive verbatim.

import { el } from './dom.js';
import { safeUrl } from './sanitize.js';
import { highlightPython } from './highlight.js';

// Built fresh on every call: `inline` recurses, and a shared /g regex would have its
// lastIndex reset by the inner call, restarting the outer scan forever.
const INLINE_SOURCE = /(`+)([\s\S]+?)\1|\*\*([\s\S]+?)\*\*|__([\s\S]+?)__|\*([^*\n]+?)\*|_([^_\n]+?)_|\[([^\]\n]*)\]\(([^)\s]+)\)|\$([^$\n]{1,80})\$/.source;

// Purely decorative inline tags the articles sprinkle through their prose. They are
// DELETED, never rendered — dropping a tag is not "passing HTML through", and the
// alternative is a paragraph full of literal `<a href="...">` noise. Anything not on
// this list (script, img, iframe, style, …) is left alone and therefore escaped.
const BENIGN_TAGS = /<\/?(?:a|b|i|u|em|strong|small|sup|sub|span|div|p|br|center|font)(?:\s[^<>]*)?\/?>/gi;

/** Parse inline markdown into an array of text nodes and elements. */
export function inline(raw) {
  const text = String(raw);
  // Decorative tags are removed from prose only — never from inside a code span,
  // where `<b>` is the thing the author is literally writing about.
  const prose = s => document.createTextNode(s.replace(BENIGN_TAGS, ''));
  const out = [];
  const pattern = new RegExp(INLINE_SOURCE, 'g');
  let last = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0] === '') { pattern.lastIndex++; continue; }
    if (match.index > last) out.push(prose(text.slice(last, match.index)));
    last = match.index + match[0].length;
    if (match[9] !== undefined) out.push(el('code', { text: match[9].trim() })); // $math$
    else if (match[2] !== undefined) out.push(el('code', { text: match[2].trim() }));
    else if (match[3] !== undefined) out.push(el('strong', {}, inline(match[3])));
    else if (match[4] !== undefined) out.push(el('strong', {}, inline(match[4])));
    else if (match[5] !== undefined) out.push(el('em', {}, inline(match[5])));
    else if (match[6] !== undefined) out.push(el('em', {}, inline(match[6])));
    else {
      const href = safeUrl(match[8]);
      const label = match[7] || match[8];
      out.push(href
        ? el('a', { href, rel: 'noopener noreferrer nofollow', target: '_blank' }, inline(label))
        : prose(label));
    }
  }
  if (last < text.length) out.push(prose(text.slice(last)));
  return out;
}

export function codeBlock(code, language) {
  const pre = el('pre');
  const node = el('code');
  if ((language || '').toLowerCase() === 'python') node.append(highlightPython(code));
  else node.textContent = code;
  pre.append(node);
  return pre;
}

function listBlock(items, ordered) {
  const list = el(ordered ? 'ol' : 'ul');
  for (const item of items) {
    const li = el('li', {}, inline(item.text));
    if (item.children.length) li.append(listBlock(item.children, item.childrenOrdered));
    list.append(li);
  }
  return list;
}

/** Collect a run of list lines (with one level of nesting) starting at `i`. */
function readList(lines, i) {
  const items = [];
  const marker = /^(\s*)(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
  const first = marker.exec(lines[i]);
  const baseIndent = first[1].length;
  const ordered = first[3] !== undefined;
  while (i < lines.length) {
    const m = marker.exec(lines[i]);
    if (!m) {
      // A blank line inside a list is tolerated only if a list line follows.
      if (lines[i].trim() === '' && marker.test(lines[i + 1] || '')) { i++; continue; }
      break;
    }
    const indent = m[1].length;
    const text = m[4];
    if (indent > baseIndent && items.length) {
      const parent = items[items.length - 1];
      parent.childrenOrdered = m[3] !== undefined;
      parent.children.push({ text, children: [], childrenOrdered: false });
    } else if (indent < baseIndent) {
      break;
    } else {
      items.push({ text, children: [], childrenOrdered: false });
    }
    i++;
  }
  return { node: listBlock(items, ordered), next: i };
}

function tableBlock(lines, i) {
  const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
  const table = el('table');
  const head = el('thead');
  const headRow = el('tr');
  for (const c of cells(lines[i])) headRow.append(el('th', {}, inline(c)));
  head.append(headRow);
  table.append(head);
  const body = el('tbody');
  let j = i + 2;
  for (; j < lines.length && lines[j].includes('|') && lines[j].trim() !== ''; j++) {
    const tr = el('tr');
    for (const c of cells(lines[j])) tr.append(el('td', {}, inline(c)));
    body.append(tr);
  }
  table.append(body);
  return { node: table, next: j };
}

const isTableHead = (line, next) =>
  line.includes('|') && /^[\s|:-]+$/.test(next || '') && (next || '').includes('-');

/**
 * @param {string} markdown untrusted markdown
 * @returns {DocumentFragment}
 */
export function renderMarkdown(markdown) {
  const out = document.createDocumentFragment();
  if (typeof markdown !== 'string' || markdown.trim() === '') return out;

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let inTabs = false;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') { i++; continue; }

    if (trimmed === '::tabs-start') { inTabs = true; i++; continue; }
    if (trimmed === '::tabs-end') { inTabs = false; i++; continue; }

    // A line that is nothing but decorative tags (usually a bare <br>) is spacing.
    if (trimmed.replace(BENIGN_TAGS, '').trim() === '' && /^</.test(trimmed)) { i++; continue; }

    // fenced code
    const fence = /^\s*(```+|~~~+)\s*([A-Za-z0-9+#-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1][0];
      const buf = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${close === '`' ? '```' : '~~~'}`).test(lines[i])) {
        buf.push(lines[i]); i++;
      }
      i++; // closing fence
      const language = fence[2].toLowerCase();
      // Inside a language-tab region keep Python only; elsewhere keep everything.
      if (!inTabs || language === 'python' || language === '') {
        if (inTabs) out.append(el('div', { class: 'tabsnote', text: 'Python' }));
        out.append(codeBlock(buf.join('\n'), language));
      }
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6); // article h1 -> page h2
      out.append(el('h' + level, {}, inline(heading[2].replace(/\s+#+$/, ''))));
      i++; continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { out.append(el('hr')); i++; continue; }

    if (/^>\s?/.test(trimmed)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out.append(el('blockquote', {}, [el('p', {}, inline(buf.join(' ')))]));
      continue;
    }

    if (isTableHead(line, lines[i + 1])) {
      const { node, next } = tableBlock(lines, i);
      out.append(node); i = next; continue;
    }

    if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(line)) {
      const { node, next } = readList(lines, i);
      out.append(node); i = next; continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    // The first line is always taken, so a line that looks like the start of a block
    // to this loop but not to the dispatcher above can never stall the parser.
    const buf = [line.trim()];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (l.trim() === '') break;
      if (/^\s*(```|~~~|#{1,6}\s|>|::tabs-)/.test(l)) break;
      if (/^\s*(?:[-*+]|\d{1,3}[.)])\s+/.test(l)) break;
      if (isTableHead(l, lines[i + 1])) break;
      buf.push(l.trim());
      i++;
    }
    if (buf.length) out.append(el('p', {}, inline(buf.join(' '))));
  }

  return out;
}
