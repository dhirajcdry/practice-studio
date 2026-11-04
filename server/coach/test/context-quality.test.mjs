import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sessionEvidence,sessionProjection,createSessionContext } from '../session-context.mjs';
import { createEvidenceIndex } from '../context-search.mjs';
import { contextPacket } from '../context-packet.mjs';
import { createToolSession,ActionStore,LIMITS } from '../tools.mjs';
import { selectRecords } from '../context-policy.mjs';
import { workspace } from './tools-fixture.mjs';

async function temp(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-context-quality-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}

test('a middle-session requirement survives a long record together with a later correction and attribution',()=>{
  const rows=Array.from({length:250},(_,i)=>({at:String(i),said:`discussion ${i} `+'x'.repeat(150)}));
  rows[110].said='We agree adjacent reservations are allowed, with exclusive end times.';
  rows[200]={at:'200',kind:'tool_action',action:{tool:'edit_code',status:'done',summary:'Coach corrected overlap comparison'}};
  rows[249].said='I corrected the cancellation check myself.';
  const selected=sessionProjection(rows,[],{query:'adjacent reservations cancellation',budget:6000});
  const text=JSON.stringify(selected);
  assert.match(text,/exclusive end times/);assert.match(text,/corrected the cancellation check/);assert.match(text,/Coach corrected overlap/);
  const full=sessionEvidence(rows);assert.equal(full.find(e=>e.text.includes('Coach corrected')).actor,'record');
});

test('session records require source quotes, survive completion, replace stale claims, and isolate branches',async t=>{
  const root=await temp(t);let records=[{requestId:'r1',question:'Adjacent bookings are allowed.',status:'pending'}];
  const session=createSessionContext({root,target:'practice:lld-booking:a',records:async()=>records});
  const source=(await session.sources())[0];
  assert.equal((await session.record({key:'adjacency',kind:'requirement',summary:'Adjacent bookings allowed',evidence:[{sourceId:source.sourceId,quote:'invented quote'}]})).ok,false);
  assert.equal((await session.record({key:'adjacency',kind:'requirement',summary:'Adjacent bookings allowed',evidence:[{sourceId:source.sourceId,quote:'Adjacent bookings are allowed.'}]})).ok,true);
  records[0].answer='Understood.';records[0].status='complete';
  assert.equal((await session.read()).entries.records.length,1);
  records.push({requestId:'r2',question:'Correction: leave a ten minute gap.'});
  const correction=(await session.sources()).at(-1);
  await session.record({key:'adjacency',kind:'requirement',summary:'Ten minute gap now required',evidence:[{sourceId:correction.sourceId,quote:'Correction: leave a ten minute gap.'}]});
  assert.equal((await session.read()).entries.records.length,1);assert.match(JSON.stringify(await session.read()),/Ten minute gap/);
  const branch=createSessionContext({root,target:'practice:lld-booking:b',records:async()=>records});assert.equal((await branch.read()).entries.records.length,0);
  records=[];assert.equal((await session.read()).unavailableEntries,1,'no valid source means no authoritative entry');
});

test('relevant historical technical evidence is searchable without leaking another discipline',()=>{
  const profile={assessments:[{id:'old',slug:'lld-locker',discipline:'lld',summary:'Mixed performance',technicalErrors:['Double booking due to a race between capacity check and mutation.'],source:'old-mock',date:'2024-01-01'},
    {id:'new',slug:'lld-locker',discipline:'lld',summary:'Clear naming',source:'new-mock'},
    {id:'foreign',discipline:'coding',summary:'race atomic lock'}]};
  const index=createEvidenceIndex({discipline:'lld',slug:'lld-locker',profile});
  const matches=index.search({query:'How do I make a concurrent booking atomic?'});
  assert.match(index.read(matches.results[0].resource),/Double booking/);assert.equal(matches.results[0].kind,'assessment');
  assert.ok(!matches.results.some(r=>r.sourceId==='foreign'));
  assert.equal(index.search({query:'unicorn astrophysics'}).total,0);
  const many=createEvidenceIndex({discipline:'lld',notes:Array.from({length:30},(_,i)=>({source:`n${i}`,text:'lock '.repeat(10000)}))});
  assert.ok(JSON.stringify(many.search({query:'lock',limit:8})).length<=5000);
});

test('full current work stays intact and unchanged instructions/reference are a stable prefix',()=>{
  const code='class Booking:\n'+('    # preserve complete implementation\n'.repeat(3000));
  const make=history=>contextPacket({instructions:'Ask one question. Preserve evidence.',reference:[['Problem','Design bookings']],sections:[['History',history],['Current code',code]]});
  const a=make('first'),b=make('second');
  assert.ok(a.includes(code));assert.ok(b.includes(code));
  assert.equal(a.slice(0,a.indexOf('## History')),b.slice(0,b.indexOf('## History')));
});

test('tool outputs are bounded but exactly retrievable; changed work is not deduplicated',async t=>{
  const {root,cleanup}=await workspace();t.after(cleanup);
  let code='x = '+JSON.stringify('\\\"'.repeat(9000));
  const session=createToolSession({root,slug:'two-sum',store:new ActionStore(),capabilities:{getState:async()=>({code})}});t.after(()=>session.dispose());
  const first=await session.call('get_state',{});assert.ok(first.text.length<=LIMITS.resultChars);
  let page=JSON.parse(first.text),joined=page.data;
  while(page.nextOffset!==null){page=JSON.parse((await session.call('read_context',{resource:page.resource,offset:page.nextOffset})).text);joined+=page.data;}
  assert.deepEqual(JSON.parse(joined),{code});
  const repeated=JSON.parse((await session.call('get_state',{})).text);assert.equal(repeated.unchanged,true);
  code='print("changed")';assert.deepEqual(JSON.parse((await session.call('get_state',{})).text),{code});
  assert.equal(session.metrics.repeatedReads,1);assert.ok(session.metrics.resultCharacters>0);
});

test('query relevance selects a mid-session decision despite many recent unrelated turns',()=>{
  const rows=Array.from({length:80},(_,i)=>({said:`Discussion ${i}: `+'background '.repeat(35)}));
  rows[35].said='The critical section must atomically check availability and insert the reservation.';
  const picked=selectRecords(rows,{query:'concurrency atomic booking',budget:3000});
  assert.ok(picked.records.some(r=>r.said.includes('critical section')));
});

test('paged tool results survive later native turns but remain scoped to the session target',async t=>{
  const {root,cleanup}=await workspace();t.after(cleanup);
  const code='class Booking:\n'+'    # saved exact evidence\n'.repeat(1000);
  const create=target=>createToolSession({root,slug:'two-sum',target,store:new ActionStore(),capabilities:{getState:async()=>({code})}});
  const first=create('practice:two-sum:one');
  const page=JSON.parse((await first.call('get_state',{})).text);first.dispose();await first.flush();
  const second=create('practice:two-sum:one');t.after(()=>second.dispose());
  const restored=await second.call('read_context',{resource:page.resource,offset:page.nextOffset});
  assert.equal(restored.ok,true);assert.equal(JSON.parse(restored.text).offset,page.nextOffset);
  const other=create('practice:two-sum:two');t.after(()=>other.dispose());
  assert.equal((await other.call('read_context',{resource:page.resource})).ok,false);
  assert.equal((await second.call('read_context',{resource:'result:../../secret'})).ok,false);
});
