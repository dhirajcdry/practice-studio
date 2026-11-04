import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { focusedProfile,selectRecords,evidenceRecords,contextReader } from '../context-policy.mjs';
import { readAgentMemory,memoryFile } from '../memory.mjs';
import { buildArgs,interpretLine } from '../claude-cli.mjs';
import { debriefPrompt } from '../../interview/prompt.mjs';
import { newState } from '../../interview/state.mjs';

test('prompt learning is discipline scoped and bounded independently of archive size',()=>{
  const p={preferences:{targetLevel:{lld:'L4'}},attempted:{coding:Array.from({length:2000},(_,i)=>({slug:`coding-${i}`})),lld:[{slug:'lld-locker'}]},completed:{lld:[]},
    assessments:[{discipline:'coding',summary:'FOREIGN_EVIDENCE'.repeat(100000)}, {discipline:'lld',slug:'lld-locker',summary:'Observed ownership gap',source:'source-1',dimensions:[]}],
    documents:{'TUTOR.md':{text:'FOREIGN_NOTES'.repeat(100000)}},observations:[],completedInterviews:[]};
  const text=JSON.stringify(focusedProfile(p,{discipline:'lld',slug:'lld-locker'}));
  assert.ok(text.length<14000); assert.match(text,/Observed ownership gap/);assert.doesNotMatch(text,/FOREIGN|coding-1999/);
  assert.equal(JSON.parse(text).totals.attempted,1);
});

test('record selection preserves early requirements, recent correction and explicit coverage',async()=>{
  const rows=Array.from({length:300},(_,i)=>({said:i===0?'Capacity is five':i===299?'Correction: capacity is six':`discussion ${i} `+'x'.repeat(400)}));
  const selected=selectRecords(rows,{budget:5000});
  assert.ok(JSON.stringify(selected).length<5200);assert.equal(selected.totalRecords,300);assert.ok(selected.omittedRecords>0);
  assert.ok(selected.records.some(r=>r.said==='Capacity is five'));assert.ok(selected.records.some(r=>r.said==='Correction: capacity is six'));
  const read=contextReader({session:rows}); const first=JSON.parse((await read({resource:'session',limit:100})).text);
  assert.equal(first.nextOffset,100);assert.equal(first.data,JSON.stringify(rows,null,2).slice(0,100));
  assert.equal((await read({resource:'../../secrets'})).ok,false);
});

test('evidence removes repeated code but retains changes, learner words and assisted ownership',()=>{
  const turns=[{kind:'buffer',code:'x = 0\n'},{kind:'candidate',said:'I checked it',elapsedMs:100},
    {kind:'tool_action',action:{tool:'edit_code',status:'done',summary:'Coach fixes x',args:{find:'x=0',replace:'x=1'}}},
    {kind:'buffer',code:'x = 1\n'}];
  const rows=evidenceRecords(turns,{codeChanges:true});
  assert.match(rows.at(-1).codeChange,/\+x = 1/);assert.equal(rows[1].said,'I checked it');
  assert.equal(rows[2].action.summary,'Coach fixes x');assert.equal(rows[2].action.args,undefined);
  const prompt=debriefPrompt({...newState({slug:'lld-locker'}),discipline:'lld',lastCode:'x = 1\n'},turns,Date.now());
  assert.match(prompt,/Final candidate code/);assert.match(prompt,/x = 1/);assert.match(prompt,/Coach fixes x/);
});

test('automatic memory is relevant and bounded; full notes survive on disk',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-context-memory-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  for(const [scope,text] of [['problem','VALIDATION note\n\n'.repeat(2000)],['lld','Ownership observed'],['coding','CODING_ONLY'],['design','DESIGN_ONLY'],['learner','Python preferred']]){
    const file=memoryFile(root,'lld-locker',scope);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);
  }
  const text=await readAgentMemory(root,'lld-locker',{query:'validation'});
  assert.match(text,/Ownership observed|VALIDATION/);assert.match(text,/Python preferred/);assert.doesNotMatch(text,/CODING_ONLY|DESIGN_ONLY/);assert.ok(text.length<12000);
  assert.ok((await fs.readFile(memoryFile(root,'lld-locker','problem'),'utf8')).length>30000);
});

test('Studio Claude boundary uses explicit context without bare/API auth or permission bypass',()=>{
  const args=buildArgs({root:'/tmp/studio',tools:'',studioContext:true,systemPrompt:'Specific interview rules'});
  assert.ok(args.includes('--disable-slash-commands'));assert.equal(args[args.indexOf('--setting-sources')+1],'');
  assert.equal(args[args.indexOf('--system-prompt')+1],'Specific interview rules');
  assert.ok(!args.includes('--bare'));assert.ok(!args.includes('--dangerously-skip-permissions'));assert.ok(args.includes('--strict-mcp-config'));
  const usage={input_tokens:42,cache_read_input_tokens:8,cache_creation_input_tokens:16,output_tokens:3};
  assert.deepEqual(interpretLine({type:'result',usage},{}).find(x=>x.kind==='usage').usage,usage);
});

test('automatic and tool memory resolution rejects external leaf symlinks',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-leaf-memory-'));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'studio-external-memory-'));
  t.after(()=>Promise.all([fs.rm(root,{recursive:true,force:true}),fs.rm(outside,{recursive:true,force:true})]));
  const secret=path.join(outside,'secret');await fs.writeFile(secret,'must never enter prompt');
  const note=memoryFile(root,'lld-locker','problem');await fs.mkdir(path.dirname(note),{recursive:true});await fs.symlink(secret,note);
  assert.throws(()=>memoryFile(root,'lld-locker','problem'),/escapes/);
  await assert.rejects(readAgentMemory(root,'lld-locker'),/escapes/);
  await fs.unlink(note);await fs.symlink(secret,path.join(root,'LLD.md'));
  await assert.rejects(readAgentMemory(root,'lld-locker'),/escapes/);
});

test('fresh debrief retains original requirements, final code, and disclosure distinctions',()=>{
  const state={...newState({slug:'lld-locker'}),discipline:'lld',statement:'Design parcel storage with retrieval codes.',scenario:{facts:'Codes expire after 24 hours.'},lastCode:'def retrieve(code):\n    return None\n'};
  const prompt=debriefPrompt(state,[{kind:'candidate',said:'What is the expiration rule?'}],Date.now());
  assert.match(prompt,/Design parcel storage with retrieval codes/);assert.match(prompt,/Codes expire after 24 hours/);
  assert.match(prompt,/do not claim an undisclosed private constraint was agreed/);
  assert.match(prompt,/def retrieve\(code\):\n    return None/);
});

test('provider records actual usage without content and never native-resumes a logical chat',async t=>{
  const {runProviderTurn}=await import('../provider.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-context-provider-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const argsFile=path.join(root,'args.json'), usage={input_tokens:120,cache_read_input_tokens:600,cache_creation_input_tokens:30,output_tokens:24};
  let done, error;
  const child=runProviderTurn({choice:{provider:'claude',model:'opus'},root,discipline:'lld',prompt:'PRIVATE_LEARNER_QUESTION',systemPrompt:'Interview rules',resumeSessionId:'logical-chat',
    binary:new URL('./bin/fake-claude.mjs',import.meta.url).pathname,
    env:{...process.env,FAKE_CLAUDE_USAGE:JSON.stringify(usage),FAKE_CLAUDE_ARGS_FILE:argsFile},
    onDone:id=>{done=id;},onError:e=>{error=e;}});
  await child.exited;assert.equal(error,undefined);assert.equal(done,'logical-chat');
  const args=JSON.parse(await fs.readFile(argsFile,'utf8'));assert.ok(!args.includes('--resume'));assert.equal(args[args.indexOf('--model')+1],'opus');
  assert.match(args[args.indexOf('--system-prompt')+1], /Tool results continue the same reply/);
  const raw=await fs.readFile(path.join(root,'usage/turns.jsonl'),'utf8'), row=JSON.parse(raw);
  assert.equal(row.promptCharacters,24);assert.equal(row.sessionId,'logical-chat');assert.equal(row.discipline,'lld');
  assert.ok(row.streaming.rawTextDeltaCount > 0); assert.ok(row.streaming.stdoutDataBatchesWithText > 0);
  assert.ok(row.streaming.firstForwardedTokenMs >= row.streaming.firstRawTextDeltaMs);
  assert.doesNotMatch(args[args.indexOf('--system-prompt')+1], /Perform bookkeeping tools before/);
  assert.deepEqual(row.usage,{inputTokens:120,cacheReadInputTokens:600,cacheCreationInputTokens:30,outputTokens:24,reasoningOutputTokens:null,inputTokenScope:'uncached'});
  assert.doesNotMatch(raw,/PRIVATE_LEARNER_QUESTION|Interview rules/);
});

test('older assessments omitted from prompt remain retrievable with their raw interview',async t=>{
  const {InterviewStore}=await import('../../interview/store.mjs');
  const {readLearnerProfile}=await import('../../learning/profile.mjs');
  const {createToolSession,ActionStore}=await import('../tools.mjs');
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-old-evidence-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const store=new InterviewStore({root}),slug='lld-locker';
  let firstId;
  for(let i=0;i<25;i++) {
    const id=`${1700000000000+i}-abcdef12`;firstId??=id;
    await store.create(slug,id,{...newState({slug,startedAt:1700000000000+i}),discipline:'lld',debriefed:true,endedAt:1700000001000+i,statement:'Design a locker.',lastCode:'class Locker: pass'});
    await store.append(slug,id,{kind:'candidate',said:`Recorded claim ${i}`});
    await store.append(slug,id,{kind:'debrief',asked:`Recorded feedback ${i}`});
  }
  const compact=await readLearnerProfile(root,{discipline:'lld'}),full=await readLearnerProfile(root,{discipline:'lld',fullEvidence:true});
  assert.equal(compact.assessments.length,20);assert.equal(full.assessments.length,25);
  assert.ok(!compact.assessments.some(a=>a.id===firstId));
  const session=createToolSession({root,slug,store:new ActionStore()});t.after(()=>session.dispose());
  const result=await session.call('read_context',{resource:`interview:${slug}:${firstId}`});
  assert.equal(result.ok,true);assert.match(JSON.parse(result.text).data,/Recorded claim 0/);assert.match(JSON.parse(result.text).data,/Recorded feedback 0/);
  assert.equal((await session.call('read_context',{resource:'interview:two-sum:1700000000000-abcdef12'})).ok,false);
});
