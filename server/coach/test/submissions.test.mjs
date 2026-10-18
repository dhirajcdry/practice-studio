import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ActionStore, createToolSession, validateArgs } from '../tools.mjs';
test('get_submissions reads validated local records with a receipt and never needs a judge', async t => {
 const root = await fsp.mkdtemp(path.join(os.tmpdir(),'studio-submission-tool-')); t.after(()=>fsp.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'problems','two-sum'); await fsp.mkdir(path.join(dir,'submissions'),{recursive:true});
 await fsp.writeFile(path.join(dir,'meta.json'),JSON.stringify({submissions:[{submissionId:'12',codeFile:'submissions/12.py',verdict:'Accepted',accepted:true,at:'2026-10-18'}]}));
 await fsp.writeFile(path.join(dir,'submissions/12.py'),'return 42');
 const tools=createToolSession({root,slug:'two-sum',store:new ActionStore()}); t.after(()=>tools.dispose());
 const list=await tools.call('get_submissions',{}); assert.equal(list.ok,true); assert.equal(JSON.parse(list.text).summary.total,1); assert.ok(!list.text.includes('return 42'));
 const full=await tools.call('get_submissions',{submission_id:'12'}); assert.equal(JSON.parse(full.text).code,'return 42'); assert.equal(tools.actions.length,2);
 assert.equal((await tools.call('get_submissions',{submission_id:'../elsewhere'})).ok,false);
 assert.equal(validateArgs('get_submissions',{extra:true}).ok,false);
});

import { compactSubmissions, modelSubmission, submissionModelLine, readSubmissions } from '../../judge/submissions.mjs';
import { SessionLog } from '../sessions.mjs';
import { gatherContext, buildPrompt } from '../context.mjs';

test('50 saved submissions stay compact and distributions never enter model projections', async t => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-submission-budget-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(path.join(dir, 'submissions'), { recursive: true });
  const rows = Array.from({ length: 50 }, (_, i) => ({
    submissionId: String(i + 1), at: new Date(2026, 9, 18, 9, i).toISOString(),
    verdict: 'Time Limit Exceeded', testsPassed: 79, testsTotal: 178,
    codeFile: `submissions/${i + 1}.py`, runtimeMs: 23, beatsRuntimePct: 44,
  }));
  await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ submissions: rows }));
  await fsp.writeFile(path.join(dir, 'solution.py'), 'return 3');
  await fsp.writeFile(path.join(dir, 'submissions/50.py'), 'return 2');
  await fsp.writeFile(path.join(dir, 'submissions/50.json'), JSON.stringify({
    schemaVersion: 1, submissionId: '50',
    failure: { runtimeError: 'x'.repeat(4000) },
    details: { runtime: { distribution: [{ bucket: 123456, pct: 99 }] } },
  }));
  const saved = await readSubmissions({ root, slug: 'two-sum' });
  assert.ok(compactSubmissions(saved).length < 200);
  assert.doesNotMatch(JSON.stringify(modelSubmission(saved[0])), /distribution|123456/);
  assert.match(JSON.stringify(modelSubmission(saved[0])), /trimmed, 4000 chars total/);
  assert.doesNotMatch(submissionModelLine(saved[0]), /distribution|123456/);
  const context = await gatherContext({ root, slug: 'two-sum', sessionLog: new SessionLog({ root }), attach: { submissionId: '50' } });
  assert.ok(context.submissions.length < 200);
  const { prompt } = buildPrompt({ context, message: 'Explain my submission', fenceToken: 'BUDGET' });
  assert.doesNotMatch(prompt, /distribution|123456/);
  const session = createToolSession({ root, slug: 'two-sum', store: new ActionStore() });
  t.after(() => session.dispose());
  const list = await session.call('get_submissions', {});
  assert.equal(JSON.parse(list.text).submissions.length, 10);
  const detail = await session.call('get_submissions', { submission_id: '50' });
  assert.doesNotMatch(list.text + detail.text, /distribution|123456/);
});

// The tutor has no clock of its own. A bare "at 09:05" made a three-day-old verdict read
// as this morning's, so every projection says how long ago, and how the learner got there.
test('the tutor sees when each submission happened, the gap to the previous one, and the lead-up', async () => {
  const { compactSubmissions, submissionModelLine, submittedWhen, modelSubmission } = await import('../../judge/submissions.mjs');
  const now = Date.parse('2026-10-18T11:00:00-04:00');
  const tle = { at: '2026-10-18T10:48:00-04:00', verdict: 'Time Limit Exceeded', testsPassed: 79, testsTotal: 178,
    leadUp: { minutes: 12, localRuns: 3, coachAsks: 1 } };
  const accepted = { at: '2026-10-18T10:40:00-04:00', verdict: 'Accepted', accepted: true, runtimeMs: 23, beatsRuntimePct: 44.0067 };

  assert.equal(submittedWhen('2026-10-18T10:59:40-04:00', now), 'just now');
  assert.equal(submittedWhen(tle.at, now), '12 min ago');
  assert.equal(submittedWhen('2026-10-17T14:20:00-04:00', now), 'yesterday 14:20');
  assert.equal(submittedWhen('2026-10-15T09:05:00-04:00', now), 'Oct 15 09:05');
  assert.equal(submittedWhen('not a date', now), null);

  const line = compactSubmissions([tle, accepted], now);
  assert.match(line, /latest Time Limit Exceeded 79\/178, 12 min ago; best accepted 23 ms, beats 44%/);
  assert.ok(line.length < 200);

  const row = submissionModelLine(tle, { now, previous: accepted });
  assert.match(row, /when=12 min ago/);
  assert.match(row, /sincePrevious=8 min after the previous submission/);
  assert.match(row, /leadUp=12 min into the session, 3 local runs before it, asked the coach 1×/);

  // Facts that weren't recorded are left out, never guessed.
  const bare = modelSubmission({ at: tle.at, verdict: 'Wrong Answer' }, { code: false, now });
  assert.equal(bare.leadUp, undefined);
  assert.equal(bare.sincePrevious, undefined);
});
