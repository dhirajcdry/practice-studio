import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {copyCachedQuestions} from '../../scripts/demo/cached-questions.mjs';

test('demo copies public question content without practice metadata or overwriting its fixture',async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'studio-demo-cache-test-'));
 try{
  const source=path.join(root,'source'),destination=path.join(root,'demo');await fsp.mkdir(source);await fsp.mkdir(destination);
  const question={titleSlug:'two-sum',content:'public statement'};
  await fsp.writeFile(path.join(source,'two-sum.json'),JSON.stringify({slug:'two-sum',complete:true,question,privateNotes:'never copy',attempts:[1]}));
  await fsp.writeFile(path.join(source,'bad.json'),JSON.stringify({complete:true,question:{titleSlug:'wrong'}}));
  await fsp.writeFile(path.join(destination,'fixture.json'),'original fixture');
  assert.equal(await copyCachedQuestions(source,destination,['two-sum','bad','fixture','../escape']),1);
  const copied=JSON.parse(await fsp.readFile(path.join(destination,'two-sum.json')));
  assert.deepEqual(Object.keys(copied).sort(),['complete','fetchedAt','question','slug']);assert.deepEqual(copied.question,question);
  assert.equal(await fsp.readFile(path.join(destination,'fixture.json'),'utf8'),'original fixture');
  assert.deepEqual((await fsp.readdir(destination)).sort(),['fixture.json','two-sum.json']);
 }finally{await fsp.rm(root,{recursive:true,force:true});}
});
