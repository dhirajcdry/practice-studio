import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { normaliseLeetCodeDetails } from '../details.mjs';
import { deriveLeadUp, saveSubmissionDetails, readSubmissionDetails, readSubmissions, sidecarRecord, recordVerdict } from '../record.mjs';
import { handleSubmissionDetails, handleSubmissions, recordSubmission } from '../routes.mjs';
const fixture = JSON.parse(await fsp.readFile(new URL('./fixtures/details.json', import.meta.url), 'utf8'));
async function root(t) { const r = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-details-')); t.after(() => fsp.rm(r, { recursive: true, force: true })); return r; }
function response() { return { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } }; }
function request(body, url) { const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = url; return req; }

test('realistic distributions retain labels, sort, and reconcile KB separately from MB display', () => {
 const d = normaliseLeetCodeDetails(fixture.accepted);
 assert.equal(d.runtime.ms,23); assert.equal(d.memory.mb,20.1); assert.equal(d.memory.unit,'KB');
 assert.deepEqual(d.runtime.distribution.map(p=>p.bucket),[12,23,34]); assert.equal(d.runtime.percentile,44.51);
 assert.equal(normaliseLeetCodeDetails({...fixture.accepted,memory:8}).memory.unit,null);
 assert.equal(normaliseLeetCodeDetails({}).runtime.ms,null); assert.equal(normaliseLeetCodeDetails({runtime:null,runtimePercentile:null}).runtime.percentile,null);
});
test('failure fields are verbatim, bounded and never coerced', () => {
 for (const name of ['tle','runtime','compile']) for (const [key,value] of Object.entries(fixture[name]).filter(([key, value]) => !key.startsWith('full') && typeof value === 'string')) assert.equal(normaliseLeetCodeDetails(fixture[name])[key],value);
 assert.equal(normaliseLeetCodeDetails({lastTestcase: '  x\n'}).lastTestcase,'  x\n');
 assert.equal(normaliseLeetCodeDetails({runtimeError:'x'.repeat(30000)}).runtimeError.length,20480);
 assert.equal(normaliseLeetCodeDetails({lastTestcase:{x:1}}).lastTestcase,null);
 const d=normaliseLeetCodeDetails({runtimeDistribution:{distribution:[['x',3],['2',101],['3',null],...Array.from({length:500},(_,i)=>[String(i),1])]}});
 assert.equal(d.runtime.distribution.length,400); assert.equal(normaliseLeetCodeDetails({runtimeDistribution:'garbage'}).runtime.distribution.length,0);
});
test('lead-up counts only logged actions since the preceding submission in this sitting', () => {
 const events=['problem_opened','ran_locally','submitted','run_result','ran_locally','asked_coach','coach_ran_code'].map((type,i)=>({type,at:`2026-10-18T00:0${i}:00Z`}));
 assert.deepEqual(deriveLeadUp(events,'2026-10-18T00:12:00Z'),{minutes:12,localRuns:1,coachAsks:1});
 assert.deepEqual(deriveLeadUp(events.slice(1),'2026-10-18T00:12:00Z'),{minutes:11,localRuns:1,coachAsks:1});
});

test('lead-up prefers the latest attempt and counts local runs before the submit', () => {
 const events = [
  { type: 'attempt_started', at: '2026-10-18T00:00:00Z' },
  { type: 'ran_locally', at: '2026-10-18T00:01:00Z' },
  { type: 'attempt_started', at: '2026-10-18T00:10:00Z' },
  { type: 'ran_locally', at: '2026-10-18T00:11:00Z' },
 ];
 assert.deepEqual(deriveLeadUp(events, '2026-10-18T00:12:00Z'), { minutes: 2, localRuns: 1, coachAsks: 0 });
});
test('record persists failure and optional details; routes merge old records without losing code or lead-up', async t => {
 const r=await root(t); const slug='two-sum'; const id='987654321';
 const recorded=await recordSubmission({homeRoot:r,slug,submissionId:id,code:'print(1)',check:{state:'SUCCESS',status_code:14,total_correct:79,total_testcases:178,last_testcase:'[1]'},details:fixture.tle,log:{warn(){}}});
 assert.equal(recorded.recorded.sidecar,true);
 const saved=await readSubmissionDetails({root:r,slug,submissionId:id}); assert.equal(saved.failure.lastTestcase,'[1]'); assert.equal(saved.schemaVersion,1);
 const get=response(); await handleSubmissions({url:`/api/problems/${slug}/submissions`},get,{homeRoot:r});
 assert.equal(get.body.summary.total,1); assert.equal(get.body.submissions[0].code,'print(1)');
 const res=response(); await handleSubmissionDetails(request({details:fixture.accepted},`/api/problems/${slug}/submissions/${id}/details`),res,{homeRoot:r});
 assert.equal(res.body.details.runtime.ms,23); assert.equal(res.body.failure.lastTestcase,'[1]');
 await assert.rejects(handleSubmissionDetails(request({details:{}},`/api/problems/${slug}/submissions/99/details`),response(),{homeRoot:r}),/not found/);
 await assert.rejects(handleSubmissions({url:'/api/problems/../submissions'},response(),{homeRoot:r}),/invalid/);
});
test('old entries have explicit missing sidecars and unsafe code paths are ignored', async t => {
 const r=await root(t); const dir=path.join(r,'problems','two-sum'); await fsp.mkdir(dir,{recursive:true});
 await fsp.writeFile(path.join(dir,'meta.json'),JSON.stringify({submissions:[{submissionId:'1',codeFile:'../../secret.py',at:'2026-10-18'}]}));
 const [s]=await readSubmissions({root:r,slug:'two-sum'}); assert.equal(s.code,null); assert.equal(s.failure,null); assert.equal(s.details,null); assert.equal(s.hasDetails,false);
});

test('fetching details for an old record creates a sidecar, and a failed write is best-effort', async t => {
 const r=await root(t); const dir=path.join(r,'problems','two-sum'); await fsp.mkdir(dir,{recursive:true});
 await fsp.writeFile(path.join(dir,'meta.json'),JSON.stringify({submissions:[{submissionId:'44',source:'studio',at:'2026-10-17',verdict:'Accepted',accepted:true}]}));
 const res=response(); await handleSubmissionDetails(request({details:fixture.accepted},'/api/problems/two-sum/submissions/44/details'),res,{homeRoot:r});
 assert.equal(res.body.hasDetails,true); assert.equal(res.body.leadUp,null); assert.equal(res.body.failure,null);
 const blocked=path.join(r,'not-a-directory'); await fsp.writeFile(blocked,'x');
 const recorded=await recordSubmission({homeRoot:blocked,slug:'two-sum',submissionId:'987654322',code:'pass',check:{state:'SUCCESS',status_code:10},log:{warn(){}}});
 assert.equal(recorded.accepted,true); assert.equal(recorded.recorded.sidecar,false); assert.match(recorded.recorded.note,/could not be saved/);
});
