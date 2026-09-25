// Reference solutions and articles from the vendored neetcode-gh/leetcode checkout.
//
// Two things here are load-bearing and both are measured, not assumed:
//
//   1. Solutions resolve by the 4-DIGIT PROBLEM NUMBER, not by slug stem. Upstream spells
//      the same problem differently across languages (`0119-pascal-triangle-ii` has the
//      Python file, `0119-pascals-triangle-ii` has Java/Kotlin). Exact-stem lookup silently
//      loses files.
//
//      But the number alone is NOT sufficient either: upstream has genuinely misnumbered
//      files. `0217-encode-and-decode-strings` is not Contains Duplicate; `0236-power-of-three`
//      is not LCA; `0253-meeting-rooms` is problem 252, not 253. Merging purely by number
//      would serve the wrong problem's code, which is worse than serving nothing.
//
//      So: same number AND a compatible slug. See `stemsAreSameProblem`.
//
//   2. Articles live in a DIFFERENT key space — `articles/<slug>.md`, no number prefix,
//      and the slug is NeetCode's, not LeetCode's (250/250 hit on neetcodeSlug, 176/250 on
//      leetcodeSlug).
//
// Every read is confined to the vendor root by resolving the real path and checking it is
// still inside. The slug arrives from a URL and must never be able to escape.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// Tokens that upstream adds or drops freely between languages.
const NOISE_TOKENS = new Set(['the', 'a', 'an', 'of']);
// A trailing token from this set means a DIFFERENT problem (Meeting Rooms vs Meeting Rooms II).
const ORDINAL_TOKENS = new Set(['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x']);

function singular(token) {
  return token.length > 3 && token.endsWith('s') ? token.slice(0, -1) : token;
}

export function slugTokens(slug) {
  return String(slug)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !NOISE_TOKENS.has(t))
    .map(singular);
}

function isOrdinalish(token) {
  return ORDINAL_TOKENS.has(token) || /^\d+$/.test(token);
}

/**
 * Are two upstream slug spellings the same problem?
 *
 * Equal after noise/plural normalisation  -> yes  (pascal-triangle-ii ≡ pascals-triangle-ii)
 * One a prefix of the other, extra tokens carry no ordinal
 *                                          -> yes  (range-sum-query ≡ range-sum-query-immutable)
 * Anything else                            -> no   (meeting-rooms ≠ meeting-rooms-ii)
 */
export function stemsAreSameProblem(slugA, slugB) {
  const a = slugTokens(slugA);
  const b = slugTokens(slugB);
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === b.length) return a.every((t, i) => t === b[i]);

  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  if (short.length < 2) return false;
  if (!short.every((t, i) => t === long[i])) return false;
  return !long.slice(short.length).some(isOrdinalish);
}

/** Strip the numeric prefix off a stem: "0119-pascals-triangle-ii" -> "pascals-triangle-ii". */
export function stemSlugPart(stem) {
  return String(stem).replace(/^\d+-/, '');
}

/** Leading digits of a stem as an integer. Handles the one 3-digit anomaly (`023-...`). */
export function stemNumber(stem) {
  const m = /^(\d+)-/.exec(String(stem));
  return m ? Number.parseInt(m[1], 10) : null;
}

export class SolutionStore {
  /**
   * @param {object} indexJson parsed data/solutions-index.json
   * @param {string} vendorRoot absolute path to vendor/neetcode-solutions
   */
  constructor(indexJson, vendorRoot) {
    this.raw = indexJson;
    this.solutions = indexJson.solutions || {};
    this.license = {
      notice: indexJson.license?.notice ?? null,
      copyright: indexJson.license?.copyright ?? null,
    };
    this.commit = indexJson.source?.commit ?? null;

    // Resolve the vendor root once, at boot, to its real path. Everything is compared
    // against this. If it does not exist we keep the lexical path and every read fails
    // closed rather than throwing at boot.
    this.vendorRoot = vendorRoot;
    try {
      this.vendorRootReal = fs.realpathSync(vendorRoot);
    } catch {
      this.vendorRootReal = null;
    }

    this.stemsByNumber = new Map();
    for (const stem of Object.keys(this.solutions)) {
      const n = stemNumber(stem);
      if (n === null) continue;
      if (!this.stemsByNumber.has(n)) this.stemsByNumber.set(n, []);
      this.stemsByNumber.get(n).push(stem);
    }

    this.articleSlugs = new Set();
    try {
      for (const name of fs.readdirSync(path.join(vendorRoot, 'articles'))) {
        if (name.endsWith('.md')) this.articleSlugs.add(name.slice(0, -3));
      }
    } catch {
      // No articles directory -> every article lookup 404s. Not fatal.
    }
  }

  /**
   * Every language file for a problem, merged across the number's compatible stems.
   * The catalog's own `solutionCodeStem` wins any language collision.
   *
   * @returns {Map<string, {path: string, stem: string}>}
   */
  languagesFor(entry) {
    const out = new Map();
    const number = entry.number ?? stemNumber(entry.solutionCodeStem || '');
    const canonicalStem = entry.solutionCodeStem || null;

    const add = (stem) => {
      const langs = this.solutions[stem];
      if (!langs) return;
      for (const [lang, relPath] of Object.entries(langs)) {
        if (!out.has(lang)) out.set(lang, { path: relPath, stem });
      }
    };

    if (canonicalStem) add(canonicalStem);

    if (number !== null && number !== undefined) {
      const siblings = this.stemsByNumber.get(number) || [];
      const referenceSlugs = [
        canonicalStem ? stemSlugPart(canonicalStem) : null,
        entry.slug || null,
        entry.neetcodeSlug || null,
      ].filter(Boolean);

      for (const stem of siblings) {
        if (stem === canonicalStem) continue;
        const slugPart = stemSlugPart(stem);
        if (referenceSlugs.some((ref) => stemsAreSameProblem(ref, slugPart))) add(stem);
      }
    }

    return out;
  }

  hasLanguage(entry, language = 'python') {
    return this.languagesFor(entry).has(language);
  }

  /** Relative path of the article for this problem, or null. NeetCode slug first. */
  articlePathFor(entry) {
    for (const slug of [entry.neetcodeSlug, entry.slug]) {
      if (slug && this.articleSlugs.has(slug)) return `articles/${slug}.md`;
    }
    return null;
  }

  hasArticle(entry) {
    return this.articlePathFor(entry) !== null;
  }

  /**
   * Resolve a vendor-relative path to a real absolute path inside the vendor root.
   * Returns null if it does not exist or resolves outside — no exceptions, fail closed.
   */
  async resolveInsideVendor(relPath) {
    if (typeof relPath !== 'string' || relPath === '') return null;
    if (relPath.includes('\0')) return null;
    if (path.isAbsolute(relPath)) return null;
    if (this.vendorRootReal === null) return null;

    const candidate = path.resolve(this.vendorRootReal, relPath);
    let real;
    try {
      real = await fsp.realpath(candidate);
    } catch {
      return null;
    }
    const rootWithSep = this.vendorRootReal.endsWith(path.sep)
      ? this.vendorRootReal
      : this.vendorRootReal + path.sep;
    if (real !== this.vendorRootReal && !real.startsWith(rootWithSep)) return null;

    let stat;
    try {
      stat = await fsp.stat(real);
    } catch {
      return null;
    }
    if (!stat.isFile()) return null;
    return real;
  }

  /** Read a vendor file as UTF-8, or null if missing/outside the root. */
  async readVendorFile(relPath) {
    const real = await this.resolveInsideVendor(relPath);
    if (real === null) return null;
    try {
      return await fsp.readFile(real, 'utf8');
    } catch {
      return null;
    }
  }
}

export function loadSolutionStore(indexFile, vendorRoot) {
  const json = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  return new SolutionStore(json, vendorRoot);
}
