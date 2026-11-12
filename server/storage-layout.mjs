import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DISCIPLINES = new Set(['coding', 'lld', 'design']);
// LeetCode has real problems named "Design Twitter", "Design HashMap", etc.
// The catalog is authoritative; a title prefix is not an interview discipline.
const CODING_SLUGS = new Set(JSON.parse(fs.readFileSync(new URL('../data/catalog.json',import.meta.url),'utf8')).problems.map(p=>p.leetcodeSlug));

function assertRoot(root) {
  if (typeof root !== 'string' || !root) throw new TypeError('A workspace root is required.');
  return path.resolve(root);
}

function assertSlug(slug) {
  if (typeof slug !== 'string' || slug.length > 100 || !SLUG_RE.test(slug)) throw new Error('Invalid problem slug.');
}

// Runtime catalog additions are LeetCode identities too, including design-* names.
export function registerCodingSlug(slug) {
  assertSlug(slug);
  CODING_SLUGS.add(slug);
}

export function disciplineForSlug(slug) {
  assertSlug(slug);
  if(CODING_SLUGS.has(slug))return 'coding';
  return slug.startsWith('lld-') ? 'lld' : slug.startsWith('design-') ? 'design' : 'coding';
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function checkedRealpath(root, candidate) {
  const resolved = path.resolve(candidate);
  if (!inside(root, resolved)) throw new Error('Storage path escapes workspace root.');
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let probe = resolved;
  while (true) {
    try {
      const real = fs.realpathSync(probe);
      if (!inside(realRoot, real)) throw new Error('Storage symlink escapes workspace root.');
      return probe === resolved ? real : null;
    } catch (error) {
      if (error.code === 'ENOTDIR') return null;
      if (error.code !== 'ENOENT') throw error;
      try {
        if (fs.lstatSync(probe).isSymbolicLink()) throw new Error('Storage contains an unresolved symlink.');
      } catch (linkError) { if (linkError.code !== 'ENOENT') throw linkError; }
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
}

// Validate the final file, not just its containing problem directory. Existing
// internal migration aliases are allowed; external and dangling links are not.
export function workspacePath(rootInput, candidate) {
  const root = assertRoot(rootInput);
  return checkedRealpath(root, candidate) || path.resolve(candidate);
}

function candidatePaths(root, slug) {
  const discipline = disciplineForSlug(slug);
  return {
    canonical: path.join(root, 'tracks', discipline, 'problems', slug),
    legacy: path.join(root, 'problems', slug),
  };
}

export function problemDir(rootInput, slug) {
  const root = assertRoot(rootInput); assertSlug(slug);
  const { canonical, legacy } = candidatePaths(root, slug);
  const canonicalReal = checkedRealpath(root, canonical);
  const legacyReal = checkedRealpath(root, legacy);
  if (canonicalReal && legacyReal && canonicalReal !== legacyReal) throw new Error(`Ambiguous storage locations for ${slug}.`);
  return canonicalReal || legacyReal ? (canonicalReal ? canonical : legacy) : canonical;
}

export async function listProblemSlugs(rootInput, { discipline } = {}) {
  const root = assertRoot(rootInput);
  if (discipline !== undefined && !DISCIPLINES.has(discipline)) throw new Error('Invalid discipline.');
  const found = new Map();
  async function scan(dir) {
    workspacePath(root, dir);
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!SLUG_RE.test(entry.name) || (discipline && disciplineForSlug(entry.name) !== discipline)) continue;
      const slug = entry.name;
      // problemDir performs the containment, symlink, and ambiguity checks.
      const dirPath = problemDir(root, slug);
      if (checkedRealpath(root, dirPath)) found.set(slug, dirPath);
    }
  }
  if (discipline) await scan(path.join(root, 'tracks', discipline, 'problems'));
  else for (const d of DISCIPLINES) await scan(path.join(root, 'tracks', d, 'problems'));
  await scan(path.join(root, 'problems'));
  return [...found.keys()].sort();
}

export function memoryPath(rootInput, scopeInput) {
  const root = assertRoot(rootInput);
  const scope = scopeInput === 'learner' ? 'learner' : scopeInput;
  const discipline = scope === 'learner' || scope === 'coding' ? 'coding' : scope;
  if (scope !== 'learner' && !DISCIPLINES.has(discipline)) throw new Error('Invalid memory scope.');
  const canonical = scope === 'learner'
    ? path.join(root, 'shared', 'learner.md')
    : path.join(root, 'tracks', discipline, 'MEMORY.md');
  const legacy = path.join(root, 'memory', `${scope === 'learner' ? 'learner' : discipline}.md`);
  const canonicalReal=checkedRealpath(root,canonical), legacyReal=checkedRealpath(root,legacy);
  if(canonicalReal&&legacyReal&&canonicalReal!==legacyReal)throw new Error(`Ambiguous memory locations for ${scope}.`);
  return canonicalReal?canonical:legacyReal?legacy:canonical;
}

export { SLUG_RE };
