// The curriculum: NeetCode 250, in NeetCode's own order.
//
// The wire shape is the API contract's, which is not the bundle's shape — the bundle calls
// them `leetcodeSlug` / `leetcodeProblemNumber`. Translate once, here.

import fs from 'node:fs';

/** @returns the public per-problem object exactly as the contract specifies it. */
function toPublic(record, store) {
  const entry = {
    slug: record.leetcodeSlug,
    neetcodeSlug: record.neetcodeSlug ?? null,
    number: record.leetcodeProblemNumber ?? null,
    title: record.title ?? null,
    pattern: record.pattern ?? null,
    difficulty: record.difficulty ?? null,
    lists: {
      blind75: record.lists?.blind75 === true,
      neetcode150: record.lists?.neetcode150 === true,
      neetcode250: record.lists?.neetcode250 === true,
    },
    isPro: record.isPro === true,
    hasPythonSolution: false,
    hasArticle: false,
    youtubeVideoId: record.youtubeVideoId ?? null,
  };

  // Kept off the wire, needed for lookups.
  Object.defineProperty(entry, 'solutionCodeStem', {
    value: record.solutionCodeStem ?? null,
    enumerable: false,
  });

  entry.hasPythonSolution = store.hasLanguage(entry, 'python');
  entry.hasArticle = store.hasArticle(entry);
  return entry;
}

export class Catalog {
  /**
   * @param catalogJson the NeetCode bundle
   * @param store       the vendored-solution index
   */
  constructor(catalogJson, store) {
    const records = Array.isArray(catalogJson.problems) ? catalogJson.problems : [];

    this.allPatterns = [];
    const seenAll = new Set();
    for (const r of records) {
      if (r.pattern && !seenAll.has(r.pattern)) {
        seenAll.add(r.pattern);
        this.allPatterns.push(r.pattern);
      }
    }

    const selected = records.filter((r) => r.lists?.neetcode250 === true);

    this.problems = [];
    this.bySlug = new Map();
    this.patterns = [];
    // Read from the records rather than the public entry: `lists` on the wire is the
    // API contract's shape and gains no field because of an internal selection.
    this.neetcode250 = [];
    const seen = new Set();

    for (const r of selected) {
      if (!r.leetcodeSlug) continue;
      const entry = toPublic(r, store);
      this.problems.push(entry);
      this.bySlug.set(entry.slug, entry);
      if (r.lists?.neetcode250 === true) this.neetcode250.push(entry);
      if (entry.pattern && !seen.has(entry.pattern)) {
        seen.add(entry.pattern);
        this.patterns.push(entry.pattern); // first-appearance order == NeetCode's order
      }
    }

    this.source = catalogJson.source?.bundleURL ?? catalogJson.source?.site ?? null;
    this.totalRecords = records.length;
  }

  get(slug) {
    return this.bySlug.get(slug) ?? null;
  }
}

export function loadCatalog(catalogFile, store) {
  const json = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  return new Catalog(json, store);
}

/**
 * Boot-time sanity. Returns warnings; the caller logs them. Never exits — a drifted count
 * is a signal, not a reason to refuse to start.
 */
export function validateCatalog(catalog) {
  const warnings = [];
  if (catalog.neetcode250.length !== 250) {
    warnings.push(
      `expected 250 problems in neetcode250, found ${catalog.neetcode250.length} — the upstream bundle may have moved`,
    );
  }
  if (catalog.patterns.length !== 18) {
    warnings.push(
      `expected 18 patterns, found ${catalog.patterns.length}: ${catalog.patterns.join(', ')}`,
    );
  }
  if (catalog.patterns.includes('JavaScript')) {
    warnings.push(
      'the "JavaScript" pattern leaked into the NeetCode 250 — those are non-DSA language exercises and were not expected here',
    );
  }
  return warnings;
}
