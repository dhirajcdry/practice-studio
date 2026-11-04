import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { disciplineForSlug, listProblemSlugs, memoryPath, problemDir } from './storage-layout.mjs';
import {migrateStorage} from '../scripts/migrate-storage.mjs';

const scratch = async () => fs.mkdtemp(path.join(os.tmpdir(), 'studio-layout-'));

test('maps disciplines and prefers canonical storage', async () => {
  const root = await scratch();
  assert.equal(disciplineForSlug('two-sum'), 'coding');
  assert.equal(disciplineForSlug('lld-library'), 'lld');
  assert.equal(disciplineForSlug('design-chat'), 'design');
  const canonical = path.join(root, 'tracks/coding/problems/two-sum');
  await fs.mkdir(canonical, { recursive: true });
  assert.equal(problemDir(root, 'two-sum'), canonical);
  assert.deepEqual(await listProblemSlugs(root), ['two-sum']);
});

test('supports legacy fallback and rejects independent ambiguity', async () => {
  const root = await scratch();
  const legacy = path.join(root, 'problems/lld-box');
  await fs.mkdir(legacy, { recursive: true });
  assert.equal(problemDir(root, 'lld-box'), legacy);
  await fs.mkdir(path.join(root, 'tracks/lld/problems/lld-box'), { recursive: true });
  assert.throws(() => problemDir(root, 'lld-box'), /Ambiguous/);
});

test('memory aliases resolve to canonical paths with legacy fallback', async () => {
  const root = await scratch();
  assert.equal(memoryPath(root, 'learner'), path.join(root, 'shared/learner.md'));
  assert.equal(memoryPath(root, 'coding'),path.join(root,'tracks/coding/MEMORY.md'));
  await fs.mkdir(path.join(root, 'memory'), { recursive: true });
  await fs.writeFile(path.join(root, 'memory/lld.md'), 'old');
  assert.equal(memoryPath(root, 'lld'), path.join(root, 'memory/lld.md'));
});

test('migration separates disciplines losslessly and resumes missing aliases',async t=>{
  const root=await scratch();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const slug of ['two-sum','lld-box','design-chat']){await fs.mkdir(path.join(root,'problems',slug),{recursive:true});await fs.writeFile(path.join(root,'problems',slug,'turns.jsonl'),`{"slug":"${slug}"}\n`);}
  await fs.mkdir(path.join(root,'memory'));await fs.writeFile(path.join(root,'memory/learner.md'),'shared');await fs.writeFile(path.join(root,'memory/coding.md'),'coding');
  const plan=await migrateStorage(root);assert.equal(plan.moves.length,5);assert.equal((await fs.lstat(path.join(root,'problems/two-sum'))).isSymbolicLink(),false);
  await migrateStorage(root,{apply:true});
  assert.equal((await fs.lstat(path.join(root,'problems/two-sum'))).isSymbolicLink(),true);
  assert.equal(await fs.readFile(path.join(problemDir(root,'lld-box'),'turns.jsonl'),'utf8'),'{"slug":"lld-box"}\n');
  assert.equal(await fs.readFile(memoryPath(root,'learner'),'utf8'),'shared');assert.equal(await fs.readFile(memoryPath(root,'coding'),'utf8'),'coding');
  assert.equal((await migrateStorage(root,{apply:true})).moves.length,0);
  await fs.unlink(path.join(root,'problems/two-sum'));
  assert.equal((await migrateStorage(root,{apply:true})).moves[0].action,'repair-alias');
});

test('resolver rejects escaping parents and migration preflights nested links',async t=>{
  const root=await scratch(),outside=await scratch();t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(outside,{recursive:true,force:true})]));
  await fs.symlink(outside,path.join(root,'tracks'));
  assert.throws(()=>problemDir(root,'two-sum'),/escapes/);
  await fs.unlink(path.join(root,'tracks'));await fs.mkdir(path.join(root,'problems/two-sum'),{recursive:true});
  await fs.symlink(outside,path.join(root,'problems/two-sum/unsafe'));
  await assert.rejects(migrateStorage(root,{apply:true}),/symlink/);
  assert.equal((await fs.lstat(path.join(root,'problems/two-sum'))).isDirectory(),true);
});

test('migration recovers a legacy design record after rename but before alias creation',async t=>{
  const root=await scratch();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id='2026-10-31T10-00-00-000Z', target=path.join(root,'tracks/design/interviews',id);
  await fs.mkdir(target,{recursive:true});await fs.writeFile(path.join(target,'turns.jsonl'),'original bytes\n');
  const result=await migrateStorage(root,{apply:true});
  assert.equal(result.moves[0].action,'repair-alias');
  assert.equal(await fs.readFile(path.join(root,'design',id,'turns.jsonl'),'utf8'),'original bytes\n');
  assert.equal((await migrateStorage(root,{apply:true})).moves.length,0);
});

test('migration rejects escaping legacy design ancestors before touching any record',async t=>{
  const root=await scratch(),outside=await scratch();t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(outside,{recursive:true,force:true})]));
  const id='2026-10-31T10-00-00-000Z';await fs.mkdir(path.join(outside,id));
  await fs.writeFile(path.join(outside,id,'turns.jsonl'),'keep me');
  await fs.symlink(outside,path.join(root,'design'));
  await assert.rejects(migrateStorage(root,{apply:true}),/escapes/);
  assert.equal(await fs.readFile(path.join(outside,id,'turns.jsonl'),'utf8'),'keep me');
  await fs.unlink(path.join(root,'design'));
  await fs.mkdir(path.join(root,'tracks/design'),{recursive:true});await fs.symlink(outside,path.join(root,'tracks/design/interviews'));
  await assert.rejects(migrateStorage(root,{apply:true}),/escapes/);
});

test('catalog coding problems with design in their title never enter the design track',async t=>{
  const root=await scratch();t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const slug of ['design-twitter','design-add-and-search-words-data-structure']) {
    assert.equal(disciplineForSlug(slug),'coding');
    await fs.mkdir(path.join(root,'problems',slug),{recursive:true});
    await fs.writeFile(path.join(root,'problems',slug,'solution.py'),'# learner code\n');
  }
  await migrateStorage(root,{apply:true});
  assert.deepEqual(await listProblemSlugs(root,{discipline:'design'}),[]);
  assert.equal((await listProblemSlugs(root,{discipline:'coding'})).length,2);
  assert.match(problemDir(root,'design-twitter'),/tracks\/coding\/problems\/design-twitter$/);
});
