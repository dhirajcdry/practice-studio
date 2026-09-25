// Minimal Python highlighter. Tokenises the raw string and emits text nodes and
// <span class="tok-*"> elements — it never builds markup from the input, so it is
// safe on untrusted code by construction.

import { el } from './dom.js';

const KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass',
  'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case', 'self',
]);

const BUILTINS = new Set([
  'abs', 'all', 'any', 'bin', 'bool', 'chr', 'dict', 'divmod', 'enumerate', 'filter',
  'float', 'frozenset', 'int', 'isinstance', 'iter', 'len', 'list', 'map', 'max',
  'min', 'next', 'ord', 'pow', 'print', 'range', 'reversed', 'round', 'set',
  'setattr', 'sorted', 'str', 'sum', 'tuple', 'type', 'zip', 'super',
]);

// order matters: triple-quoted strings, then comments, then strings, numbers, words
// Built per call, never shared — a /g regex carries mutable state.
const TOKEN_SOURCE = /("""[\s\S]*?"""|'''[\s\S]*?''')|(#[^\n]*)|("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?\b)|([A-Za-z_][A-Za-z0-9_]*)/.source;

export function highlightPython(code) {
  const out = document.createDocumentFragment();
  const text = String(code ?? '');
  const pattern = new RegExp(TOKEN_SOURCE, 'g');
  let last = 0;
  let match;
  let previousWord = '';
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      const gap = text.slice(last, match.index);
      out.append(document.createTextNode(gap));
      if (gap.trim() !== '') previousWord = '';
    }
    last = match.index + match[0].length;
    const [raw, tripleString, comment, string, number, word] = match;
    if (tripleString !== undefined || string !== undefined) {
      out.append(el('span', { class: 'tok-str', text: raw }));
    } else if (comment !== undefined) {
      out.append(el('span', { class: 'tok-com', text: raw }));
    } else if (number !== undefined) {
      out.append(el('span', { class: 'tok-num', text: raw }));
    } else if (KEYWORDS.has(word)) {
      out.append(el('span', { class: 'tok-kw', text: raw }));
      previousWord = word;
      continue;
    } else if (previousWord === 'def' || previousWord === 'class') {
      out.append(el('span', { class: 'tok-def', text: raw }));
    } else if (BUILTINS.has(word)) {
      out.append(el('span', { class: 'tok-bi', text: raw }));
    } else {
      out.append(document.createTextNode(raw));
    }
    previousWord = '';
  }
  if (last < text.length) out.append(document.createTextNode(text.slice(last)));
  return out;
}
