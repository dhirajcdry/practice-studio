import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const connectorSource = await fs.readFile(new URL('../../../extension/background.js', import.meta.url), 'utf8');
const json = data => ({ok:true, headers:{get:()=> 'application/json'}, json:async()=>data});
const stalled = signal => new Promise((_, reject) => {
  assert.ok(signal, 'every network operation must have a deadline');
  if (signal.aborted) reject(new Error('aborted'));
  else signal.addEventListener('abort', () => reject(new Error('aborted')), {once:true});
});
// `frozen` lists tab ids whose scripts never come back, as in a tab the browser froze.
function load(fetch, {frozen=[]}={}) {
  const timers=[];
  const tabs={created:[], removed:[]};
  const updated=new Set();
  const context={fetch, location:{origin:'https://leetcode.com'}, Date, URL,
    setTimeout:(fn,ms)=>setTimeout(fn, Math.min(ms,1)), clearTimeout,
    AbortSignal:{timeout(ms){ assert.ok(ms>0 && ms<=15000); const c=new AbortController(); timers.push(setTimeout(()=>c.abort(),5)); return c.signal; }},
    chrome:{runtime:{onConnect:{addListener(){}},onInstalled:{addListener(){}}}, cookies:{get:async()=>({value:'fake-test-value'})},
      tabs:{query:async()=>[{id:1,status:'complete',url:'https://leetcode.com/problemset/'}],
        create:async({url})=>{const id=10+tabs.created.length;tabs.created.push(url);setTimeout(()=>updated.forEach(fn=>fn(id,{status:'complete'})),0);return {id};},
        remove:async id=>{tabs.removed.push(id);},
        onUpdated:{addListener:fn=>updated.add(fn),removeListener:fn=>updated.delete(fn)}},
      scripting:{executeScript:({target,func,args})=>frozen.includes(target.tabId)
        ? new Promise(()=>{})
        : Promise.resolve(func(...args)).then(result=>[{result}])}}};
  vm.createContext(context);
  vm.runInContext(connectorSource+'\nglobalThis.api={submit,pageSubmit,pollVerdict,inFlight};',context);
  return {api:context.api, tabs, clean:()=>timers.forEach(clearTimeout)};
}
const request={slug:'car-fleet',code:'class Solution: pass',lang:'python3'};

test('stalled lookup sends no submission and releases the per-problem lock', async t=>{
  let calls=0;
  const {api,clean}=load(async(url,{signal})=>{calls++;assert.match(url,/graphql/);return stalled(signal);});t.after(clean);
  const first=api.submit(request);
  const duplicate=await api.submit(request);
  assert.equal(duplicate.code,'SUBMIT_IN_FLIGHT');
  assert.match(duplicate.message,/does not confirm/);
  const result=await first;
  assert.equal(result.submissionState,'not_sent');
  assert.equal(calls,1);assert.equal(api.inFlight.size,0);
  const second=await api.submit(request); // a separate explicit action can proceed
  assert.notEqual(second.code,'SUBMIT_IN_FLIGHT');assert.equal(calls,2);
});

test('a stalled lookup response body cannot proceed to submit', async t=>{
  let calls=0;
  const {api,clean}=load(async(_,{signal})=>{calls++;return {...json(null),json:()=>stalled(signal)};});t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.submissionState,'not_sent');assert.equal(calls,1);assert.equal(api.inFlight.size,0);
});

for (const phase of ['request','body']) test(`stalled submit ${phase} stays unknown, releases lock, and never retries`,async t=>{
  let posts=0;
  const {api,clean}=load(async(url,{signal})=>{
    if(url.endsWith('/graphql/'))return json({data:{question:{questionId:'853'}}});
    posts++;
    return phase==='request'?stalled(signal):{...json(null),json:()=>stalled(signal)};
  });t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.submissionState,'unknown');assert.equal(posts,1);assert.equal(api.inFlight.size,0);
});

test('a stalled poll cannot bypass the judge ceiling and retains the submission id',async t=>{
  const {api,clean}=load(async(url,{signal})=>{assert.match(url,/\/check\/$/);return stalled(signal);});t.after(clean);
  const result=await api.pollVerdict(1,'123','fake',20);
  assert.equal(result.code,'JUDGE_TIMEOUT');assert.equal(result.submissionState,'submitted');assert.equal(result.submissionId,'123');
});

test('successful submission still makes exactly one POST and returns the verdict',async t=>{
  let posts=0;
  const {api,clean}=load(async(url,options)=>{
    if(url.endsWith('/submit/')){posts++;return json({submission_id:'123'});}
    if(url.endsWith('/check/'))return json({state:'SUCCESS',status_code:10});
    if(JSON.parse(options.body).operationName==='questionData')return json({data:{question:{questionId:'853'}}});
    return json({data:{submissionDetails:{runtime:1}}});
  });t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.ok,true);assert.equal(result.check.status_code,10);assert.equal(posts,1);assert.equal(api.inFlight.size,0);
});

const answering=(posts)=>async(url,options)=>{
  if(url.endsWith('/submit/')){posts.count++;return json({submission_id:'123'});}
  if(url.endsWith('/check/'))return json({state:'SUCCESS',status_code:10});
  if(JSON.parse(options.body).operationName==='questionData')return json({data:{question:{questionId:'853'}}});
  return json({data:{submissionDetails:{runtime:1}}});
};

test('a frozen LeetCode tab is skipped for a fresh one, and the submission goes through once',async t=>{
  const posts={count:0};
  const {api,tabs,clean}=load(answering(posts),{frozen:[1]});t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.ok,true);assert.equal(posts.count,1);
  assert.deepEqual(tabs.created,['https://leetcode.com/problems/car-fleet/']);
  assert.deepEqual(tabs.removed,[10]);assert.equal(api.inFlight.size,0);
});

test('when no LeetCode tab answers, nothing is sent and the lock is released',async t=>{
  const posts={count:0};
  const {api,clean}=load(answering(posts),{frozen:[1,10]});t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.submissionState,'not_sent');assert.equal(result.code,'JUDGE_UNREACHABLE');
  assert.equal(posts.count,0);assert.equal(api.inFlight.size,0);
});

test('a tab that freezes after the lookup is unknown, never retried, and releases the lock',async t=>{
  const posts={count:0};
  const frozen=[];
  const fetch=answering(posts);
  const {api,clean}=load(async(url,options)=>{
    if(url.endsWith('/graphql/'))frozen.push(1); // the next script into tab 1 never returns
    return fetch(url,options);
  },{frozen});t.after(clean);
  const result=await api.submit(request);
  assert.equal(result.submissionState,'unknown');assert.equal(posts.count,0);assert.equal(api.inFlight.size,0);
});
