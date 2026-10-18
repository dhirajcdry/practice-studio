// NeetCode pages contain reference answers too. Retain only this problem-definition
// allowlist, before anything can reach disk, the browser, or coach context.
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parsePythonStub, pythonType } from './runner/stub.mjs';

export function parseNeetCodePage(html) {
  const match = typeof html === 'string' && /<script\b[^>]*\bid=["'](?:ng-state|serverApp-state)["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try {
    const state = JSON.parse(match[1]);
    const entry = Object.entries(state).find(([key, value]) => key.startsWith('problem-') && value && typeof value === 'object');
    if (!entry) return null;
    const [key, raw] = entry;
    const string = value => typeof value === 'string' ? value : null;
    const starterPython = string(raw.starterCode?.python);
    return {
      ncSlug: key.slice('problem-'.length), name: string(raw.name),
      description: string(raw.description), starterPython,
      examples: Array.isArray(raw.custom_test_cases) ? raw.custom_test_cases.filter(v => typeof v === 'string') : [],
      testCaseType: string(raw.test_case_type),
      proOnly: !starterPython?.trim() && raw.free === false,
      message: string(raw.message),
    };
  } catch { return null; }
}

// Separate assignments only outside strings/containers. Parentheses in values are
// tuple syntax; replacing them outside strings gives the runner ordinary JSON arrays.
export function parseNeetCodeExample(input, params) {
  let quote = '', escape = false, depth = 0, part = '', pieces = [];
  for (const ch of input) {
    if (quote) {
      part += ch;
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"') { quote = ch; part += ch; continue; }
    if ('[({'.includes(ch)) depth++;
    if ('])}'.includes(ch)) depth--;
    if ((ch === ',' || ch === '\n') && depth === 0) {
      if (part.trim()) pieces.push(part.trim());
      part = ''; continue;
    }
    part += ch === '(' ? '[' : ch === ')' ? ']' : ch;
  }
  if (part.trim()) pieces.push(part.trim());
  const values = new Map();
  for (const piece of pieces) {
    const m = /^(\w+)\s*=\s*([\s\S]+)$/.exec(piece);
    if (!m || values.has(m[1])) throw new Error('Unrecognized NeetCode example');
    values.set(m[1], JSON.parse(m[2]));
  }
  if (values.size !== params.length || params.some(p => !values.has(p.name ?? p))) throw new Error('NeetCode example parameters differ');
  return params.map(p => values.get(p.name ?? p));
}

function metadataType(type) {
  const { base, depth } = pythonType(type);
  return base + '[]'.repeat(depth);
}

// NeetCode's markdown carries TeX, image embeds and a trailing block of topic and
// company links. Studio's markdown renderer handles none of those, so they become
// plain text, a link, and nothing.
const TEX = { '\\times': '×', '\\le': '≤', '\\leq': '≤', '\\ge': '≥', '\\geq': '≥', '\\ne': '≠', '\\neq': '≠', '\\cdot': '·' };
export function cleanStatement(markdown) {
  return (markdown || '')
    .replace(/(?:\s*<br\s*\/?>)*\s*<details[\s\S]*$/i, '')
    .replace(/!\[[^\]\n]*\]\(([^)\s]+)\)/g, '[Picture on NeetCode]($1)')
    .replace(/\$([^$\n]+)\$/g, (_, tex) => tex.replace(/\\[a-z]+/g, cmd => TEX[cmd] ?? cmd.slice(1)))
    .trim();
}

// NeetCode prints each example's answer as "Output: …" inside the example's code block.
// Those are the expected values, published by NeetCode itself. They are used only when
// every example has exactly one that reads as JSON, and never when the statement says
// several answers are accepted (a fixed string would fail a valid one).
export function statementOutputs(markdown, count) {
  if (!markdown || /one possible|return any|any of them|any valid/i.test(markdown)) return null;
  const outputs = [...markdown.matchAll(/^Output:\s*([\s\S]*?)\s*^```/gm)].map(m => m[1]);
  if (outputs.length !== count) return null;
  try { return outputs.map(text => JSON.stringify(JSON.parse(text))); } catch { return null; }
}

// What buildCases reads expected values from, in the shape it already parses.
export function neetcodeExpectedHtml(meta) {
  const outputs = Array.isArray(meta?.neetcodeExpected) ? meta.neetcodeExpected : [];
  return outputs.map(o => `<pre><strong>Output:</strong> ${String(o).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</pre>`).join('');
}

export function neetcodeDefinition(problem) {
  if (!problem?.starterPython || problem.proOnly) return null;
  // Definition comments (including Interval's docstring) are not callable methods.
  const code = problem.starterPython.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '');
  const methods = [...code.matchAll(/^    def\s+[^\n]+/gm)].map(m => parsePythonStub(m[0])).filter(Boolean);
  if (!methods.length || methods.some(m => !m.returnType || m.params.some(p => !p.type))) return null;
  const first = methods[0];
  const params = first.params.map(p => ({ name: p.name, type: metadataType(p.type) }));
  const roundTrip = problem.ncSlug === 'string-encode-and-decode' && problem.testCaseType === 'class'
    && methods.map(m => m.name).join(',') === 'encode,decode';
  if (problem.testCaseType === 'class' && !roundTrip) return null;
  const metaData = {
    name: first.name, params, return: { type: roundTrip ? 'string[]' : metadataType(first.returnType) },
    neetcode: true,
    ...(roundTrip ? { neetcodeRoundTrip: true } : {}),
    ...(first.returnType === 'None' && params.length === 1 ? { output: { paramindex: 0 } } : {}),
  };
  let examples;
  try { examples = problem.examples.map(example => parseNeetCodeExample(example, params)); }
  catch { return null; } // Never run a guessed argument list.
  const expected = statementOutputs(problem.description, examples.length);
  if (expected) metaData.neetcodeExpected = expected;
  const statement = cleanStatement(problem.description);
  return {
    title: problem.name, descriptionMarkdown: statement,
    // The existing cache-only coach reader accepts HTML. Escaped prose keeps its
    // statement readable without handing markdown to an HTML renderer in the page.
    descriptionHtml: '<pre>' + statement.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre>',
    codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'from typing import List\n\n' + problem.starterPython }],
    metaData, exampleTestcases: examples.flatMap(values => values.map(v => JSON.stringify(v))).join('\n'),
    statementSource: { url: `https://neetcode.io/problems/${problem.ncSlug}/question` },
    neetcodeShape: { methods: methods.map(m => ({ name: m.name, params: m.params.map(p => p.name) })),
      intervals: params.some(p => p.type === 'interval[]'), testCaseType: problem.testCaseType },
  };
}

export class NeetCodeContentCache {
  constructor({ cacheDir, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
    this.cacheDir = cacheDir; this.fetchImpl = fetchImpl; this.timeoutMs = timeoutMs;
    this.inFlight = new Map();
  }
  file(slug) { return path.join(this.cacheDir, `${slug}.json`); }
  async read(slug) {
    if (!/^[a-z0-9-]+$/.test(slug)) return null;
    try { return JSON.parse(await fsp.readFile(this.file(slug), 'utf8')); } catch { return null; }
  }
  async write(slug, content) {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const file = this.file(slug);
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString('hex')}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(content), 'utf8');
      await fsp.rename(tmp, file);
    } finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
  }
  async get(slug) {
    if (!/^[a-z0-9-]+$/.test(slug)) return null;
    if (this.inFlight.has(slug)) return this.inFlight.get(slug);
    const work = (async () => {
      const cached = await this.read(slug);
      if (cached) return cached;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(`https://neetcode.io/problems/${slug}/question`, {
          headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' },
          signal: controller.signal,
        });
        if (!res.ok) return null;
        const parsed = parseNeetCodePage(await res.text());
        if (!parsed || parsed.ncSlug !== slug) return null;
        await this.write(slug, parsed).catch(() => {});
        return parsed;
      } catch { return null; } finally { clearTimeout(timer); }
    })().finally(() => this.inFlight.delete(slug));
    this.inFlight.set(slug, work);
    return work;
  }
}
