import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildConversation, beginConversation, conversationDir } from '../native-sessions.mjs';
import { sessionDelivery, sessionEvidence } from '../session-context.mjs';
import { reviewContextSections, reviewSystemPrompt, reviewConversationKey } from '../../interview/review.mjs';

const choice = {provider:'claude',model:'opus'};
const records = [
  {kind:'candidate',requestId:'r1',said:'The check and insert must be atomic.'},
  {kind:'candidate',requestId:'r2',said:'Actually, one room may have several non-overlapping bookings.'},
];
const sources = sessionEvidence(records);
const decision = {key:'atomic',kind:'requirement',summary:'Keep the lock atomic.',status:'active',evidence:[{sourceId:sources[0].sourceId,quote:sources[0].text}]};
const value = (entries = [decision], rows = records, query = '') => sessionDelivery(rows,entries,{query,budget:1200});
async function fixture(t, key = 'practice:lld-locker:one') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'studio-delivery-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  return {
    root,
    state:async () => JSON.parse(await fs.readFile(path.join(conversationDir(root,key),'state.json'),'utf8')),
    start: (context, extra = {}) => beginConversation({root,choice,systemPrompt:'Coach',toolSpecs:[],
      conversation:buildConversation({key,message:'Next question',context,bootstrap:{sections:[['Saved history',records]],sessionTools:true},...extra})}),
  };
}
async function commit(turn) { await turn.nativeId('native-one'); await turn.complete(); }

test('bootstrap and acknowledged baseline use the same actual context, with history and current request once', async t => {
  const f = await fixture(t);
  const input = buildConversation({key:'practice:lld-locker:one',message:'CURRENT QUESTION',context:[['Code',{code:'UNIQUE CODE'}],['Session',value()]],bootstrap:{sections:[['Saved history','OLD ANSWER']]}});
  input.bootstrapPrompt = 'obsolete separately rendered payload';
  const first = await beginConversation({root:f.root,conversation:input,choice,systemPrompt:'Coach'});
  assert.match(first.prompt,/OLD ANSWER/);
  assert.equal(first.prompt.split('UNIQUE CODE').length,2);
  assert.equal(first.prompt.split('CURRENT QUESTION').length,2);
  assert.doesNotMatch(first.prompt,/obsolete separately|canonicalEntries|recentSources/);
  input.context[0][1].code = 'not actually delivered';
  await commit(first);
  assert.equal((await f.state()).baseline.find(x => x.label === 'Code').code,'UNIQUE CODE');
});

test('new source counts and different query-selected anchors produce no repeated context on resume', async t => {
  const f = await fixture(t);
  const first = await f.start([['Scenario','PRIVATE FACTS'],['Session',value()]]); await commit(first);
  const more = [...records,...Array.from({length:30},(_,i)=>({kind:'candidate',requestId:`more-${i}`,said:`We should consider UNIQUE OLD ANCHOR ${i}.`}))];
  const second = await f.start([['Scenario','PRIVATE FACTS'],['Session',value([decision],more,'ANCHOR 29')]]);
  assert.equal(second.resumeSessionId,'native-one');
  assert.doesNotMatch(second.prompt,/PRIVATE FACTS|UNIQUE OLD ANCHOR|Keep the lock atomic|canonicalEntries|recentSources|sourceCount|"upsert"/);
  await second.complete();
});

test('only changed decision keys are sent; a query omission is not a deletion and superseding status is explicit', async t => {
  const f = await fixture(t);
  const secondDecision = {...decision,key:'multi',summary:'Several non-overlapping bookings.',evidence:[{sourceId:sources[1].sourceId,quote:sources[1].text}]};
  await commit(await f.start([['Session',value([decision,secondDecision])]]));
  const changed = {...decision,status:'superseded',summary:'Previous atomic requirement superseded; verify source.'};
  const delivery = value([changed,secondDecision]);
  delivery.projection.entries.records = []; // Query budget can omit an unchanged key.
  const turn = await f.start([['Session',delivery]]);
  assert.match(turn.prompt,/"upsert":\[\{"key":"atomic"/);
  assert.match(turn.prompt,/"status":"superseded"/);
  assert.match(turn.prompt,/"unverified":\[\]/);
  assert.doesNotMatch(turn.prompt,/Several non-overlapping bookings|"key":"multi"|canonicalEntries|recentSources/);
  await turn.complete();
  const unverifiable = await f.start([['Session',value([changed,secondDecision],records.slice(1))]]);
  assert.match(unverifiable.prompt,/"unverified":\["atomic"\]/);
  await unverifiable.complete();
});

test('compaction restores verified decisions, correction anchors and recent exact evidence once', async t => {
  const f = await fixture(t);
  const first = await f.start([['Session',value()]]);
  await first.nativeId('native-one'); first.compaction({trigger:'test'}); await first.complete();
  const second = await f.start([['Session',value()]],{recoverySections:[['Recent review','A follow-up correction.']]});
  assert.equal(second.metadata.resync,true);
  assert.equal(second.resumeSessionId,'native-one');
  assert.match(second.prompt,/Actually, one room may have several non-overlapping bookings/);
  assert.match(second.prompt,/Keep the lock atomic|recentEvidence/);
  assert.match(second.prompt,/A follow-up correction/);
  await second.complete();
  const third = await f.start([['Session',value()]],{recoverySections:[['Recent review','A follow-up correction.']]});
  assert.equal(third.metadata.resync,false);
  assert.doesNotMatch(third.prompt,/Actually, one room|Keep the lock atomic|A follow-up correction/);
  await third.complete();
});

test('failed delivery never advances the semantic cursor; replacement segment restores all evidence', async t => {
  const f = await fixture(t);
  await commit(await f.start([['Session',value()]]));
  const before = (await f.state()).baseline;
  const failed = await f.start([['Session',value([{...decision,summary:'Not acknowledged'}])]]);
  await failed.fail();
  assert.deepEqual((await f.state()).baseline,before);
  const recovery = await f.start([['Session',value([{...decision,summary:'Not acknowledged'}])]]);
  assert.equal(recovery.metadata.resumed,false);
  assert.match(recovery.prompt,/Not acknowledged/);
  assert.match(recovery.prompt,/several non-overlapping bookings/);
  await commit(recovery);
});

test('report and follow-ups share a native review; changing memory cannot resend report, final code or evidence', async t => {
  const key = reviewConversationKey('lld-locker','mock-one'), f = await fixture(t,key);
  const state = {statement:'Locker problem',lastCode:'FINAL_CODE_SENTINEL'};
  const turns = [{kind:'candidate',said:'EXACT_EVIDENCE_SENTINEL',elapsedMs:1000}];
  const report = {facts:{finalCode:state.lastCode},judgement:{summary:'CANONICAL_REPORT_SENTINEL'}};
  const start = (reportValue, memory, history=turns) => beginConversation({root:f.root,choice,systemPrompt:reviewSystemPrompt(),toolSpecs:[],
    conversation:buildConversation({key,message:reportValue?'Why?':"Write the candidate's report",context:reviewContextSections({state,turns:history,report:reportValue,agentMemory:memory}),bootstrap:{sessionTools:false}})});
  await commit(await start(null,'first memory'));
  const recordsWithReport = [...turns,{kind:'tool_action',reviewActivity:true,action:{summary:'review-only receipt'}},{kind:'debrief',asked:'RAW_REPORT_MUST_NOT_DUPLICATE'}];
  const follow = await start(report,'first memory',recordsWithReport);
  assert.equal(follow.resumeSessionId,'native-one');
  assert.match(follow.prompt,/CANONICAL_REPORT_SENTINEL/);
  assert.doesNotMatch(follow.prompt,/EXACT_EVIDENCE_SENTINEL|FINAL_CODE_SENTINEL|RAW_REPORT_MUST_NOT_DUPLICATE|review-only receipt/);
  await follow.complete();
  const next = await start(report,'CHANGED MEMORY',recordsWithReport);
  assert.match(next.prompt,/CHANGED MEMORY/);
  assert.doesNotMatch(next.prompt,/CANONICAL_REPORT_SENTINEL|EXACT_EVIDENCE_SENTINEL|FINAL_CODE_SENTINEL|RAW_REPORT_MUST_NOT_DUPLICATE/);
  await next.complete();
});


test('changed bootstrap role instructions start an explicit fresh segment', async t => {
  const f = await fixture(t);
  await commit(await f.start([['Session',value()]],{bootstrap:{instructions:'Original role',sections:[['Saved history',records]]}}));
  const next = await f.start([['Session',value()]],{bootstrap:{instructions:'Updated role',sections:[['Saved history',records]]}});
  assert.equal(next.metadata.reason,'instructions-or-tools-changed');
  assert.equal(next.metadata.resumed,false);
  assert.match(next.prompt,/Updated role/);
  assert.match(next.prompt,/several non-overlapping bookings/);
  await commit(next);
});
