// The problem as Studio already has it on disk, for the coach.
//
// A coach turn must never reach LeetCode (or the premium-statement mirror): fetching is
// lazy, on open, at human pace — see AGENTS.md. So this reads the content cache the
// problem route fills and nothing else. A problem never opened is "no cached copy", said
// plainly, never a fetch.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { LeetCodeContentCache, toContent } from '../leetcode.mjs';
import { premiumCaseDescription } from '../premium-cases.mjs';
import { parseMetaData } from '../runner/meta.mjs';

export const MAX_STATEMENT_CHARS = 6000;

function cacheFor(leetcode, root) {
  if (leetcode?.readCache) return leetcode;
  return new LeetCodeContentCache({ cacheDir: path.join(root, 'cache', 'leetcode') });
}

/** A premium problem's statement, from the mirror's cache file only. */
async function cachedPremiumStatement(leetcode, root, slug, catalogEntry) {
  const number = catalogEntry?.number ?? catalogEntry?.leetcodeProblemNumber;
  if (!number) return null;
  const dir = leetcode?.premiumCache?.cacheDir ?? path.join(root, 'cache', 'premium-statements');
  try {
    const v = JSON.parse(await fsp.readFile(path.join(dir, `${number}-${slug}.json`), 'utf8'));
    return v?.statementSource && typeof v.descriptionHtml === 'string' && v.descriptionHtml.trim() ? v : null;
  } catch {
    return null;
  }
}

/**
 * The cached problem in the shape the runner takes, plus the statement for reading.
 * Null when there is no complete cached copy. Never fetches, never throws.
 *
 * @returns {Promise<null | {title, metaData, exampleTestcases, descriptionHtml, statementHtml, pythonStub}>}
 */
export async function readCachedProblem({ leetcode = null, root, slug, catalogEntry = null }) {
  try {
    const cached = await cacheFor(leetcode, root).readCache(slug);
    if (!cached || cached.complete === false) return null;
    const content = toContent(cached.question, { fetchedAt: cached.fetchedAt ?? null });
    let statementHtml = content.descriptionHtml;
    let descriptionHtml = content.descriptionHtml;
    let codeSnippets = content.codeSnippets;
    if (content.isPaidOnly && !statementHtml) {
      const statement = await cachedPremiumStatement(leetcode, root, slug, catalogEntry);
      if (statement) {
        statementHtml = statement.descriptionHtml;
        // The same expected-value source the runner route uses for a premium problem.
        descriptionHtml = premiumCaseDescription({ ...content, statementExamples: statement.examples });
        codeSnippets ??= statement.stub ? [{ langSlug: 'python3', code: statement.stub }] : null;
      }
    }
    const python = Array.isArray(codeSnippets)
      ? codeSnippets.find((s) => s?.langSlug === 'python3') ?? codeSnippets.find((s) => s?.langSlug === 'python')
      : null;
    return {
      title: content.title,
      metaData: parseMetaData(content.metaData ?? cached.question?.metaData),
      exampleTestcases: content.exampleTestcases,
      descriptionHtml,
      statementHtml,
      pythonStub: typeof python?.code === 'string' ? python.code : null,
    };
  } catch {
    return null;
  }
}

/** Parameter names in signature order, from metaData. Design problems take call lists. */
export function paramNames(metaData) {
  if (!metaData) return [];
  if (metaData.classname) return ['calls', 'arguments'];
  return Array.isArray(metaData.params) ? metaData.params.map((p) => String(p?.name ?? '')).filter(Boolean) : [];
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', le: '≤', ge: '≥', ne: '≠', times: '×', minus: '−', hellip: '…', rarr: '→', larr: '←' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      try { return String.fromCodePoint(n); } catch { return m; }
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * LeetCode's statement HTML as compact plain text: paragraphs and list items on their own
 * lines, example <pre> blocks kept line for line, exponents as ^, everything else
 * stripped. Text handling only — nothing is parsed as markup or executed.
 */
export function statementText(html, limit = MAX_STATEMENT_CHARS) {
  if (typeof html !== 'string' || !html.trim()) return '';
  let s = html.replace(/\r\n?/g, '\n');
  // Inside <pre>, newlines are the layout; outside, they are just whitespace.
  const pres = [];
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_, body) => {
    pres.push(body.replace(/<[^>]*>/g, ''));
    return `\n\u0000PRE${pres.length - 1}\u0000\n`;
  });
  s = s.replace(/\s+/g, ' ')
    .replace(/<sup>\s*([^<]*?)\s*<\/sup>/gi, '^$1')
    .replace(/<sub>\s*([^<]*?)\s*<\/sub>/gi, '_$1')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|ul|ol|h[1-6]|li|table|tr)>/gi, '\n')
    .replace(/<(p|div|ul|ol|h[1-6]|table|tr)[^>]*>/gi, '\n')
    .replace(/<img[^>]*>/gi, ' [image] ')
    .replace(/<[^>]*>/g, '');
  s = s.replace(/\u0000PRE(\d+)\u0000/g, (_, i) => pres[Number(i)].trim());
  s = decodeEntities(s)
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?!-)/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s.length > limit ? `${s.slice(0, limit)}\n… (statement truncated at ${limit} characters)` : s;
}
