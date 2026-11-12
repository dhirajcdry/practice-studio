#!/usr/bin/env node
// Blocks personal data from reaching this PUBLIC repo, whichever agent or person commits.
//
//   node scripts/privacy-scan.mjs --staged        (pre-commit hook: added lines in the index)
//   node scripts/privacy-scan.mjs --range A..B    (pre-push hook / CI: added lines in commits)
//   node scripts/privacy-scan.mjs --all           (every line of every tracked file)
//
// Only ADDED lines are checked in --staged/--range, so existing, reviewed text never blocks.
// Private terms (target companies, recruiter names, emails) live OUTSIDE this repo, one per
// line, in $STUDIO_PRIVATE_TERMS or ~/NextSteps/.private-terms.txt, so the list itself
// is never published. Without that file only the generic patterns below run (as in CI).
//
// A line that is deliberately public can end with the marker `privacy-ok`. New images need
// STUDIO_PRIVACY_ALLOW=images, and only after Dhiraj confirms they come from a demo workspace.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IMAGE = /\.(png|jpe?g|gif|webp|heic|mp4|mov|webm)$/i;
// Paths where committed images are expected and reviewed (themes, vendored bundles).
const IMAGE_OK = [/^web\/img\/themes\//, /^web\/vendor\//];
// Personal-data file names that must never be tracked here.
const PRIVATE_FILES = [/(^|\/)collection(-[^/]*)?\.json$/, /\.private\./, /(^|\/)private-terms/, /^data\/(?!catalog\.json$|solutions-index\.json$)[^/]+\.json$/];
const PRIVATE_FILE_OK = [/^server\/test\/fixtures\//];

const GENERIC = [
  { why: 'an email address', re: /[A-Za-z0-9._%+-]+@(?![A-Za-z0-9.-]*\bexample\.)(?!(?:users\.noreply\.github|anthropic|openai)\.)[A-Za-z0-9-]+\.[A-Za-z.]{2,}/ },
  { why: 'an absolute home path', re: /\/Users\/(?!x\/|me\/|you\/|name\/|runner\/)[A-Za-z0-9._-]+\// },
  { why: 'a real Tailscale hostname', re: /\b(?!writer\.example\.)[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b/i },
];

function privateTerms() {
  const file = process.env.STUDIO_PRIVATE_TERMS || path.join(os.homedir(), 'NextSteps', '.private-terms.txt');
  try {
    return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  } catch { return []; }
}

function git(args) { return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }); }

/** [{ file, line, text }] for every added line, plus the list of added/changed files. */
function addedLines(mode, range) {
  const out = [];
  if (mode === 'all') {
    const files = git(['ls-files', '-z']).split('\0').filter(Boolean);
    for (const file of files) {
      if (IMAGE.test(file) || file.startsWith('web/vendor/') || file === 'data/catalog.json' || file === 'data/solutions-index.json') continue;
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      text.split('\n').forEach((t, i) => out.push({ file, line: i + 1, text: t }));
    }
    return { lines: out, files, existing: true };
  }
  const base = mode === 'staged' ? ['diff', '--cached'] : ['diff', range];
  const files = git([...base, '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
  let file = null, line = 0;
  for (const raw of git([...base, '--unified=0', '--no-color', '--diff-filter=ACMR']).split('\n')) {
    if (raw.startsWith('+++ ')) { file = raw.slice(4).replace(/^b\//, ''); continue; }
    const hunk = raw.match(/^@@ -\S+ \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith('+') && file) out.push({ file, line: line++, text: raw.slice(1) });
  }
  return { lines: out, files };
}

export function scan({ lines, files, existing = false }, terms = [], allow = '') {
  const problems = [];
  const skip = f => f.startsWith('web/vendor/') || f === 'data/catalog.json' || f === 'data/solutions-index.json' || f === 'scripts/privacy-scan.mjs' || f === 'server/test/privacy-scan.test.mjs';
  for (const f of files) {
    if (PRIVATE_FILES.some(re => re.test(f)) && !PRIVATE_FILE_OK.some(re => re.test(f))) problems.push(`${f}: looks like a personal data file; keep it in STUDIO_HOME`);
    if (!existing && IMAGE.test(f) && !IMAGE_OK.some(re => re.test(f)) && !allow.split(',').includes('images')) problems.push(`${f}: new image; confirm it comes from a demo workspace, then commit with STUDIO_PRIVACY_ALLOW=images`);
  }
  const termRes = terms.map(t => ({ why: `a private term ("${t}")`, re: new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') }));
  for (const { file, line, text } of lines) {
    if (skip(file) || /privacy-ok/.test(text)) continue;
    for (const { why, re } of [...GENERIC, ...termRes]) {
      if (re.test(text)) { problems.push(`${file}:${line}: ${why}`); break; }
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const mode = args.includes('--all') ? 'all' : args.includes('--range') ? 'range' : 'staged';
  const range = args[args.indexOf('--range') + 1];
  const problems = scan(addedLines(mode, range), privateTerms(), process.env.STUDIO_PRIVACY_ALLOW || '');
  if (problems.length) {
    console.error('\nprivacy-scan: this repo is PUBLIC. Blocked:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nMove personal data to STUDIO_HOME (InterviewPrep/data/leetcode-tutor/), or use a neutral fixture.');
    console.error('If a line is genuinely public, end it with `privacy-ok`. Never bypass with --no-verify. See AGENTS.md "Public repo".\n');
    process.exit(1);
  }
}
