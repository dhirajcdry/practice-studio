#!/usr/bin/env node
/**
 * extract-catalog.mjs
 *
 * Extracts the NeetCode problem catalog out of neetcode.io's minified Angular
 * bundle and writes a clean, self-describing JSON document.
 *
 * The bundle contains ONE array literal of the form `[{problem:"...",...},...]`.
 * It is JavaScript, not JSON (unquoted keys, `!0` for true), so we:
 *   1. locate the array's exact bounds by string-aware bracket matching,
 *   2. evaluate ONLY that substring inside a `vm` context with no globals.
 * We never evaluate the whole bundle.
 *
 * Node 23+, ESM, zero dependencies.
 *
 * Usage:
 *   node extract-catalog.mjs [--bundle <path>] [--out <path>] [--url <bundleUrl>]
 *
 * If the bundle file is missing the script tells you how to fetch it; the
 * bundle filename is content-hashed by Angular and changes on every deploy,
 * so pass --bundle/--url when it does.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// ---------------------------------------------------------------------------
// Config / CLI
// ---------------------------------------------------------------------------

const DEFAULTS = {
  bundle: path.join(os.tmpdir(), 'neetcode-main.js'),
  out: path.resolve(import.meta.dirname, '../data/catalog.json'),
  url: 'https://neetcode.io/main.1a397832321f0098.js',
  extractionDate: '2026-07-25',
};

function parseArgs(argv) {
  const opts = { ...DEFAULTS };
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!(key in opts)) throw new Error(`Unknown option: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new Error(`Missing value for ${argv[i]}`);
    opts[key] = argv[i + 1];
  }
  return opts;
}

// ---------------------------------------------------------------------------
// URL construction rule (also recorded in the output metadata)
// ---------------------------------------------------------------------------

const URL_RULE = {
  leetcodeURL:
    "'https://leetcode.com/problems/' + leetcodeSlug + '/' where leetcodeSlug is the bundle's `link` field with any leading/trailing slashes stripped.",
  neetcodeURL:
    "'https://neetcode.io/problems/' + neetcodeSlug where neetcodeSlug is the bundle's `ncLink` field with any leading/trailing slashes stripped. null when the record has no ncLink (those problems have no NeetCode-hosted page).",
  solutionURL:
    'not constructed; `solutionCodeStem` is the filename stem under github.com/neetcode-gh/leetcode (language dir and extension vary, so a URL cannot be derived without guessing).',
  youtubeURL:
    "not constructed; use 'https://youtube.com/embed/' + youtubeVideoId if needed (that is the prefix the bundle itself uses).",
};

// Keys that carry data rather than list membership.
const DATA_KEYS = new Set([
  'problem',
  'pattern',
  'link',
  'ncLink',
  'video',
  'difficulty',
  'code',
]);
// `pro` is a boolean flag but is surfaced as `isPro`, not as a list.
const NON_LIST_BOOLEAN_KEYS = new Set(['pro']);

const REQUIRED_FIELDS = ['problem', 'pattern', 'link', 'difficulty'];

// ---------------------------------------------------------------------------
// Step 1: locate the array literal
// ---------------------------------------------------------------------------

/**
 * String/regex/comment-aware bracket matcher. Given the index of an opening
 * `[`, returns the index just past its matching `]`.
 */
function matchBracket(src, start) {
  if (src[start] !== '[') throw new Error(`Expected '[' at ${start}`);
  const stack = [];
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      // skip string literal
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2);
      if (i === -1) throw new Error('Unterminated block comment');
      i += 2;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') { stack.push(c); i++; continue; }
    if (c === ']' || c === '}' || c === ')') {
      const open = stack.pop();
      const expected = { ']': '[', '}': '{', ')': '(' }[c];
      if (open !== expected) {
        throw new Error(`Bracket mismatch at ${i}: '${c}' closes '${open}'`);
      }
      i++;
      if (stack.length === 0) return i;
      continue;
    }
    i++;
  }
  throw new Error('Unterminated array literal');
}

function findCatalogArray(src) {
  // The array is emitted with no whitespace; its first element always starts
  // with the `problem:` key. Be tolerant of minor minifier variation.
  const marker = /\[\s*\{\s*problem\s*:/g;
  const starts = [];
  let m;
  while ((m = marker.exec(src)) !== null) starts.push(m.index);
  if (starts.length === 0) {
    throw new Error(
      'Could not find any `[{problem:` array literal in the bundle. The bundle ' +
        'shape may have changed; inspect it manually.'
    );
  }
  // Evaluate every candidate and keep the largest well-formed one.
  const candidates = [];
  for (const start of starts) {
    let end;
    try {
      end = matchBracket(src, start);
    } catch {
      continue;
    }
    const text = src.slice(start, end);
    let value;
    try {
      value = evaluateLiteral(text);
    } catch {
      continue;
    }
    if (Array.isArray(value) && value.length > 0) {
      candidates.push({ start, end, text, value });
    }
  }
  if (candidates.length === 0) {
    throw new Error('Found `[{problem:` markers but none evaluated to an array.');
  }
  candidates.sort((a, b) => b.value.length - a.value.length);
  return candidates[0];
}

/** Evaluate an isolated literal in a context with no globals whatsoever. */
function evaluateLiteral(text) {
  const context = vm.createContext(Object.create(null));
  const script = new vm.Script(`(${text})`, { filename: 'catalog-literal.js' });
  return script.runInContext(context, { timeout: 10_000 });
}

// ---------------------------------------------------------------------------
// Step 2: normalize
// ---------------------------------------------------------------------------

const stripSlashes = (s) =>
  typeof s === 'string' ? s.replace(/^\/+/, '').replace(/\/+$/, '') : '';

const nullIfEmpty = (s) => {
  const v = typeof s === 'string' ? s.trim() : '';
  return v === '' ? null : v;
};

/** "0001-two-sum" -> 1 ; "1929-concatenation-of-array" -> 1929 ; else null. */
function parseProblemNumber(codeStem) {
  if (typeof codeStem !== 'string') return null;
  const m = /^(\d+)-/.exec(codeStem.trim());
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

function normalize(raw, listFlagKeys) {
  const leetcodeSlug = nullIfEmpty(stripSlashes(raw.link));
  const neetcodeSlug = nullIfEmpty(stripSlashes(raw.ncLink));
  const solutionCodeStem = nullIfEmpty(raw.code);

  const lists = {};
  for (const key of listFlagKeys) lists[key] = raw[key] === true;

  return {
    leetcodeSlug,
    neetcodeSlug,
    title: nullIfEmpty(raw.problem),
    pattern: nullIfEmpty(raw.pattern),
    difficulty: nullIfEmpty(raw.difficulty),
    leetcodeProblemNumber: parseProblemNumber(raw.code),
    solutionCodeStem,
    youtubeVideoId: nullIfEmpty(raw.video),
    lists,
    isPro: raw.pro === true,
    leetcodeURL: leetcodeSlug ? `https://leetcode.com/problems/${leetcodeSlug}/` : null,
    neetcodeURL: neetcodeSlug ? `https://neetcode.io/problems/${neetcodeSlug}` : null,
  };
}

// ---------------------------------------------------------------------------
// Step 3: validate + report
// ---------------------------------------------------------------------------

function tally(items, keyFn) {
  const counts = new Map();
  for (const it of items) {
    const k = keyFn(it);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

function validate(records, rawRecords, listFlagKeys, allKeys) {
  const problems = [];

  const missingRequired = [];
  rawRecords.forEach((raw, i) => {
    const missing = REQUIRED_FIELDS.filter(
      (f) => typeof raw[f] !== 'string' || raw[f].trim() === ''
    );
    if (missing.length) {
      missingRequired.push({ index: i, title: raw.problem ?? null, missing });
    }
  });

  const missingNcLink = records.filter((r) => r.neetcodeSlug === null);
  const missingCode = records.filter((r) => r.solutionCodeStem === null);
  const unparseableNumber = records.filter(
    (r) => r.solutionCodeStem !== null && r.leetcodeProblemNumber === null
  );

  const bySlug = new Map();
  for (const r of records) {
    if (!r.leetcodeSlug) continue;
    if (!bySlug.has(r.leetcodeSlug)) bySlug.set(r.leetcodeSlug, []);
    bySlug.get(r.leetcodeSlug).push(r);
  }
  const duplicateLeetcodeSlugs = [...bySlug.entries()]
    .filter(([, v]) => v.length > 1)
    .map(([slug, v]) => ({ slug, count: v.length, titles: v.map((r) => r.title) }));

  const ncSlugs = records.map((r) => r.neetcodeSlug).filter(Boolean);
  const distinctNcSlugs = new Set(ncSlugs);
  const duplicateNeetcodeSlugs = Object.entries(tally(ncSlugs, (s) => s))
    .filter(([, n]) => n > 1)
    .map(([slug, count]) => ({ slug, count }));

  const forked = records.filter(
    (r) => r.neetcodeSlug !== null && r.neetcodeSlug !== r.leetcodeSlug
  );

  const listCounts = {};
  for (const key of listFlagKeys) {
    listCounts[key] = records.filter((r) => r.lists[key]).length;
  }

  return {
    totalRecords: records.length,
    distinctLeetcodeSlugs: bySlug.size,
    distinctNeetcodeSlugs: distinctNcSlugs.size,
    recordsWithoutNeetcodeSlug: missingNcLink.length,
    recordsWithoutSolutionCodeStem: missingCode.length,
    recordsWithUnparseableProblemNumber: unparseableNumber.length,
    slugForkCount: forked.length,
    proCount: records.filter((r) => r.isPro).length,
    listCounts,
    patternCounts: tally(records, (r) => r.pattern ?? '(none)'),
    difficultyCounts: tally(records, (r) => r.difficulty ?? '(none)'),
    duplicateLeetcodeSlugs,
    duplicateNeetcodeSlugs,
    missingRequiredFields: missingRequired,
    discoveredKeys: [...allKeys].sort(),
    listFlagKeys: [...listFlagKeys].sort(),
    problems,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);

  if (!fs.existsSync(opts.bundle)) {
    console.error(`Bundle not found: ${opts.bundle}`);
    console.error(`Fetch it with:\n  curl -s ${opts.url} -o ${opts.bundle}`);
    console.error(
      'Note: the bundle filename is content-hashed and changes on every ' +
        'neetcode.io deploy. Find the current one in the HTML of https://neetcode.io/.'
    );
    process.exit(1);
  }

  const src = fs.readFileSync(opts.bundle, 'utf8');
  const found = findCatalogArray(src);
  const rawRecords = found.value;

  // Discover every key that appears anywhere, and every boolean-ish flag key.
  const allKeys = new Set();
  const listFlagKeys = new Set();
  const nonStringValues = [];
  for (const raw of rawRecords) {
    for (const [k, v] of Object.entries(raw)) {
      allKeys.add(k);
      if (typeof v === 'boolean') {
        if (!NON_LIST_BOOLEAN_KEYS.has(k)) listFlagKeys.add(k);
      } else if (typeof v !== 'string') {
        nonStringValues.push({ key: k, type: typeof v, title: raw.problem });
      }
      if (!DATA_KEYS.has(k) && typeof v !== 'boolean') {
        // A non-boolean unknown key — worth surfacing.
        nonStringValues.push({ key: k, type: typeof v, title: raw.problem });
      }
    }
  }

  const orderedListKeys = [...listFlagKeys].sort();
  const records = rawRecords.map((raw) => normalize(raw, orderedListKeys));
  const report = validate(records, rawRecords, orderedListKeys, allKeys);
  report.nonStringOrUnexpectedValues = nonStringValues;

  const doc = {
    schemaVersion: 2,
    source: {
      bundleURL: opts.url,
      bundleFilename: path.basename(opts.bundle),
      bundleByteLength: src.length,
      arrayByteOffsets: { start: found.start, end: found.end },
      site: 'https://neetcode.io/',
    },
    extraction: {
      extractionDate: opts.extractionDate,
      extractor: 'studio/scripts/extract-catalog.mjs',
      method:
        'String-aware bracket matching locates the single `[{problem:...}]` array ' +
        'literal in the bundle; that substring alone is evaluated with node:vm in a ' +
        'context created from a null-prototype object with no globals.',
      note:
        'Boolean list flags are minified as `!0` and appear only when true; they are ' +
        'materialized here as explicit true/false for every flag discovered anywhere ' +
        'in the array. No value is inferred or defaulted — anything absent is null.',
    },
    urlConstructionRule: URL_RULE,
    fieldNotes: {
      leetcodeSlug: "from `link`; the problem slug on leetcode.com.",
      neetcodeSlug:
        "from `ncLink`; NeetCode's own slug, frequently DIFFERENT from the LeetCode slug " +
        '(e.g. two-sum -> two-integer-sum). null when the record has no NeetCode page.',
      leetcodeProblemNumber:
        "integer prefix of `code` (e.g. '0001-two-sum' -> 1); null when `code` is absent " +
        'or has no numeric prefix.',
      solutionCodeStem:
        'filename stem under github.com/neetcode-gh/leetcode; null when absent.',
      youtubeVideoId: 'from `video`; null when the bundle has an empty string.',
      isPro: 'from the `pro` flag; NeetCode Pro-gated content.',
    },
    counts: {
      totalRecords: report.totalRecords,
      distinctLeetcodeSlugs: report.distinctLeetcodeSlugs,
      distinctNeetcodeSlugs: report.distinctNeetcodeSlugs,
      recordsWithoutNeetcodeSlug: report.recordsWithoutNeetcodeSlug,
      slugForkCount: report.slugForkCount,
      proCount: report.proCount,
      byList: report.listCounts,
      byDifficulty: report.difficultyCounts,
      byPattern: report.patternCounts,
    },
    validation: {
      duplicateLeetcodeSlugs: report.duplicateLeetcodeSlugs,
      duplicateNeetcodeSlugs: report.duplicateNeetcodeSlugs,
      missingRequiredFields: report.missingRequiredFields,
      recordsWithoutSolutionCodeStem: report.recordsWithoutSolutionCodeStem,
      recordsWithUnparseableProblemNumber:
        report.recordsWithUnparseableProblemNumber,
      discoveredKeys: report.discoveredKeys,
      listFlagKeys: report.listFlagKeys,
    },
    problems: records,
  };

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify(doc, null, 2) + '\n', 'utf8');

  // ------------------------------ report ---------------------------------
  const log = (...a) => console.log(...a);
  log('=== NeetCode catalog extraction ===');
  log(`bundle          : ${opts.bundle} (${src.length} bytes)`);
  log(`array bounds    : [${found.start}, ${found.end}) = ${found.end - found.start} bytes`);
  log(`output          : ${opts.out}`);
  log('');
  log(`total records            : ${report.totalRecords}`);
  log(`distinct leetcode slugs  : ${report.distinctLeetcodeSlugs}`);
  log(`distinct neetcode slugs  : ${report.distinctNeetcodeSlugs}`);
  log(`records w/o neetcodeSlug : ${report.recordsWithoutNeetcodeSlug}`);
  log(`slug forks (lc != nc)    : ${report.slugForkCount}`);
  log(`pro-gated records        : ${report.proCount}`);
  log('');
  log('discovered keys          :', report.discoveredKeys.join(', '));
  log('list flag keys           :', report.listFlagKeys.join(', '));
  log('');
  log('--- count per list flag ---');
  for (const [k, v] of Object.entries(report.listCounts).sort()) log(`  ${k.padEnd(18)} ${v}`);
  log('');
  log('--- count per difficulty ---');
  for (const [k, v] of Object.entries(report.difficultyCounts)) log(`  ${k.padEnd(18)} ${v}`);
  log('');
  log('--- count per pattern ---');
  for (const [k, v] of Object.entries(report.patternCounts)) log(`  ${k.padEnd(28)} ${v}`);
  log('');
  log('--- validation ---');
  log(`missing required fields  : ${report.missingRequiredFields.length}`);
  for (const m of report.missingRequiredFields.slice(0, 30)) {
    log(`    [${m.index}] ${m.title} -> missing ${m.missing.join(', ')}`);
  }
  log(`duplicate leetcode slugs : ${report.duplicateLeetcodeSlugs.length}`);
  for (const d of report.duplicateLeetcodeSlugs) {
    log(`    ${d.slug} x${d.count} :: ${d.titles.join(' | ')}`);
  }
  log(`duplicate neetcode slugs : ${report.duplicateNeetcodeSlugs.length}`);
  for (const d of report.duplicateNeetcodeSlugs) log(`    ${d.slug} x${d.count}`);
  log(`no solutionCodeStem      : ${report.recordsWithoutSolutionCodeStem}`);
  log(`unparseable problem no.  : ${report.recordsWithUnparseableProblemNumber}`);
  if (report.nonStringOrUnexpectedValues.length) {
    log('unexpected value types   :', JSON.stringify(report.nonStringOrUnexpectedValues.slice(0, 20)));
  }
}

main();
