// Fill the LeetCode content cache, so a plane, a hotel, or a dead router costs nothing.
//
//   node scripts/warm-cache.mjs            fetch whatever is missing
//   node scripts/warm-cache.mjs --check    report only; never touches the network
//   node scripts/warm-cache.mjs --delay=3000
//   node scripts/warm-cache.mjs --only=two-sum,3sum
//
// The cache is lazy by design: a problem is fetched the first time you open it and kept
// forever after. That is right for a machine that is always online and wrong for the first
// time you open a problem you have never opened before with no signal — which is when the
// description, the starting stub, and the example cases all fail at once, and there is
// nothing the app can do about it.
//
// So this walks the curriculum once, slowly, and asks for the ones that are missing.
//
// It is deliberately not a function inside server/leetcode.mjs. That file says a bulk
// pre-fetch is the one behaviour that would plausibly trip Cloudflare, and it is still
// right: this is a thing you run on purpose, attended, at a human pace — one request every
// 1.5s, sequential, and it stops dead the moment LeetCode signals a challenge rather than
// carrying on into a block. Resumable, so a stop costs only the problems not yet done.
//
// What it checks is not "is there a file" but "is this file enough to work offline":
// a statement, a python stub, and metaData. A cached premium problem is a real answer from
// LeetCode and is kept, but it is counted honestly as something that will not open.

import { LEETCODE_CACHE_DIR, CATALOG_FILE, SOLUTIONS_INDEX_FILE, VENDOR_ROOT } from '../server/paths.mjs';
import { LeetCodeContentCache, LeetCodeError, toContent } from '../server/leetcode.mjs';
import { loadSolutionStore } from '../server/solutions.mjs';
import { loadCatalog } from '../server/catalog.mjs';

const args = process.argv.slice(2);
const has = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : fallback;
};

const CHECK_ONLY = has('--check');
const DELAY_MS = Number(valueOf('--delay', '1500'));
const ONLY = valueOf('--only', '').split(',').map((s) => s.trim()).filter(Boolean);
const RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// LeetCode's answer decides what happens next, and the three cases are different.
//
// Stop entirely: the ones that mean "you are being blocked". Carrying on from here is how a
// polite script becomes the thing that gets an IP challenged for a week.
const FATAL_KINDS = new Set(['challenged', 'rate-limited', 'not-json', 'http-error']);
// Worth another go: a flaky connection is not a refusal.
const RETRY_KINDS = new Set(['network']);
// Everything else — a slug LeetCode does not know, a query it rejected — is about that one
// problem. Note it and move on.

/**
 * Is this cached copy enough to open the problem with the network unplugged?
 *
 * A file on disk is not the question. The page needs a statement to read, the editor needs
 * a python stub, and the runner needs metaData; a record missing any of them will fail in
 * exactly the way this script exists to prevent.
 */
function readiness(content) {
  if (!content) return { ready: false, why: 'nothing cached' };
  if (content.isPaidOnly) return { ready: false, why: 'premium — LeetCode returns no statement' };
  const missing = [];
  if (!content.descriptionHtml) missing.push('statement');
  const python = (content.codeSnippets ?? []).find((s) => s?.langSlug === 'python3');
  if (!python?.code) missing.push('python stub');
  if (!content.metaData) missing.push('metaData');
  return missing.length ? { ready: false, why: `no ${missing.join(', no ')}` } : { ready: true, why: '' };
}

const store = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);
const catalog = loadCatalog(CATALOG_FILE, store);
const cache = new LeetCodeContentCache({ cacheDir: LEETCODE_CACHE_DIR });

const wanted = ONLY.length
  ? catalog.problems.filter((p) => ONLY.includes(p.slug))
  : catalog.problems;

if (ONLY.length && wanted.length !== ONLY.length) {
  const found = new Set(wanted.map((p) => p.slug));
  console.error(`not in the catalog: ${ONLY.filter((s) => !found.has(s)).join(', ')}`);
}

/* ------------------------------- what is on disk ------------------------------- */

const ready = [];
const notReady = [];   // cached, but will not open — premium, or missing a piece
const absent = [];

for (const problem of wanted) {
  const record = await cache.readCache(problem.slug);
  if (!record) { absent.push(problem); continue; }
  // toContent is what the app actually sees, so ask the same question the app asks.
  const verdict = readiness(toContent(record.question, { fetchedAt: record.fetchedAt }));
  if (verdict.ready) ready.push(problem);
  else notReady.push({ problem, why: verdict.why });
}

const report = () => {
  console.log('');
  console.log(`  ready offline   ${ready.length} / ${wanted.length}`);
  if (notReady.length) console.log(`  cached but not usable   ${notReady.length}`);
  if (absent.length) console.log(`  never fetched   ${absent.length}`);
  console.log(`  cache   ${LEETCODE_CACHE_DIR}`);
};

if (CHECK_ONLY) {
  report();
  if (notReady.length) {
    console.log('\ncached but will not open offline:');
    for (const { problem, why } of notReady) console.log(`  ${problem.slug} — ${why}`);
  }
  if (absent.length) {
    console.log(`\nnever fetched (${absent.length}):`);
    for (const problem of absent.slice(0, 20)) console.log(`  ${problem.slug}`);
    if (absent.length > 20) console.log(`  …and ${absent.length - 20} more`);
    console.log('\nRun `npm run warm` with a connection to fetch them.');
  }
  process.exit(absent.length ? 1 : 0);
}

/* --------------------------------- fetching --------------------------------- */

if (absent.length === 0) {
  console.log('Nothing to fetch — every problem in the catalog is already cached.');
  report();
  process.exit(0);
}

console.log(`${ready.length} of ${wanted.length} problems are ready offline.`);
console.log(`Fetching ${absent.length}, one every ${DELAY_MS}ms — about ${Math.ceil((absent.length * DELAY_MS) / 60000)} minutes.`);
console.log('Ctrl-C is safe: each problem is written as it arrives, and re-running picks up where it stopped.\n');

let fetched = 0;
let failed = 0;
let stoppedEarly = null;

for (const [index, problem] of absent.entries()) {
  const at = `${String(index + 1).padStart(3)}/${absent.length}`;
  let lastError = null;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    try {
      // The same call the app makes when you open the problem — cache-first, so a slug
      // that arrived some other way since this script started is not re-fetched.
      const result = await cache.getContent(problem.slug);
      const verdict = readiness(result.content);
      fetched += 1;
      console.log(`  ${at}  ${problem.slug}${verdict.ready ? '' : `  — cached, but ${verdict.why}`}`);
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
      const kind = err instanceof LeetCodeError ? err.kind : 'network';
      if (!RETRY_KINDS.has(kind)) break;             // a refusal is not worth repeating
      if (attempt < RETRIES) await sleep(DELAY_MS * (attempt + 2));
    }
  }

  if (lastError) {
    const kind = lastError instanceof LeetCodeError ? lastError.kind : 'network';
    failed += 1;
    console.log(`  ${at}  ${problem.slug}  — FAILED (${kind}): ${lastError.message}`);
    if (FATAL_KINDS.has(kind)) { stoppedEarly = { kind, message: lastError.message }; break; }
  }

  if (index < absent.length - 1) await sleep(DELAY_MS);
}

console.log('');
if (stoppedEarly) {
  console.log(`Stopped after ${fetched} — LeetCode answered with "${stoppedEarly.kind}".`);
  console.log('Nothing was lost. Leave it a while and run this again; it resumes.');
} else {
  console.log(`Fetched ${fetched}${failed ? `, ${failed} failed` : ''}.`);
}
console.log('Run `node scripts/warm-cache.mjs --check` to see where you stand.');
process.exit(stoppedEarly || failed ? 1 : 0);
