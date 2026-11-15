// A fresh round starts every coding problem on its starter code.
//
// Resetting the tracker moves each problem's saved solution.py into
// `archive/sprint-code/<reset>/<slug>/solution.py` with a manifest, so the editor opens on
// the starter and nothing is deleted. Undoing that reset moves each file back, unless you
// have written new code for that problem since; then yours stays and the archived copy is
// kept beside it. Submissions, attempts, chats and notes are never touched.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { listProblemSlugs, problemDir } from '../storage-layout.mjs';

const MANIFEST = 'manifest.json';

export function shelfDir(root, resetAt) {
  return path.join(root, 'archive', 'sprint-code', String(resetAt).replace(/[:.]/g, '-'));
}

async function statOrNull(file) {
  try { return await fsp.stat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Move every coding problem's saved code to the shelf for this reset. Returns the slugs moved. */
export async function shelveCode(root, resetAt) {
  const shelf = shelfDir(root, resetAt);
  const moved = [];
  for (const slug of await listProblemSlugs(root, { discipline: 'coding' })) {
    const from = path.join(problemDir(root, slug), 'solution.py');
    const stat = await statOrNull(from);
    if (!stat?.isFile()) continue;
    const to = path.join(shelf, slug, 'solution.py');
    await fsp.mkdir(path.dirname(to), { recursive: true });
    // Copy, verify, then remove: a failure part way leaves the code where it was.
    await fsp.copyFile(from, to, fsp.constants.COPYFILE_EXCL);
    await fsp.utimes(to, stat.atime, stat.mtime);
    const [a, b] = await Promise.all([fsp.readFile(from), fsp.readFile(to)]);
    if (!a.equals(b)) throw new Error(`The archived copy of ${slug} does not match.`);
    await fsp.unlink(from);
    moved.push(slug);
  }
  if (moved.length) {
    await fsp.writeFile(path.join(shelf, MANIFEST), JSON.stringify({ resetAt, shelvedAt: new Date().toISOString(), slugs: moved }, null, 2) + '\n', { flag: 'wx' });
  }
  return moved;
}

/** Put the code shelved by this reset back. Returns { restored, kept } slug lists. */
export async function unshelveCode(root, resetAt) {
  const shelf = shelfDir(root, resetAt);
  let manifest;
  try { manifest = JSON.parse(await fsp.readFile(path.join(shelf, MANIFEST), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { restored: [], kept: [] }; throw error; }
  const restored = [], kept = [];
  for (const slug of Array.isArray(manifest.slugs) ? manifest.slugs : []) {
    const from = path.join(shelf, slug, 'solution.py');
    if (!(await statOrNull(from))) continue;
    const to = path.join(problemDir(root, slug), 'solution.py');
    if (await statOrNull(to)) { kept.push(slug); continue; }
    await fsp.mkdir(path.dirname(to), { recursive: true });
    await fsp.rename(from, to);
    await fsp.rmdir(path.dirname(from)).catch(() => {});
    restored.push(slug);
  }
  await fsp.writeFile(path.join(shelf, MANIFEST), JSON.stringify({ ...manifest, restoredAt: new Date().toISOString(), restored, kept }, null, 2) + '\n');
  return { restored, kept };
}
