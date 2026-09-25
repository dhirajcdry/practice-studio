// The live mirror: a dated Markdown file, updated as you work. Off unless
// STUDIO_MIRROR_DIR names a folder — an iCloud Drive folder is the intended use, so the
// day's summary reaches your other devices even if the laptop closes mid-session.
//
// The laptop can close at any moment, so this cannot wait for a daily job. It fires on
// every session event instead, debounced, and it is cheap enough to do that: the facts
// come from files already on disk, and the judgement comes from TUTOR.md, which the coach
// maintains live while it teaches. No model call happens here.
//
// It is a projection, not a copy. NOTES.md is written for the person mid-problem, in
// teaching voice; this is written for another agent that wants to know what he worked on
// and where he is stuck.

import fs from 'node:fs/promises';
import path from 'node:path';
import { buildStats } from '../stats/aggregate.mjs';

const SECTION = '## LeetCode';
const DEBOUNCE_MS = 1500;

/** Local date, not UTC — a session at 11pm belongs to that day, not tomorrow. */
export function localDateKey(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function clockOf(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

/** Problems touched today, by what actually happened to them. */
function todaysWork(stats, dateKey) {
  const touched = [];
  for (const p of stats.problems ?? []) {
    const days = new Set();
    for (const key of ['firstAt', 'lastAt']) {
      if (p[key]) days.add(String(p[key]).slice(0, 10));
    }
    if (Array.isArray(p.days)) p.days.forEach((d) => days.add(String(d).slice(0, 10)));
    if (days.has(dateKey)) touched.push(p);
  }
  return touched;
}

function describe(p) {
  const bits = [`${p.title} (#${p.number ?? '?'}, ${p.difficulty ?? '?'}, ${p.pattern ?? '?'})`];

  if (p.status === 'accepted') {
    // How many tries it took is the interesting part, not that it eventually passed.
    bits.push(p.rejectedCount > 0 ? `accepted after ${p.rejectedCount} rejected` : 'accepted first try');
  } else if (p.submissionCount > 0) {
    bits.push(`${p.submissionCount} submitted, none accepted`);
  } else if (p.status === 'local-pass') {
    bits.push('passes the examples, never submitted');
  } else if (p.runs > 0) {
    bits.push(`${p.runs} local runs, never submitted`);
  } else {
    bits.push('opened, no code run');
  }

  const rejected = (p.verdicts ?? []).filter((v) => v.verdict && v.verdict.toLowerCase() !== 'accepted');
  if (rejected.length) {
    const kinds = [...new Set(rejected.map((v) => v.verdict))];
    bits.push(kinds.join(', '));
  }
  if (p.revealedSolutionAt) bits.push('looked at the reference solution');
  return `- ${bits.join(' · ')}`;
}

/**
 * The open patterns the coach is currently tracking, taken verbatim from its own memory.
 *
 * Read, never re-derived. The coach writes this while it teaches; restating it in our own
 * words would be a second opinion pretending to be the same one.
 */
async function currentPatterns(root, limit = 3) {
  try {
    const text = await fs.readFile(path.join(root, 'TUTOR.md'), 'utf8');
    const start = text.indexOf('## Recurring Patterns');
    if (start === -1) return [];
    const rest = text.slice(start);
    const end = rest.indexOf('\n## ', 3);
    const body = end === -1 ? rest : rest.slice(0, end);

    // Bullets are "- **Claim.** evidence…" — the bolded claim is the headline.
    const items = [];
    for (const match of body.matchAll(/^- \*\*(.+?)\*\*/gms)) {
      items.push(match[1].replace(/\s+/g, ' ').trim());
    }
    return items.slice(-limit);
  } catch {
    return [];
  }
}

/** Think-aloud and debrief takes recorded today, across every problem. */
async function spokenToday(root, dateKey) {
  const out = { takes: 0, seconds: 0, slugs: [] };
  let slugs;
  try {
    slugs = await fs.readdir(path.join(root, 'problems'));
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const dir = path.join(root, 'problems', slug, 'transcripts');
    let names;
    try {
      names = (await fs.readdir(dir)).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    let hit = false;
    for (const name of names) {
      try {
        const take = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
        const at = typeof take?.recordedAt === 'string' ? new Date(take.recordedAt) : null;
        if (!at || localDateKey(at) !== dateKey) continue;
        out.takes += 1;
        out.seconds += Number(take?.durationSeconds) || 0;
        hit = true;
      } catch { /* a corrupt take is not worth a broken line */ }
    }
    if (hit) out.slugs.push(slug);
  }
  return out;
}

export async function renderSection({ root, catalog, now = new Date() }) {
  const dateKey = localDateKey(now);
  const stats = await buildStats({ root, catalog, now });
  const touched = todaysWork(stats, dateKey);
  const patterns = await currentPatterns(root);

  // "Solved today" means the verdict landed today — not that an already-solved problem
  // was opened again. Touching an old accepted problem is revision, and saying otherwise
  // would inflate the number every time he re-ran something.
  const on = (value) => typeof value === 'string' && value.slice(0, 10) === dateKey;
  const solved = touched.filter((p) => on(p.acceptedAt));
  const revisited = touched.filter((p) => p.status === 'accepted' && !on(p.acceptedAt));
  const open = touched.filter((p) => p.status !== 'accepted');

  const lines = [SECTION, `*live · updated ${clockOf(now)}*`, ''];

  if (touched.length === 0) {
    lines.push('Nothing worked on yet today.', '');
  } else {
    if (solved.length) {
      lines.push(`**Solved today** — ${solved.length}`, ...solved.map(describe), '');
    }
    if (open.length) {
      lines.push(`**Open / in progress** — ${open.length}`, ...open.map(describe), '');
    }
    if (revisited.length) {
      lines.push(
        `**Revisited** *(solved earlier)* — ${revisited.length}`,
        ...revisited.map((p) => `- ${p.title} (#${p.number ?? '?'}) · accepted ${String(p.acceptedAt).slice(0, 10)}`),
        '',
      );
    }
  }

  if (patterns.length) {
    lines.push('**What he is struggling with** *(the coach\'s own words)*');
    lines.push(...patterns.map((p) => `- ${p}`), '');
  }

  // Whether he is thinking out loud at all is itself a signal — an interview is spoken,
  // and silent practice does not rehearse the part being graded.
  const spoken = await spokenToday(root, dateKey);
  if (spoken.takes > 0) {
    lines.push(
      `**Thinking aloud** — ${spoken.takes} take${spoken.takes === 1 ? '' : 's'}, `
      + `${Math.round(spoken.seconds)}s total, on ${spoken.slugs.join(', ')}`,
      '',
    );
  } else {
    lines.push('**Thinking aloud** — nothing recorded today.', '');
  }

  const t = stats.totals ?? {};
  const started = (stats.patterns ?? []).filter((p) => (p.accepted ?? 0) > 0).length;
  lines.push(
    '**Overall** — '
    + `${t.accepted ?? 0} of ${stats.curriculum?.total ?? 250} solved · `
    + `${started} of ${(stats.patterns ?? []).length} patterns started · `
    + `${t.askedCoach ?? 0} coach questions logged`,
    '',
  );

  return lines.join('\n');
}

/**
 * Replace our section in the day's file, leaving every other section untouched.
 *
 * This file is shared: other trackers and the user himself write into the same day. Owning
 * one heading and nothing else is what makes that safe — a job that rewrites the whole
 * file would eventually eat someone's notes.
 */
export function spliceSection(existing, section) {
  const text = existing ?? '';
  const start = text.indexOf(`\n${SECTION}`);
  const atTop = text.startsWith(SECTION);
  const from = atTop ? 0 : start === -1 ? -1 : start + 1;

  if (from === -1) {
    const header = text.trim() ? text.replace(/\s*$/, '\n\n') : '';
    return `${header}${section}`;
  }

  const after = text.indexOf('\n## ', from + SECTION.length);
  if (after === -1) return `${text.slice(0, from)}${section}`;
  // Exactly one blank line before whoever writes next, so the file stays readable no
  // matter how many producers share it.
  const body = section.replace(/\s*$/, '\n\n');
  return `${text.slice(0, from)}${body}${text.slice(after + 1)}`;
}

async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file); // never let iCloud see a half-written file
}

export async function mirrorNow({ root, catalog, dir, now = new Date(), log = console } = {}) {
  const dateKey = localDateKey(now);
  const file = path.join(dir, `${dateKey}.md`);

  let existing = null;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  const section = await renderSection({ root, catalog, now });
  const heading = existing ? '' : `# ${dateKey}\n\n`;
  const next = heading + spliceSection(existing ?? '', section);

  if (existing === next) return { file, written: false };
  await writeAtomic(file, next);
  log.info?.(`[mirror] ${dateKey}.md updated`);
  return { file, written: true };
}

let timer = null;
let queued = false;

/** Debounced: a burst of events during one run should produce one write, not eight. */
export function scheduleMirror(options) {
  if (timer) { queued = true; return; }
  timer = setTimeout(async () => {
    timer = null;
    try {
      await mirrorNow(options);
    } catch (err) {
      // The mirror is a convenience. It must never take down the thing being mirrored.
      options?.log?.warn?.(`[mirror] could not update: ${err.message}`);
    }
    if (queued) { queued = false; scheduleMirror(options); }
  }, DEBOUNCE_MS);
  timer.unref?.();
}
