// Rebuild every attempt document from the raw logs.
//
//   node scripts/rebuild-attempts.mjs                 every problem
//   node scripts/rebuild-attempts.mjs search-a-2d-matrix
//   node scripts/rebuild-attempts.mjs --dry           print, write nothing
//
// The attempt document is derived, so this is always safe to run: it reads the session
// logs, transcripts, snapshots, submissions and chats, and writes only
// `attempts/<attemptId>/attempt.md`. Nothing it reads is ever modified. If the assembler
// changes, run this and every attempt you have ever done is re-rendered.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { HOME_ROOT, CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from '../server/paths.mjs';
import { gatherAttempt, listAttempts } from '../server/attempts/assemble.mjs';
import { renderAttempt } from '../server/attempts/render.mjs';
import { loadSolutionStore } from '../server/solutions.mjs';
import { loadCatalog } from '../server/catalog.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const only = args.filter((a) => !a.startsWith('--'));

const catalog = loadCatalog(CATALOG_FILE, loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT));

const problemsDir = path.join(HOME_ROOT, 'problems');
let slugs;
try {
  slugs = (await fsp.readdir(problemsDir, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
} catch {
  console.error(`No workspace at ${problemsDir}.`);
  process.exit(1);
}
if (only.length) slugs = slugs.filter((s) => only.includes(s));

let written = 0;
let problems = 0;
let skipped = 0;

for (const slug of slugs) {
  const ids = await listAttempts(HOME_ROOT, slug);
  if (ids.length === 0) continue;
  problems += 1;
  console.log(`\n${slug}  (${ids.length} attempt${ids.length === 1 ? '' : 's'})`);

  for (const attemptId of ids) {
    const attempt = await gatherAttempt({ root: HOME_ROOT, slug, attemptId });
    if (!attempt) { skipped += 1; console.log(`  ${attemptId}  — no start event, skipped`); continue; }

    const markdown = renderAttempt(attempt, { title: catalog.get(slug)?.title ?? slug });
    // The id is an ISO instant; ':' and '.' are legal on macOS but miserable everywhere.
    const dirName = attemptId.replace(/[:.]/g, '-');
    const outDir = path.join(problemsDir, slug, 'attempts', dirName);
    const outFile = path.join(outDir, 'attempt.md');

    const spoken = attempt.speech.length;
    const runs = attempt.events.filter((e) => e.type === 'run_result').length;
    const subs = attempt.submissions.length;
    console.log(
      `  ${attemptId}  ${String(runs).padStart(2)} runs  ${subs} submitted  `
      + `${String(spoken).padStart(2)} recordings  →  ${Math.round(markdown.length / 1024)}KB`,
    );

    if (DRY) continue;
    await fsp.mkdir(outDir, { recursive: true });
    await fsp.writeFile(outFile, markdown, 'utf8');
    written += 1;
  }
}

console.log('');
if (DRY) console.log(`Would write ${problems} problems' attempts. Nothing was written.`);
else console.log(`Wrote ${written} attempt documents across ${problems} problems${skipped ? `, ${skipped} skipped` : ''}.`);
