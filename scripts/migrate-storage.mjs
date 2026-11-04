#!/usr/bin/env node
// Dry-run by default. Move whole records, never rewrite their contents. Legacy
// aliases preserve references embedded in raw transcripts and external tooling.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { disciplineForSlug,listProblemSlugs,memoryPath,problemDir,workspacePath } from '../server/storage-layout.mjs';
import { isSafeInterviewId } from '../server/design/store.mjs';
const stat=async file=>{try{return await fs.lstat(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const same=async(a,b)=>{try{return await fs.realpath(a)===await fs.realpath(b);}catch{return false;}};
export async function planMigration(root) {
  const moves=[];
  async function add(from,to,identity) {
    workspacePath(root,from); workspacePath(root,to);
    const old=await stat(from), canonical=await stat(to);
    if(old&&canonical&&await same(from,to))return;
    if(old&&canonical)throw Error(`Storage collision: ${from}`);
    if(old?.isSymbolicLink())throw Error(`Unexpected migration source symlink: ${from}`);
    if(old||canonical)moves.push({...identity,from,to,action:old?'move':'repair-alias'});
  }
  for(const slug of await listProblemSlugs(root)) {
    problemDir(root,slug);
    await add(path.join(root,'problems',slug),path.join(root,'tracks',disciplineForSlug(slug),'problems',slug),{kind:'problem',slug});
  }
  for(const scope of ['learner','coding','lld','design']) {
    memoryPath(root,scope);
    await add(path.join(root,'memory',`${scope}.md`),scope==='learner'?path.join(root,'shared','learner.md'):path.join(root,'tracks',scope,'MEMORY.md'),{kind:'memory',scope});
  }
  for(const [file,discipline] of [['TUTOR.md','coding'],['LLD.md','lld'],['DESIGN.md','design']]) {
    memoryPath(root,discipline);
    await add(path.join(root,file),path.join(root,'tracks',discipline,'LEGACY.md'),{kind:'legacy-memory',discipline});
  }
  const designEntries=new Set();
  for(const dir of [path.join(root,'design'),path.join(root,'tracks/design/interviews')]) {
    workspacePath(root,dir);
    try { for(const id of await fs.readdir(dir)) if(isSafeInterviewId(id)) designEntries.add(id); }
    catch(e) { if(e.code!=='ENOENT')throw e; }
  }
  for(const id of designEntries)await add(path.join(root,'design',id),path.join(root,'tracks/design/interviews',id),{kind:'legacy-design',id});
  return moves;
}
async function fingerprint(target) {
  const hash=crypto.createHash('sha256');let files=0,bytes=0;
  async function visit(file,relative) {
    const info=await fs.lstat(file);
    if(info.isSymbolicLink())throw Error(`Refusing to migrate an unverified nested symlink: ${file}`);
    if(info.isDirectory()) {for(const name of (await fs.readdir(file)).sort())await visit(path.join(file,name),path.join(relative,name));return;}
    if(!info.isFile())throw Error(`Unsupported storage entry: ${file}`);
    const content=await fs.readFile(file);files++;bytes+=content.length;
    hash.update(relative);hash.update('\0');hash.update(String(content.length));hash.update('\0');hash.update(content);
  }
  await visit(target,'');return {sha256:hash.digest('hex'),files,bytes};
}
export async function migrateStorage(root,{apply=false}={}) {
  root=path.resolve(root);const moves=await planMigration(root);
  for(const move of moves)move.evidence=await fingerprint(move.action==='move'?move.from:move.to);
  if(!apply)return {root,apply,moves};
  const manifest=path.join(root,'storage-migration.jsonl');
  workspacePath(root,manifest);
  for(const move of moves) {
    workspacePath(root,move.from);workspacePath(root,move.to);
    await fs.mkdir(path.dirname(move.to),{recursive:true});await fs.mkdir(path.dirname(move.from),{recursive:true});
    await fs.appendFile(manifest,JSON.stringify({...move,phase:'planned',at:new Date().toISOString()})+'\n');
    if(move.action==='move')await fs.rename(move.from,move.to);
    const after=await fingerprint(move.to);
    if(after.sha256!==move.evidence.sha256)throw Error(`Record changed during migration: ${move.to}. Stop writers and rerun.`);
    await fs.symlink(path.relative(path.dirname(move.from),move.to),move.from);
    await fs.appendFile(manifest,JSON.stringify({...move,phase:'complete',at:new Date().toISOString()})+'\n');
  }
  return {root,apply,moves};
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const args=process.argv.slice(2);let root=process.env.STUDIO_HOME||path.join(os.homedir(),'LeetCodeTutor'),apply=false;
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--apply')apply=true;
    else if(args[i]==='--root'&&args[i+1]&&!args[i+1].startsWith('--'))root=args[++i];
    else throw Error('Usage: node scripts/migrate-storage.mjs [--root PATH] [--apply]');
  }
  console.log(JSON.stringify(await migrateStorage(root,{apply}),null,2));
}
