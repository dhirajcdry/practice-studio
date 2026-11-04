import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { disciplineForSlug, problemDir, memoryPath, workspacePath } from '../storage-layout.mjs';
import { excerpt } from './context-policy.mjs';
export const MEMORY_SCOPES = Object.freeze(['problem', 'learner', 'coding', 'lld', 'design']);
export function legacyMemoryFile(root, discipline) {
  const file={coding:'TUTOR.md',lld:'LLD.md',design:'DESIGN.md'}[discipline];
  if(!file)throw new Error('Invalid legacy memory scope.');
  return workspacePath(root,path.join(root,file));
}
export async function readAgentMemory(root, slug, { includeProblem = true, query = '' } = {}) {
  const discipline = disciplineForSlug(slug), out = [];
  const sources = [
    ['learner', memoryFile(root, slug, 'learner'), 1800],
    [discipline, memoryFile(root, slug, discipline), 3000],
    ...(includeProblem ? [['problem', memoryFile(root, slug, 'problem'), 4000]] : []),
    // Existing hand-written memory is still useful, but only in its own discipline.
    ['legacy discipline notes', legacyMemoryFile(root,discipline), 2000],
  ];
  for (const [scope,file,cap] of sources) { try {
    const text=await fsp.readFile(file,'utf8');
    if(text.trim()) out.push(`## ${scope} (${path.relative(root,file)})\n${excerpt(text,cap,query)}`);
  } catch(e) { if(e.code!=='ENOENT') throw e; } }
  return out.join('\n\n');
}
export function memoryFile(root, slug, scope) {
  if (!MEMORY_SCOPES.includes(scope)) throw new Error('Invalid memory scope.');
  disciplineForSlug(slug);
  return scope==='problem'?workspacePath(root,path.join(problemDir(root,slug),'NOTES.md')):memoryPath(root,scope);
}

const memoryWrites = new Map();
export async function withMemoryLock(file, fn) {
  // Legacy aliases and macOS /var -> /private/var must share the same lock.
  let probe=path.resolve(file);const suffix=[];
  while(true) {
    try { file=path.join(fs.realpathSync(probe),...suffix);break; }
    catch(e) { if(e.code!=='ENOENT')throw e;const parent=path.dirname(probe);if(parent===probe)throw e;suffix.unshift(path.basename(probe));probe=parent; }
  }
  const next = (memoryWrites.get(file) || Promise.resolve()).catch(() => {}).then(fn);
  memoryWrites.set(file, next);
  try { return await next; } finally { if (memoryWrites.get(file) === next) memoryWrites.delete(file); }
}
