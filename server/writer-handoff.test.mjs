import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { enqueueWriterSession, startWriterWorker, writerBaseUrl, writerSessionStatus } from './writer-handoff.mjs';
const source = { app:'practice-studio',title:'Two sum',url:'http://127.0.0.1:4173/#/p/two-sum',conversationId:'coding:two-sum:chat' };
async function fixture(t){const root=await fsp.mkdtemp(path.join(os.tmpdir(),'studio-writer-'));t.after(()=>fsp.rm(root,{recursive:true,force:true}));return {root,env:{STUDIO_WRITER_URL:'https://writer.example.ts.net'},title:'Counting',message:'Explain related patterns',context:'Counting once per user',source};}
const saved=async(f,id)=>JSON.parse(await fsp.readFile(path.join(f.root,'context/writer-outbox',`${id}.json`),'utf8'));
test('rejects credentials, paths, unrelated hosts and non-loopback HTTP',()=>{for(const value of ['https://a:b@writer.example.ts.net','https://writer.example.ts.net/path','https://evil.example','http://writer.example.ts.net','https://writer.example.ts.net?x=1'])assert.equal(writerBaseUrl({STUDIO_WRITER_URL:value}),null);assert.equal(writerBaseUrl({STUDIO_WRITER_URL:'http://127.0.0.1:5181'}),'http://127.0.0.1:5181');});
test('identical handoffs retain UUID across enqueue and process reconstruction',async t=>{const f=await fixture(t);const a=await enqueueWriterSession(f);assert.equal(a.status,'queued');const b=await enqueueWriterSession(f);assert.equal(a.id,b.id);assert.equal(b.replayed,true);assert.equal((await enqueueWriterSession({...f,id:a.id,title:'Changed'})).ok,false);await assert.rejects(enqueueWriterSession({...f,id:'../escape'}));});
test('worker advances beyond previously delivered files, with stable payload and explicit status',async t=>{
 const f=await fixture(t),ids=[];for(let i=0;i<5;i++)ids.push((await enqueueWriterSession({...f,id:crypto.randomUUID(),title:`Notes ${i}`})).id);
 const posted=[];const stop=startWriterWorker({...f,startImmediately:false,fetchFn:async(url,init)=>{const body=JSON.parse(init.body);posted.push(body.id);return {ok:true,json:async()=>({id:body.id,status:'queued'})};}});t.after(stop);
 await stop.tick();await stop.tick();await stop.tick();assert.equal(new Set(posted).size,5);for(const id of ids)assert.equal((await saved(f,id)).status,'started');
 const state=await writerSessionStatus(f.root,ids[0],{fetchFn:async()=>({ok:true,json:async()=>({status:'done',stage:'Handout ready',outputNoteId:'note'})})});assert.equal(state.status,'done');assert.equal(state.outputNoteId,'note');
});
test('lost acknowledgement retries the same id; offline stays queued with backoff',async t=>{
 const f=await fixture(t);let now=1;const a=await enqueueWriterSession({...f,now:()=>now});let fail=true;const ids=[];
 const stop=startWriterWorker({...f,startImmediately:false,now:()=>now,fetchFn:async(_url,init)=>{ids.push(JSON.parse(init.body).id);if(fail)throw Error('offline');return {ok:true,json:async()=>({id:a.id,status:'working'})};}});t.after(stop);
 await stop.tick();assert.equal((await saved(f,a.id)).status,'queued');await stop.tick();assert.equal(ids.length,1);now=40000;fail=false;await stop.tick();assert.deepEqual(ids,[a.id,a.id]);assert.equal((await saved(f,a.id)).status,'started');
});
test('permanent rejection becomes visible and identical explicit handoff retries delivery',async t=>{const f=await fixture(t),a=await enqueueWriterSession(f);const stop=startWriterWorker({...f,startImmediately:false,fetchFn:async()=>({ok:false,status:403})});await stop.tick();stop();assert.equal((await writerSessionStatus(f.root,a.id)).status,'failed');await enqueueWriterSession(f);assert.equal((await saved(f,a.id)).status,'queued');});
