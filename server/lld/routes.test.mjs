import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs/promises'; import os from 'node:os'; import path from 'node:path'; import { Readable } from 'node:stream';
import { InterviewService, interviewRoutes } from '../interview/routes.mjs'; import { routes } from './routes.mjs';
const binary = new URL('../interview/test/fake-interviewer.mjs', import.meta.url).pathname;
async function fixture(t) { const root=await fs.mkdtemp(path.join(os.tmpdir(),'lld-test-')); t.after(()=>fs.rm(root,{recursive:true,force:true})); const interview=new InterviewService({root,binary}); async function call(table,method,url,body={},params={}) { const key=Object.keys(table).find(k=>{ const [verb,pattern]=k.split(' '), parts=url.split('/'); return verb===method && pattern.split('/').length===parts.length && pattern.split('/').every((part,i)=>part.startsWith(':') || part===parts[i]); }); assert.ok(key); const req=Readable.from([Buffer.from(JSON.stringify(body))]); req.url=url; req.method=method; let output='',status; const res={writeHead(c){status=c},write(c){output+=c},end(c=''){output+=c},flushHeaders(){}}; await table[key](req,res,{interview,homeRoot:root,params}); return {status,output,events:[...output.matchAll(/event: (.+)\ndata: (.+)\n/g)].map(m=>({name:m[1],data:JSON.parse(m[2])}))}; } return {root,interview,call}; }
async function start(f) { const r=await f.call(interviewRoutes,'POST','/api/interview/start',{discipline:'lld',slug:'lld-locker',statement:'forged',code:'bad()',mode:'typed',minutes:45}); return {slug:'lld-locker',id:r.events.find(e=>e.name==='interview').data.id}; }
test('blank document GET',async t=>{const f=await fixture(t),x=await start(f); const e=await f.call(routes,'GET',`/api/lld/${x.slug}/${x.id}/code`,{},{slug:x.slug,id:x.id}); assert.deepEqual(JSON.parse(e.output),{code:''});});
test('Python success and failure return output/status',async t=>{const f=await fixture(t),x=await start(f); const ok=JSON.parse((await f.call(routes,'POST','/api/lld/run',{slug:x.slug,interviewId:x.id,code:'print("hello")'})).output); assert.equal(ok.status,'ok'); assert.equal(ok.exitCode,0); assert.match(ok.stdout,/hello/); const bad=JSON.parse((await f.call(routes,'POST','/api/lld/run',{slug:x.slug,interviewId:x.id,code:'raise AssertionError("no")'})).output); assert.match(bad.stderr,/AssertionError/); assert.notEqual(bad.exitCode,0);});
test('nonexistent and completed sessions reject mutation',async t=>{const f=await fixture(t),x=await start(f); await assert.rejects(f.call(routes,'PUT',`/api/lld/${x.slug}/${x.id}/code`,{code:'x'},{slug:x.slug,id:'0000000000000-deadbeef'})); const s=await f.interview.store.readState(x.slug,x.id); s.debriefed=true; await f.interview.store.writeState(x.slug,x.id,s); await assert.rejects(f.call(routes,'PUT',`/api/lld/${x.slug}/${x.id}/code`,{code:'x'},{slug:x.slug,id:x.id})); await assert.rejects(f.call(routes,'POST','/api/lld/run',{slug:x.slug,interviewId:x.id,code:'x'}));});

test('code-only LLD finish preserves the final buffer and requests a real debrief', async t => {
  const f = await fixture(t), x = await start(f), code = 'class Locker:\n    def release(self, token):\n        return token is not None\n';
  await f.call(routes, 'PUT', `/api/lld/${x.slug}/${x.id}/code`, { code }, x);
  const saved = await f.call(routes, 'GET', `/api/lld/${x.slug}/${x.id}/code`, {}, x);
  assert.equal(JSON.parse(saved.output).code, code);
  await f.call(interviewRoutes, 'POST', '/api/interview/done', { slug: x.slug, interviewId: x.id, code, requestId: 'code-only' });
  const state = await f.interview.store.readState(x.slug, x.id);
  assert.equal(state.debriefed, true);
  assert.notEqual(state.completionReason, 'no-response');
  assert.equal(state.lastCode, code);
  assert.ok((await f.interview.store.readTurns(x.slug, x.id)).some(t => t.kind === 'debrief'));
});
