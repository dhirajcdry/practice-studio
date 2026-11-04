import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRequestInspection, finishRequestInspection, requestInspectionRoutes, _inspection } from '../request-inspection.mjs';

test('inspection ring is root-isolated and summary/full shapes preserve exact bounded text', async () => {
  const a = `/tmp/inspect-a-${Date.now()}`, b = `${a}-b`;
  recordRequestInspection(a, { id: 'one', provider: 'codex', prompt: 'QUESTION', systemPrompt: 'RULES', toolSchemas: 'SCHEMA', input: { promptCharacters: 8 } });
  finishRequestInspection(a, 'one', { status: 'failed', usage: null });
  const sent = []; const res = { writeHead(_s, _h) {}, end(body) { sent.push(JSON.parse(body)); } };
  await requestInspectionRoutes(ctx => ctx.homeRoot)['GET /api/coach/context']({ url: '/api/coach/context' }, res, { homeRoot: a });
  assert.equal(sent[0].requests[0].promptCharacters, 8); assert.equal(sent[0].requests[0].status, 'failed');
  await requestInspectionRoutes(ctx => ctx.homeRoot)['GET /api/coach/context']({ url: '/api/coach/context?id=one' }, res, { homeRoot: a });
  assert.equal(sent[1].request.prompt, 'QUESTION'); assert.equal(sent[1].request.systemPrompt, 'RULES'); assert.equal(sent[1].request.toolSchemas, 'SCHEMA');
  await requestInspectionRoutes(ctx => ctx.homeRoot)['GET /api/coach/context']({ url: '/api/coach/context' }, res, { homeRoot: b });
  assert.equal(sent[2].requests.length, 0);
});

test('inspection ring evicts old entries when count exceeds twenty', () => {
  const root = `/tmp/inspect-ring-${Date.now()}`;
  for (let i = 0; i < 25; i++) recordRequestInspection(root, { id: String(i), prompt: '', systemPrompt: '', toolSchemas: '' });
  assert.equal(_inspection.rings.get(root).length, 20); assert.equal(_inspection.rings.get(root)[0].id, '5');
});

test('byte-budget eviction retains exact latest request and rejects cross-root detail',async()=>{
  const root=`/tmp/inspect-bytes-${Date.now()}`;
  for(let i=0;i<4;i++)recordRequestInspection(root,{id:String(i),prompt:'x'.repeat(350000),systemPrompt:'rules',toolSchemas:'[]'});
  const rows=_inspection.rings.get(root);assert.equal(rows.length,2);assert.equal(rows.at(-1).prompt.length,350000);
  let status,body;const res={writeHead(s){status=s;},end(s){body=JSON.parse(s);}};
  await requestInspectionRoutes(ctx=>ctx.homeRoot)['GET /api/coach/context']({url:'/api/coach/context?id=3'},res,{homeRoot:root+'-other'});
  assert.equal(status,404);assert.equal(body.request,undefined);
});

test('section counts cover payload once and ignore headings inside fenced learner data',async()=>{
  const {contextData}=await import('../context-packet.mjs');
  const prompt='Instructions\n\n'+contextData('Code','## PRIVATE HEADING\nprint(42)')+'\n\n## Question\nExplain';
  const item=recordRequestInspection('/tmp/inspect-sections',{id:'sections',prompt});
  assert.equal(item.sections.reduce((n,s)=>n+s.characters,0),prompt.length);
  assert.ok(!item.sections.some(s=>s.name.includes('PRIVATE')));
  finishRequestInspection('/tmp/inspect-sections','sections',{status:'stopped'});assert.equal(item.status,'stopped');
});
