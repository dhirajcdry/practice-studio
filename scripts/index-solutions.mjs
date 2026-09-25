#!/usr/bin/env node
/**
 * Build a path-only index of the vendored NeetCode solutions repo.
 *
 * Input : studio/vendor/neetcode-solutions   (shallow clone of neetcode-gh/leetcode)
 * Output: studio/data/solutions-index.json
 *
 * The index maps a normalized problem stem ("0001-two-sum") to
 * { language: "<path relative to the vendor root>" }. File contents are never
 * embedded; the app reads the files on demand.
 *
 * Node 23, ESM, zero dependencies.  Run: node studio/scripts/index-solutions.mjs
 */

import { readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const STUDIO = resolve(HERE, "..");
const VENDOR_ROOT = join(STUDIO, "vendor", "neetcode-solutions");
const OUT_FILE = join(STUDIO, "data", "solutions-index.json");

const REPO_URL = "https://github.com/neetcode-gh/leetcode";
const CLONE_DATE = "2026-07-25";

/** Top-level directory -> language id, plus the extensions we expect inside. */
const LANGUAGE_DIRS = {
  c: { language: "c", ext: [".c"] },
  cpp: { language: "cpp", ext: [".cpp"] },
  csharp: { language: "csharp", ext: [".cs"] },
  dart: { language: "dart", ext: [".dart"] },
  go: { language: "go", ext: [".go"] },
  java: { language: "java", ext: [".java"] },
  javascript: { language: "javascript", ext: [".js"] },
  kotlin: { language: "kotlin", ext: [".kt"] },
  python: { language: "python", ext: [".py"] },
  ruby: { language: "ruby", ext: [".rb"] },
  rust: { language: "rust", ext: [".rs"] },
  scala: { language: "scala", ext: [".scala"] },
  swift: { language: "swift", ext: [".swift"] },
  typescript: { language: "typescript", ext: [".ts"] },
};

/** Canonical filename shape: 4-digit problem number + hyphenated slug. */
const CONFORMING = /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Normalize a bare filename (no extension) into an index key.
 * Lowercases (the repo mixes `0075-Sort-colors` and `0075-sort-colors`) and
 * folds underscores to hyphens (`0904_fruit_into_baskets`).
 */
function toStem(base) {
  return base.toLowerCase().replace(/_/g, "-");
}

function splitExt(name) {
  const i = name.lastIndexOf(".");
  if (i <= 0) return [name, ""];
  return [name.slice(0, i), name.slice(i)];
}

function gitInfo(root) {
  const run = (...args) =>
    execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  try {
    return {
      commit: run("rev-parse", "HEAD"),
      commitDate: run("log", "-1", "--format=%cI"),
    };
  } catch {
    return { commit: null, commitDate: null };
  }
}

function main() {
  if (!existsSync(VENDOR_ROOT)) {
    console.error(`Vendor clone not found at ${VENDOR_ROOT}`);
    process.exit(1);
  }

  /** stem -> { language -> relative path } */
  const index = Object.create(null);
  const languageCounts = Object.create(null);
  const nonconforming = [];
  const conflicts = []; // same stem + same language reachable from two files
  const unexpectedExt = [];
  let fileCount = 0;

  for (const dir of Object.keys(LANGUAGE_DIRS).sort()) {
    const abs = join(VENDOR_ROOT, dir);
    if (!existsSync(abs)) continue;
    const { language, ext: expected } = LANGUAGE_DIRS[dir];
    languageCounts[language] = 0;

    for (const name of readdirSync(abs).sort()) {
      const full = join(abs, name);
      if (!statSync(full).isFile()) continue;
      if (name.startsWith(".")) continue;

      const [base, ext] = splitExt(name);
      const relPath = `${dir}/${name}`;
      const stem = toStem(base);

      if (!CONFORMING.test(stem)) nonconforming.push(relPath);
      if (!expected.includes(ext)) unexpectedExt.push(relPath);

      const entry = (index[stem] ??= Object.create(null));
      if (entry[language]) {
        // Two on-disk files normalize to the same (stem, language).
        // Prefer the one carrying the expected extension, then the shorter path.
        const kept = expected.includes(ext) && !expected.includes(splitExt(entry[language])[1])
          ? relPath
          : entry[language];
        const dropped = kept === relPath ? entry[language] : relPath;
        conflicts.push({ stem, language, kept, dropped });
        entry[language] = kept;
      } else {
        entry[language] = relPath;
        languageCounts[language] += 1;
      }
      fileCount += 1;
    }
  }

  const stems = Object.keys(index).sort();
  const sorted = Object.create(null);
  for (const s of stems) {
    const langs = Object.keys(index[s]).sort();
    const m = Object.create(null);
    for (const l of langs) m[l] = index[s][l];
    sorted[s] = m;
  }

  const withPython = stems.filter((s) => sorted[s].python).length;
  const { commit, commitDate } = gitInfo(VENDOR_ROOT);

  const out = {
    source: {
      repo: REPO_URL,
      commit,
      commitDate,
      clonedAt: CLONE_DATE,
      vendorPath: "studio/vendor/neetcode-solutions",
      pathsRelativeTo: "vendor root (studio/vendor/neetcode-solutions)",
    },
    license: {
      spdx: "MIT",
      copyright: "Copyright (c) 2022 neetcode-gh",
      file: "LICENSE",
      attributionRequirement:
        "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.",
      notice:
        "Solutions from neetcode-gh/leetcode, MIT licensed, Copyright (c) 2022 neetcode-gh.",
    },
    counts: {
      stems: stems.length,
      files: fileCount,
      indexedFiles: Object.values(languageCounts).reduce((a, b) => a + b, 0),
      languages: Object.keys(languageCounts).length,
      stemsWithPython: withPython,
      byLanguage: languageCounts,
    },
    anomalies: {
      nonconformingFilenames: nonconforming,
      normalizationConflicts: conflicts,
      unexpectedExtensions: unexpectedExt,
    },
    solutions: sorted,
  };

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n");

  console.log(`commit           ${commit}`);
  console.log(`stems            ${stems.length}`);
  console.log(`files scanned    ${fileCount}`);
  console.log(`stems w/ python  ${withPython} (${((withPython / stems.length) * 100).toFixed(1)}%)`);
  console.log("languages:");
  for (const [l, n] of Object.entries(languageCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${l.padEnd(12)} ${n}`);
  }
  console.log(`nonconforming    ${nonconforming.length}`);
  for (const f of nonconforming.slice(0, 10)) console.log(`  ${f}`);
  console.log(`conflicts        ${conflicts.length}`);
  for (const c of conflicts) console.log(`  ${c.stem} [${c.language}] kept ${c.kept} dropped ${c.dropped}`);
  console.log(`unexpected ext   ${unexpectedExt.length}`);
  for (const f of unexpectedExt.slice(0, 10)) console.log(`  ${f}`);
  console.log(`wrote ${OUT_FILE}`);
}

main();
