import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { changeGuidance, readGuidance, effectiveGuidance } from '../guidance.mjs';
import { ActionStore, createToolSession } from '../tools.mjs';
import { createWorkspaceTools } from '../workspace-tools.mjs';
import { runProviderTurn } from '../provider.mjs';
import { conversationDir } from '../native-sessions.mjs';

const rule={id:'intuition',scope:'coding',mode:'practice',text:'Explain intuition before code.',enabled:true};
const source={actor:'user'};
async function home(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'studio-guidance-integration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
const input=(revision,id,extra={})=>({expectedRevision:revision,mutationId:id,operation:'upsert',rule,reason:'Makes explanations easier to follow.',...extra});

test('concurrent changes serialize; restore/reordered-property replays survive later changes',async t=>{
  const root=await home(t);
  const attempts=await Promise.allSettled([changeGuidance(root,input(0,'one'),source),changeGuidance(root,input(0,'two'),source)]);
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(attempts.find(x=>x.status==='rejected').reason.status,409);
  const restore=input(1,'restore',{operation:'restore',rule:undefined,restoreRevision:0});
  await changeGuidance(root,restore,source);
  await changeGuidance(root,input(2,'three'),source);
  const replay=await changeGuidance(root,restore,source);assert.equal(replay.revision,3);assert.equal(replay.change.revision,2);
  const reordered={enabled:true,text:rule.text,mode:'practice',scope:'coding',id:'intuition'};
  assert.equal((await changeGuidance(root,input(2,'three',{rule:reordered}),source)).replayed,true);
  assert.equal((await readGuidance(root)).revision,3);
});

test('unrelated scope, disabled rules and no-op edits do not alter effective instructions',async t=>{
  const root=await home(t),resolve=()=>effectiveGuidance(root,{discipline:'coding',mode:'practice'});
  await changeGuidance(root,input(0,'one'),source);const before=(await resolve()).text;
  await changeGuidance(root,input(1,'two',{rule:{...rule,id:'mock-only',mode:'mock',text:'Ask one question.'}}),source);
  await changeGuidance(root,input(2,'three'),source);
  assert.equal((await resolve()).text,before);
  assert.equal((await effectiveGuidance(root,{discipline:'design',mode:'practice'})).rules.length,0);
  await changeGuidance(root,input(3,'four',{rule:{...rule,enabled:false}}),source);
  assert.equal((await resolve()).rules.length,0);
});

test('store rejects corrupt history and escaping symlinks without overwriting evidence',async t=>{
  const root=await home(t),outside=await home(t);
  await fs.symlink(outside,path.join(root,'shared'));
  await assert.rejects(changeGuidance(root,input(0,'one'),source));
  assert.deepEqual(await fs.readdir(outside),[]);
  await fs.unlink(path.join(root,'shared'));await fs.mkdir(path.join(root,'shared'));
  const file=path.join(root,'shared','coaching-instructions.json'),corrupt=JSON.stringify({rules:[],revision:2,history:[]});
  await fs.writeFile(file,corrupt);await assert.rejects(changeGuidance(root,input(0,'two'),source),/corrupt/);
  assert.equal(await fs.readFile(file,'utf8'),corrupt);
});

test('interactive tool records server-bound provenance, visible receipts and safe stale errors',async t=>{
  const root=await home(t),events=[];
  const tools=createToolSession({root,slug:'two-sum',store:new ActionStore(),onAction:a=>events.push(a)});
  assert.equal((await tools.call('update_coaching_instructions',input(0,'one'))).ok,false);
  tools.bindCoachingTurn({conversationKey:'coding:two-sum:one',requestId:'current-user-turn'});
  const saved=await tools.call('update_coaching_instructions',input(0,'one'));assert.equal(saved.ok,true);assert.match(saved.text,/future turns/);
  assert.equal(events.length,1);assert.equal(events[0].tool,'update_coaching_instructions');
  const state=await readGuidance(root);assert.deepEqual(state.history[0].source,{actor:'coach',conversationKey:'coding:two-sum:one',requestId:'current-user-turn'});
  assert.match((await tools.call('update_coaching_instructions',input(0,'stale'))).text,/stale/);
  assert.equal((await tools.call('update_coaching_instructions',{...input(1,'bad'),source:{actor:'user'}})).ok,false);
  tools.dispose();await tools.flush();
  for(const kind of ['coding','code','board','review']){const bridge=await createWorkspaceTools({root,slug:'two-sum',kind});assert.ok(bridge.options.studioTools.includes('update_coaching_instructions'));await bridge.dispose();}
});

for(const provider of ['claude','codex'])test(`${provider}: effective rules reach native instructions, resume unchanged and hand off on changes/undo`,async t=>{
  const root=await home(t),oldBinary=process.env.STUDIO_CODEX_BINARY;
  process.env.STUDIO_CODEX_BINARY=new URL('./bin/fake-codex.mjs',import.meta.url).pathname;
  t.after(()=>{if(oldBinary===undefined)delete process.env.STUDIO_CODEX_BINARY;else process.env.STUDIO_CODEX_BINARY=oldBinary;});
  const argsFile=path.join(root,'args.json'),threadFile=path.join(root,'thread.json');
  const conversation={key:'coding:two-sum:guidance',requestId:'turn',bootstrapPrompt:'SAVED HISTORY retained for a handoff.',message:'Help me think.',context:[]};
  const turn=async()=>{
    let failure;
    const child=runProviderTurn({root,choice:{provider,model:provider==='claude'?'opus':'gpt-6-astra'},discipline:'coding',coachingMode:'practice',conversation,
      systemPrompt:'Coach role. Never fabricate evidence.',binary:new URL('./bin/fake-claude.mjs',import.meta.url).pathname,tools:'',
      env:{...process.env,FAKE_CLAUDE_MODE:'ok',FAKE_CLAUDE_ARGS_FILE:argsFile,FAKE_CODEX_THREAD_FILE:threadFile,FAKE_CODEX_STATE_FILE:path.join(root,'native.json')},
      onDone:(_id,_reason,commit)=>commit(),onError:e=>{failure=e;}});
    await child.exited;assert.equal(failure,undefined);
    return JSON.parse(await fs.readFile(path.join(conversationDir(root,conversation.key),'state.json'))).segments;
  };
  await changeGuidance(root,input(0,'one'),source);
  assert.equal((await turn()).length,1);
  const sent=provider==='claude'?await fs.readFile(argsFile,'utf8'):await fs.readFile(threadFile,'utf8');
  assert.match(sent,/Explain intuition before code/);assert.match(sent,/Never fabricate evidence/);assert.match(sent,/without asking for review or approval/);
  assert.equal((await turn()).length,1);
  await changeGuidance(root,input(1,'unrelated',{rule:{...rule,id:'design',scope:'design'}}),source);
  assert.equal((await turn()).length,1);
  await changeGuidance(root,input(2,'change',{rule:{...rule,text:'Start with a concrete example.'}}),source);
  const changed=await turn();assert.equal(changed.length,2);assert.equal(changed.at(-1).reason,'instructions-or-tools-changed');
  await changeGuidance(root,input(3,'undo',{operation:'restore',rule:undefined,restoreRevision:1}),source);
  assert.equal((await turn()).length,3);
});
