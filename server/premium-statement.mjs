import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const RAW_ROOT = 'https://raw.githubusercontent.com/doocs/leetcode/main/solution';
const API_ROOT = 'https://api.github.com/repos/doocs/leetcode/contents/solution';
const GITHUB_ROOT = 'https://github.com/doocs/leetcode/blob/main/solution';

function decode(html) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name) => {
      if (Object.hasOwn(named, name)) return named[name];
      if (!name.startsWith('#')) return entity;
      const number = name[1].toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
    });
}

export function solutionPath(number, title) {
  const n = Number(number);
  const nn = String(n).padStart(4, '0');
  const lo = Math.floor(n / 100) * 100;
  const range = `${String(lo).padStart(4, '0')}-${String(lo + 99).padStart(4, '0')}`;
  const segment = `${nn}.${title}`;
  return [range, segment, 'README_EN.md'].map(encodeURIComponent).join('/');
}

// Read headers without evaluating any upstream Python or retaining method bodies.
function headerEnd(lines, start) {
  let depth = 0, quote = null, escaped = false;
  for (let i = start; i < lines.length; i++) {
    for (let j = 0; j < lines[i].length; j++) {
      const c = lines[i][j];
      if (quote) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '#') break;
      else if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ':' && depth === 0) return { line: i, column: j };
    }
  }
  return null;
}

function codeStub(markdown) {
  const match = markdown.match(/^```python[^\S\n]*\n([\s\S]*?)^```/m);
  if (!match) return '';
  const lines = match[1].replace(/\r/g, '').split('\n');
  const out = [];
  let definition = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^# Definition (?:for|of)\b/.test(line)) definition = true;
    if (definition && /^#/.test(line)) { out.push(line); continue; }
    if (line.trim()) definition = false;
    if (!/^class\s+\w+.*:\s*$/.test(line)) continue;
    out.push(line);
    let end = i + 1;
    while (end < lines.length && (!lines[end].trim() || /^\s|^#/.test(lines[end]))) end++;
    const members = lines.slice(i + 1, end).filter(l => l.trim() && !/^\s*#/.test(l));
    const indent = Math.min(...members.map(l => l.match(/^\s*/)[0].length));
    let decorators = [], methods = 0;
    for (let j = i + 1; j < end; j++) {
      const l = lines[j], spaces = l.match(/^\s*/)[0];
      if (spaces.length !== indent) continue;
      if (l.trimStart().startsWith('@')) {
        decorators.push(l);
        while (j + 1 < end && lines[j + 1].match(/^\s*/)[0].length > indent) decorators.push(lines[++j]);
        if (j + 1 < end && /^\s*\)\s*$/.test(lines[j + 1])) decorators.push(lines[++j]);
        continue;
      }
      if (!/^\s+(?:async\s+)?def\s+\w+\s*\(/.test(l)) { decorators = []; continue; }
      const h = headerEnd(lines, j);
      if (!h || h.line >= end) return '';
      out.push(...decorators, ...lines.slice(j, h.line), lines[h.line].slice(0, h.column + 1), `${spaces}    pass`);
      decorators = []; methods++; j = h.line;
    }
    if (!methods) out.push('    pass');
    i = end - 1;
  }
  return out.join('\n').trim();
}

export function parsePremiumStatement(markdown) {
  if (typeof markdown !== 'string') return null;
  const marker = markdown.match(/<!--\s*description:start\s*-->([\s\S]*?)<!--\s*description:end\s*-->/i);
  if (!marker || !marker[1].trim()) return null;
  const before = marker[1];
  const section = markdown.match(/##\s+Solutions\b([\s\S]*)/i)?.[1] ?? '';
  const examples = [];
  for (const block of before.matchAll(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi)) {
    const pair = block[1].match(/<strong\b[^>]*>\s*Input:\s*<\/strong>([\s\S]*?)<strong\b[^>]*>\s*Output:\s*<\/strong>([\s\S]*?)(?=<strong\b|$)/i);
    if (pair) examples.push({ input: decode(pair[1]).trim(), output: decode(pair[2]).trim() });
  }
  return { descriptionHtml: before.trim(), stub: codeStub(section), examples };
}

export class PremiumStatementCache {
  constructor({ cacheDir, fetchImpl = fetch } = {}) {
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl;
    this.inFlight = new Map();
  }
  file(entry) { return path.join(this.cacheDir, `${entry.leetcodeProblemNumber}-${entry.slug}.json`); }
  async getStatement(entry) {
    const key = `${entry.leetcodeProblemNumber}:${entry.slug}`;
    if (!this.inFlight.has(key)) this.inFlight.set(key, this.load(entry).finally(() => this.inFlight.delete(key)));
    return this.inFlight.get(key);
  }
  async load(entry) {
    try { const v = JSON.parse(await fsp.readFile(this.file(entry), 'utf8')); if (v?.statementSource && typeof v.descriptionHtml === 'string' && v.descriptionHtml.trim()) return v; } catch {}
    try {
      let rawPath = solutionPath(entry.leetcodeProblemNumber, entry.title);
      let res = await this.fetchImpl(`${RAW_ROOT}/${rawPath}`, { signal: AbortSignal.timeout(15000) });
      if (res.status === 404) {
        const range = rawPath.split('/')[0];
        const listing = await this.fetchImpl(`${API_ROOT}/${encodeURIComponent(range)}`, { signal: AbortSignal.timeout(15000) });
        if (!listing.ok) return null;
        const items = await listing.json();
        const found = items.find((x) => x.name?.startsWith(String(entry.leetcodeProblemNumber).padStart(4, '0') + '.') && x.type === 'dir');
        if (!found?.name) return null;
        const folder = [range, found.name, 'README_EN.md'].map(encodeURIComponent).join('/');
        res = await this.fetchImpl(`${RAW_ROOT}/${folder}`, { signal: AbortSignal.timeout(15000) });
        if (!res.ok) return null;
        rawPath = folder;
      } else if (!res.ok) return null;
      const text = await res.text();
      const parsed = parsePremiumStatement(text); if (!parsed) return null;
      const result = { ...parsed, statementSource: { name: 'doocs/leetcode', url: `${GITHUB_ROOT}/${rawPath}`, license: 'CC BY-SA 4.0' } };
      try {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const tmp = `${this.file(entry)}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
        try { await fsp.writeFile(tmp, JSON.stringify(result), 'utf8'); await fsp.rename(tmp, this.file(entry)); }
        finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
      } catch { /* cache failure must not hide a valid fetched statement */ }
      return result;
    } catch { return null; }
  }
}
