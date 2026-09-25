// Test cases you added yourself.
//
// The example cases come from LeetCode and are read-only — they are the problem's own
// statement, and a "local run" that quietly executed a different set of examples than
// the ones printed above the editor would be lying. Everything you add sits beside them
// in one file per problem, and is yours: a case you invented, or the input a submission
// actually failed on.
//
// That last one is the point of the file. A wrong-answer verdict hands back the exact
// input that broke, and until now the only thing you could do with it was read it. Now
// it becomes a case you can run against, which is what you wanted it for.

import fsp from 'node:fs/promises';
import path from 'node:path';

const MAX_CASES = 25;               // beyond this a local "quick run" is not quick
const MAX_INPUT_CHARS = 8000;
const MAX_EXPECTED_CHARS = 4000;

export const SOURCES = new Set(['custom', 'leetcode']);

export function casesFile(root, slug) {
  return path.join(root, 'problems', slug, 'cases.json');
}

/** One stored case, or null when it cannot be trusted. Never throws. */
function clean(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const input = typeof raw.input === 'string' ? raw.input.replace(/\r\n/g, '\n').trim() : '';
  if (input === '' || input.length > MAX_INPUT_CHARS) return null;
  const expected =
    typeof raw.expected === 'string' && raw.expected.trim() !== ''
      ? raw.expected.trim().slice(0, MAX_EXPECTED_CHARS)
      : null;
  return {
    input,
    expected,
    source: SOURCES.has(raw.source) ? raw.source : 'custom',
    at: typeof raw.at === 'string' ? raw.at : null,
    note: typeof raw.note === 'string' ? raw.note.slice(0, 200) : null,
  };
}

/**
 * The saved cases for one problem, oldest first.
 *
 * A missing or corrupt file reads as "none": your own cases are a convenience, and
 * losing them must never be able to stop a run of the examples.
 */
export async function readCases({ root, slug }) {
  let raw;
  try {
    raw = await fsp.readFile(casesFile(root, slug), 'utf8');
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.cases;
  if (!Array.isArray(list)) return [];
  return list.map(clean).filter(Boolean).slice(0, MAX_CASES);
}

/**
 * Replace the saved cases. Returns what was actually written, so the caller answers
 * with the stored truth rather than what it was sent.
 */
export async function writeCases({ root, slug, cases }) {
  const kept = (Array.isArray(cases) ? cases : []).map(clean).filter(Boolean).slice(0, MAX_CASES);
  const file = casesFile(root, slug);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify({ cases: kept }, null, 2)}\n`, 'utf8');
  return kept;
}

/**
 * How many lines one case must have for this problem — one per parameter, or two for a
 * design problem (the call list and the argument list).
 *
 * Checked when saving rather than when running, so a malformed case is refused where you
 * typed it instead of failing the whole run later with a message about grouping.
 */
export function linesPerCase(shape) {
  return shape.kind === 'design' ? 2 : shape.params.length;
}

/** @returns {string|null} why this input cannot be a case here, or null if it can. */
export function whyNotRunnable(input, perCase) {
  const lines = String(input).split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) return 'A test case needs at least one line of input.';
  if (lines.length !== perCase) {
    return `This problem takes ${perCase} line${perCase === 1 ? '' : 's'} of input per case, and this has ${lines.length}.`;
  }
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      return `This line is not valid JSON, so the runner cannot read it: ${line.slice(0, 80)}`;
    }
  }
  return null;
}
