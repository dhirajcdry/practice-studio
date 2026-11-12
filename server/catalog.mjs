// NeetCode 250 in its original order, plus an optional private practice collection.
//
// The collection is personal data: it lives in the learner's workspace
// (`STUDIO_HOME/collection.json`), never in this repo. Its own `id` and `label` name it.
//
// The wire shape is the API contract's, which is not the bundle's shape — the bundle calls
// them `leetcodeSlug` / `leetcodeProblemNumber`. Translate once, here.

import fs from 'node:fs';
import { registerCodingSlug } from './storage-layout.mjs';

/** @returns the public per-problem object exactly as the contract specifies it. */
function toPublic(record, store, collection = null, interviewPrep = null) {
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
      ...(collection ? { [collection.id]: Boolean(interviewPrep) } : {}),
    },
    isPro: record.isPro === true,
    leetcodePremium: record.leetcodePremium === true || interviewPrep?.premium === true,
    tags: interviewPrep && collection ? [collection.id] : [],
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
  if (interviewPrep) entry.interviewPrep = interviewPrep;
  return entry;
}

export class Catalog {
  /**
   * @param catalogJson the NeetCode bundle
   * @param store       the vendored-solution index
   * @param interview  optional private practice collection ({ id, label, problems })
   */
  constructor(catalogJson, store, interview = null, added = []) {
    if (interview) checkCollection(interview);
    const collection = interview ? {
      id: interview.id, label: interview.label,
      note: interview.note ?? interview.disclaimer ?? null,
      checkedAt: interview.checkedAt ?? null,
    } : null;
    const records = Array.isArray(catalogJson.problems) ? catalogJson.problems : [];

    this.allPatterns = [];
    const seenAll = new Set();
    for (const r of records) {
      if (r.pattern && !seenAll.has(r.pattern)) {
        seenAll.add(r.pattern);
        this.allPatterns.push(r.pattern);
      }
    }

    const curated = new Map((interview?.problems ?? []).map((p) => [p.slug, p]));
    const byRecord = new Map(records.filter((r) => r.leetcodeSlug).map((r) => [r.leetcodeSlug, r]));
    const selected = records.filter((r) => r.lists?.neetcode250 === true);
    for (const p of curated.values()) {
      if (byRecord.has(p.slug)) {
        const existing = byRecord.get(p.slug);
        if (!selected.includes(existing)) selected.push(existing);
      } else selected.push({
        leetcodeSlug: p.slug, leetcodeProblemNumber: p.number ?? null, title: p.title ?? p.slug,
        pattern: p.pattern ?? null, difficulty: p.difficulty ?? null,
        lists: {}, isPro: false, leetcodePremium: p.premium === true,
        neetcodeSlug: null, solutionCodeStem: null, youtubeVideoId: null,
      });
    }

    this.problems = [];
    this.bySlug = new Map();
    this.patterns = [];
    // Keep the original curriculum separate from curated collection membership.
    this.neetcode250 = [];
    const seen = new Set();

    const emitted = new Set();
    for (const r of selected) {
      if (!r.leetcodeSlug) continue;
      if (emitted.has(r.leetcodeSlug)) continue;
      emitted.add(r.leetcodeSlug);
      const prep = curated.get(r.leetcodeSlug) ?? null;
      const entry = toPublic(r, store, collection, prep);
      this.problems.push(entry);
      this.bySlug.set(entry.slug, entry);
      if (r.lists?.neetcode250 === true) this.neetcode250.push(entry);
      if (r.lists?.neetcode250 === true && entry.pattern && !seen.has(entry.pattern)) {
        seen.add(entry.pattern);
        this.patterns.push(entry.pattern); // first-appearance order == NeetCode's order
      }
      if (r.lists?.added === true) entry.lists.added = true;
      if (r.lists?.others === true) entry.lists.others = true;
    }

    this.source = catalogJson.source?.bundleURL ?? catalogJson.source?.site ?? null;
    this.totalRecords = records.length;
    this.interviewPrep = interview ?? null;
    this.collection = collection;
    for (const record of added) {
      // Records from before source labels existed are learner-added by definition.
      const lists = record.lists ?? {};
      const normalized = lists.added !== true && lists.others !== true
        ? { ...record, lists: { ...lists, added: true } } : record;
      this.add(normalized, store);
    }
  }

  get(slug) {
    return this.bySlug.get(slug) ?? null;
  }

  add(record, store) {
    registerCodingSlug(record.leetcodeSlug);
    if (this.bySlug.has(record.leetcodeSlug)) return this.bySlug.get(record.leetcodeSlug);
    const lists = { ...(record.lists ?? {}) };
    if (lists.added !== true && lists.others !== true) lists.added = true;
    const entry = toPublic({ ...record, lists }, store, this.collection ? { id: this.collection.id } : null, null);
    if (lists.added === true) entry.lists.added = true;
    if (lists.others === true) entry.lists.others = true;
    this.problems.push(entry); this.bySlug.set(entry.slug, entry);
    return entry;
  }
}

const BUILT_IN_LISTS = new Set(['blind75', 'neetcode150', 'neetcode250', 'added', 'others']);

function checkCollection(c) {
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.id) || BUILT_IN_LISTS.has(c.id)) {
    throw new Error(`collection id must be a lowercase slug that is not a built-in list, got ${JSON.stringify(c.id)}`);
  }
  if (typeof c.label !== 'string' || !c.label.trim()) throw new Error('collection needs a label');
  if (!Array.isArray(c.problems)) throw new Error('collection needs a problems array');
}

/**
 * @param collectionFile the private collection, or null for none. A missing file is
 *   normal (most workspaces have none); a malformed one is an error, not silently dropped.
 */
export function loadCatalog(catalogFile, store, collectionFile = null, addedFile = null) {
  const json = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  let interview = null;
  if (collectionFile) {
    try { interview = JSON.parse(fs.readFileSync(collectionFile, 'utf8')); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  let added = [];
  if (addedFile) { try { added = JSON.parse(fs.readFileSync(addedFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  if (!Array.isArray(added)) throw new Error('The saved problem list is malformed.');
  return new Catalog(json, store, interview, added);
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
