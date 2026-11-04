import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { routes } from './routes.mjs';
import { readLearnerProfile } from '../learning/profile.mjs';
import { problemDir } from '../storage-layout.mjs';
import { beginConversation } from '../coach/native-sessions.mjs';
import { sceneHash } from './board-history.mjs';

function response() { let value = ''; return { writeHead() {}, write(x) { value += x; }, end(x = '') { value += x; }, json() { return JSON.parse(value); }, text: () => value }; }
async function call(key, body, ctx, params = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = '/api/practice?discipline=lld'; req.headers = {};
  const res = response(); await routes[key](req, res, { ...ctx, params }); return res;
}
async function fixture(t, practiceRun = () => { throw Error('Unexpected model turn'); }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-practice-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'opus' }));
  const ctx = { homeRoot: root, practiceRun };
  const problem = (...parts) => path.join(problemDir(root, 'lld-locker'), ...parts);
  const { session } = (await call('POST /api/practice/start', { slug: 'lld-locker', discipline: 'lld', mode: 'voice', title: 'Fake title', statement: 'Fake instructions' }, ctx)).json();
  const record = () => call('GET /api/practice/:slug/:id', {}, ctx, session).then(r => r.json());
  return { root, ctx, session, record, problem, ask: extra => call('POST /api/practice/ask', { slug: session.slug, id: session.id, requestId: 'question-one', question: 'What could race here?', ...extra }, ctx) };
}
test('board saves retain exact prior scenes, including when a later save clears the board', async t => {
  const f = await fixture(t);
  const { session } = (await call('POST /api/practice/start', { discipline: 'design' }, f.ctx)).json();
  const first = [{ id: 'requirements', type: 'text', text: 'Reserve tickets atomically', version: 1 }];
  const second = [{ ...first[0], text: 'Reserve tickets atomically; release expired holds', version: 2 }];
  const directory = path.join(problemDir(f.root, session.slug), 'practice', session.id);
  for (const elements of [first, second, []]) await call('PUT /api/practice/:slug/:id', { elements }, f.ctx, session);
  assert.deepEqual((await call('GET /api/practice/:slug/:id', {}, f.ctx, session)).json().elements, []);
  for (const elements of [first, second, []]) {
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'board-history', `${sceneHash(elements)}.json`))), elements);
  }
  const corrupt = path.join(directory, 'board-history', `${sceneHash(first)}.json`);
  await fs.writeFile(corrupt, '{broken');
  await assert.rejects(call('PUT /api/practice/:slug/:id', { elements: first }, f.ctx, session), /corrupted/);
  assert.deepEqual((await call('GET /api/practice/:slug/:id', {}, f.ctx, session)).json().elements, []);
});
test('practice is untimed, server-resolved, durable, and isolated from mocks', async t => {
  const f = await fixture(t);
  assert.equal(f.session.title, 'Locker system'); assert.match(f.session.statement, /locker/i);
  assert.equal(f.session.minutes, undefined);
  assert.equal(f.session.timer.elapsedMs, 0);
  assert.ok(Number.isFinite(f.session.timer.runningSince));
  const initial = (await f.record()).session.timer;
  assert.deepEqual(initial, f.session.timer);
  await call('PUT /api/practice/:slug/:id', { code: 'print(1)', mode: 'typed' }, f.ctx, f.session);
  assert.equal((await f.record()).code, 'print(1)'); assert.equal((await f.record()).session.mode, 'typed');
  assert.deepEqual(await fs.readdir(f.problem()), ['practice']);
  assert.equal((await call('GET /api/practice', {}, f.ctx)).json().sessions.length, 1);
});

test('practice timer pause and resume is durable and does not overwrite work autosaves', async t => {
  const f = await fixture(t);
  const first = (await f.record()).session.timer;
  const pause = (await call('POST /api/practice/:slug/:id/timer', { running: false }, f.ctx, f.session)).json();
  assert.equal(pause.timer.runningSince, null);
  assert.ok(pause.timer.elapsedMs >= 0);
  await Promise.all([
    call('PUT /api/practice/:slug/:id', { code: 'answer = 42', mode: 'typed' }, f.ctx, f.session),
    call('POST /api/practice/:slug/:id/timer', { running: false }, f.ctx, f.session),
  ]);
  const restarted = await import('./routes.mjs?timer-restart');
  const read = response();
  await restarted.routes['GET /api/practice/:slug/:id']({}, read, { ...f.ctx, params: f.session });
  assert.deepEqual(read.json().session.timer, pause.timer, 'paused state survives a server restart');
  const resume = (await call('POST /api/practice/:slug/:id/timer', { running: true }, f.ctx, f.session)).json();
  assert.ok(Number.isFinite(resume.timer.runningSince));
  assert.equal(resume.timer.elapsedMs, pause.timer.elapsedMs);
  const repeated = (await call('POST /api/practice/:slug/:id/timer', { running: true }, f.ctx, f.session)).json();
  assert.deepEqual(repeated.timer, resume.timer, 'repeated resume does not reset the start time');
  const saved = await f.record();
  assert.equal(saved.code, 'answer = 42');
  assert.equal(saved.session.mode, 'typed');
  assert.deepEqual(saved.session.timer, resume.timer);
  assert.equal(saved.serverNow > 0, true);
  assert.deepEqual(first, f.session.timer);
});

test('legacy practice sessions keep their existing timer shape until explicitly started', async t => {
  const f = await fixture(t);
  const file = f.problem('practice', f.session.id, 'session.json');
  const legacy = JSON.parse(await fs.readFile(file));
  delete legacy.timer;
  await fs.writeFile(file, JSON.stringify(legacy));
  const before = await f.record();
  assert.equal(before.session.timer, undefined);
  assert.ok(Number.isFinite(before.serverNow));
  const started = (await call('POST /api/practice/:slug/:id/timer', { running: true }, f.ctx, f.session)).json();
  assert.equal(started.timer.elapsedMs, 0);
  assert.ok(Number.isFinite(started.timer.runningSince));
});

test('open practice starts blank for either discipline without a model and accepts a durable learner-defined topic', async t => {
  const f=await fixture(t);
  for(const discipline of ['lld','design']) {
    const {session}=(await call('POST /api/practice/start',{discipline},f.ctx)).json();
    assert.equal(session.openEnded,true);assert.equal(session.title,'Open practice');assert.equal(session.statement,'');assert.equal(session.mode,'voice');
    const get=()=>call('GET /api/practice/:slug/:id',{},f.ctx,session).then(r=>r.json());
    assert.deepEqual((await get()).exchanges,[]);
    await call('PUT /api/practice/:slug/:id',{topic:{title:'Unvalidated metadata',statement:[]}},f.ctx,session);
    assert.equal((await get()).session.title,'Open practice','autosave cannot write unvalidated topic metadata');
    await call('PUT /api/practice/:slug/:id',{code:'learner_code = 42',elements:[{id:'mine',type:'rectangle'}]},f.ctx,session);
    let received,result;
    const ctx={...f.ctx,practiceRun:opts=>{received=opts;void(async()=>{
      result=await opts.toolSession.call('set_practice_problem',{title:'Custom inventory repair',statement:'Track replacement parts and reject duplicate reservations.'});
      opts.onToken('What would you like to explore first?');opts.onDone();
    })().catch(opts.onError);}};
    const reply=await call('POST /api/practice/ask',{slug:session.slug,id:session.id,requestId:'define',question:'Let’s practise an inventory repair system.'},ctx);
    assert.equal(result.ok,true);assert.match(reply.text(),/event: practice_topic/);assert.match(received.systemPrompt,/any learner-chosen problem/);
    const saved=await get();assert.equal(saved.session.title,'Custom inventory repair');assert.match(saved.session.statement,/reject duplicate/);
    assert.equal(saved.code,'learner_code = 42');assert.equal(saved.elements[0].id,'mine');assert.equal(saved.exchanges[0].actions[0].tool,'set_practice_problem');
    assert.equal(saved.session.slug,session.slug,'stable identity keeps notes and evidence together');
    const other=(await call('POST /api/practice/start',{discipline},f.ctx)).json().session;
    assert.notEqual(other.slug,session.slug);assert.equal(other.statement,'');
  }
});

test('preset practice cannot rewrite its problem through agent tools', async t => {
  let result;
  const f=await fixture(t,opts=>{void(async()=>{result=await opts.toolSession.call('set_practice_problem',{title:'Replacement',statement:'Changed'});opts.onToken('Keep exploring.');opts.onDone();})().catch(opts.onError);});
  await f.ask();assert.equal(result.ok,false);assert.equal((await f.record()).session.title,'Locker system');
});
test('a real adapter tool echo appears once in practice SSE, completion and saved history', async t => {
  const {runCoachTurn} = await import('../coach/claude-cli.mjs');
  let handle;
  const f = await fixture(t, options => handle = runCoachTurn({ ...options,
    binary: new URL('../coach/test/bin/fake-claude.mjs', import.meta.url).pathname,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'tool-echo' },
  }));
  const response = await f.ask(); await handle.exited;
  const events = response.text().trim().split('\n\n').filter(block => /^data: /m.test(block)).map(block => ({
    event: block.match(/^event: (.+)$/m)?.[1], data: JSON.parse(block.match(/^data: (.+)$/m)[1]),
  }));
  const expected = 'Yes, size matters. Each package is small, medium or large.';
  assert.equal(events.filter(e => e.event === 'token').map(e => e.data.text).join(''), expected);
  assert.equal(events.find(e => e.event === 'done').data.answer, expected);
  assert.equal((await f.record()).exchanges[0].answer, expected);
});
test('ask receives context, persists before execution, preserves history and provider choices', async t => {
  let seen, before, calls = 0;
  const f = await fixture(t, opts => { calls++; seen = opts; before = f.record(); opts.onToken('Check the critical section.'); opts.onDone(); });
  await call('PUT /api/practice/:slug/:id', { code: 'class Locker: pass' }, f.ctx, f.session);
  await fs.writeFile(f.problem('NOTES.md'), 'Review atomic reservations.');
  const reply = await f.ask();
  assert.match(reply.text(), /event: done/); assert.equal((await before).exchanges[0].question, 'What could race here?');
  assert.equal(seen.tools, ''); assert.equal(seen.choice.model, 'opus'); assert.equal(seen.root, f.root);
  assert.match(seen.prompt, /class Locker/); assert.match(seen.prompt, /atomic reservations/); assert.match(seen.systemPrompt, /untimed practice/);
  await f.ask(); assert.equal(calls, 1, 'completed requests replay without a turn');
  await assert.rejects(f.ask({ question: 'Different question' }), e => e.status === 409);
  await f.ask({ requestId: 'question-two', question: 'Why?' });
  assert.match(seen.prompt, /Check the critical section/); assert.equal((await f.record()).exchanges.length, 2);
  const profile = await readLearnerProfile(f.root);
  assert.equal(profile.observations.filter(o => o.type === 'practice_question').length, 2);
  assert.equal(profile.attempted.lld.length, 1); assert.equal(profile.completed.lld.length, 0);
});
test('reopened practice reads growing live text before completion without restarting generation', async t => {
  let controls, started, calls = 0;
  const ready = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, options => { controls = options; calls++; started(); });
  const running = f.ask(); await ready;
  controls.onToken('First visible words.');
  const first = await f.record();
  assert.equal(first.busy, true); assert.equal(first.exchanges[0].status, 'pending');
  assert.equal(first.exchanges[0].answer, 'First visible words.');
  controls.onToken(' More words.');
  assert.equal((await f.record()).exchanges[0].answer, 'First visible words. More words.');
  controls.onDone(); await running;
  const finished = await f.record();
  assert.equal(finished.busy, false); assert.equal(finished.exchanges[0].status, 'complete');
  assert.equal(finished.exchanges[0].answer, 'First visible words. More words.'); assert.equal(calls, 1);
});
test('one reply per session, failure remains retryable with original evidence', async t => {
  let current;
  const f = await fixture(t, opts => { current = opts; });
  const pending = f.ask({ code: 'original = True' });
  while (!current) await new Promise(r => setImmediate(r));
  assert.equal((await f.record()).exchanges[0].status, 'pending');
  await assert.rejects(f.ask({ requestId: 'another' }), e => e.status === 409);
  current.onToken('Partial'); current.onError('Provider disconnected'); await pending;
  assert.equal((await f.record()).exchanges[0].status, 'failed');
  const first = current; const retry = f.ask({ code: 'changed = True' });
  while (current === first) await new Promise(r => setImmediate(r));
  assert.match(current.prompt, /original = True/); assert.doesNotMatch(current.prompt, /changed = True/);
  current.onToken('Complete'); current.onDone(); await retry;
  assert.equal((await f.record()).exchanges.length, 1); assert.equal((await f.record()).exchanges[0].answer, 'Complete');
});
test('empty replies fail and a stale pending record can be retried', async t => {
  const f = await fixture(t, opts => opts.onDone()); await f.ask();
  assert.equal((await f.record()).exchanges[0].status, 'failed');
  const file = f.problem('practice', f.session.id, 'exchanges.json');
  const exchanges = JSON.parse(await fs.readFile(file)); exchanges[0].status = 'pending'; await fs.writeFile(file, JSON.stringify(exchanges));
  assert.equal((await f.record()).exchanges[0].status, 'failed');
  f.ctx.practiceRun = opts => { opts.onToken('Recovered'); opts.onDone(); }; await f.ask();
  assert.equal((await f.record()).exchanges[0].answer, 'Recovered');
});
test('Python execution records evidence without grading', async t => {
  const f = await fixture(t);
  const r = (await call('POST /api/practice/run', { ...f.session, code: 'print("ok")' }, f.ctx)).json();
  assert.equal(r.stdout.trim(), 'ok'); assert.equal(r.exitCode, 0);
  const rows = await fs.readFile(f.problem('practice', f.session.id, 'runs.jsonl'), 'utf8'); assert.match(rows, /print/);
});
test('board persistence and invalid inputs', async t => {
  const f = await fixture(t);
  const { session } = (await call('POST /api/practice/start', { slug: 'design-url-shortener', discipline: 'design', mode: 'typed' }, f.ctx)).json();
  await call('PUT /api/practice/:slug/:id', { elements: [{ id: 'node' }] }, f.ctx, session);
  assert.deepEqual((await call('GET /api/practice/:slug/:id', {}, f.ctx, session)).json().elements, [{ id: 'node' }]);
  await assert.rejects(call('POST /api/practice/start', { slug: 'lld-locker', discipline: 'design', mode: 'voice' }, f.ctx), e => e.status === 400);
  await assert.rejects(f.ask({ code: 1 }), e => e.status === 400);
  await assert.rejects(f.ask({ elements: [null] }), e => e.status === 400);
  await assert.rejects(call('PUT /api/practice/:slug/:id', { elements: Array(2001).fill({}) }, f.ctx, session), e => e.status === 400);
  await assert.rejects(call('GET /api/practice/:slug/:id', {}, f.ctx, { slug: '../escape', id: 'x' }), e => e.status === 400);
});

async function sourceMock(root, { done = true, id = '1760000000000-00000009' } = {}) {
  const { InterviewStore } = await import('../interview/store.mjs');
  const { newState } = await import('../interview/state.mjs');
  const store = new InterviewStore({ root }), slug = 'lld-locker';
  const state = { ...newState({ slug, startedAt: Date.now() - 60000 }), discipline: 'lld', title: 'Original interview title',
    scenario: { statement: 'Design lockers with expiring pickup codes.' }, targetLevel: 'L4',
    lastCode: 'print("final mock")', debriefed: done, endedAt: done ? Date.now() : null };
  await store.create(slug, id, state);
  await store.append(slug, id, { kind: 'opening', asked: state.scenario.statement, elapsedMs: 0 });
  await store.append(slug, id, { kind: 'turn', said: 'I need atomic reservation.', asked: 'What happens when two users reserve it?', code: 'large discarded snapshot' });
  if (done) await store.append(slug, id, { kind: 'debrief', asked: 'Review expired codes and atomic reservation.', elapsedMs: 60000 });
  await fs.writeFile(path.join(store.dir(slug, id), 'code.py'), 'print("latest saved mock")');
  return { store, slug, id, state, directory: store.dir(slug, id) };
}
test('branch captures source prompt, final Python, feedback and provenance in one creation', async t => {
  let seen;
  const f = await fixture(t, opts => { seen = opts; opts.onToken('Check expiration before reserving.'); opts.onDone(); });
  const mock = await sourceMock(f.root);
  const before = await Promise.all(['interview.json','turns.jsonl','code.py'].map(name => fs.readFile(path.join(mock.directory,name),'utf8')));
  const { session } = (await call('POST /api/practice/start', { discipline:'lld',slug:mock.slug,source:{interviewId:mock.id} }, f.ctx)).json();
  const branch = (await call('GET /api/practice/:slug/:id', {}, f.ctx, session)).json();
  assert.equal(session.title, mock.state.title); assert.equal(session.statement, mock.state.scenario.statement);
  assert.equal(session.source.interviewId, mock.id); assert.equal(session.source.completed,true);
  assert.equal(branch.code, mock.state.lastCode); assert.equal(branch.sourceSnapshot.code,mock.state.lastCode);
  assert.match(branch.sourceSnapshot.feedback,/expired codes/); assert.equal(branch.sourceSnapshot.turns[1].code,undefined);
  await call('PUT /api/practice/:slug/:id',{code:'print("practice changes")'},f.ctx,session);
  await call('POST /api/practice/ask',{slug:session.slug,id:session.id,requestId:'branch-question',question:'What should I fix?'},f.ctx);
  assert.match(seen.prompt,/atomic reservation/); assert.doesNotMatch(seen.prompt,/final mock/); assert.match(seen.prompt,/read_context/); assert.match(seen.prompt,/practice changes/);
  const after = await Promise.all(['interview.json','turns.jsonl','code.py'].map(name => fs.readFile(path.join(mock.directory,name),'utf8')));
  assert.deepEqual(after,before,'practice never mutates source evidence');
  assert.equal((await call('GET /api/practice/:slug/:id',{},f.ctx,session)).json().sourceSnapshot.code,mock.state.lastCode);
});
test('unfinished mock branches the latest saved work and says feedback is missing', async t => {
  const f = await fixture(t), mock = await sourceMock(f.root,{done:false});
  const { session } = (await call('POST /api/practice/start',{discipline:'lld',slug:mock.slug,source:{interviewId:mock.id}},f.ctx)).json();
  const branch = (await call('GET /api/practice/:slug/:id',{},f.ctx,session)).json();
  assert.equal(branch.code,'print("latest saved mock")'); assert.equal(branch.sourceSnapshot.feedback,''); assert.equal(session.source.completed,false);
  await fs.writeFile(path.join(mock.directory,'code.py'),'later original changes');
  assert.equal((await call('GET /api/practice/:slug/:id',{},f.ctx,session)).json().code,branch.code,'snapshot remains independent when unfinished mock changes');
});
test('invalid sources and client-forged snapshots never publish a branch', async t => {
  const f = await fixture(t), mock = await sourceMock(f.root);
  const list = () => fs.readdir(problemDir(f.root, mock.slug));
  const before = await list();
  for (const body of [
    {discipline:'lld',slug:mock.slug,source:{interviewId:'../escape'}},
    {discipline:'lld',slug:mock.slug,source:{interviewId:mock.id,discipline:'design'}},
    {discipline:'lld',slug:mock.slug,source:{interviewId:mock.id},code:'forged'},
    {discipline:'design',slug:mock.slug,source:{interviewId:mock.id}},
  ]) await assert.rejects(call('POST /api/practice/start',body,f.ctx),e=>e.status===400);
  await assert.rejects(call('POST /api/practice/start',{discipline:'lld',slug:mock.slug,source:{interviewId:'1760000000000-00000000'}},f.ctx),e=>e.status===404);
  await fs.appendFile(path.join(mock.directory,'turns.jsonl'),'corrupt data\n');
  await assert.rejects(call('POST /api/practice/start',{discipline:'lld',slug:mock.slug,source:{interviewId:mock.id}},f.ctx),SyntaxError);
  assert.deepEqual(await list(),before);
});
test('system-design branches copy only the latest board, including legacy storage', async t => {
  const f = await fixture(t), { DesignStore } = await import('../design/store.mjs');
  const store = new DesignStore({ root:f.root });
  for (const [id, topicSlug] of [['2026-10-31T18-00-00-000Z','design-url-shortener'],['2026-10-31T18-00-01-000Z',undefined]]) {
    await store.create(id,{prompt:'Design a URL-shortening service.',topicSlug,startedAt:Date.now(),debriefed:false});
    await store.writeScene(id,0,[{id:'old-node',type:'rectangle'}]);
    await store.writeScene(id,1,[{id:'latest-node',type:'rectangle'}]);
    const { session } = (await call('POST /api/practice/start',{discipline:'design',source:{interviewId:id}},f.ctx)).json();
    const branch = (await call('GET /api/practice/:slug/:id',{},f.ctx,session)).json();
    assert.equal(session.slug,'design-url-shortener'); assert.deepEqual(branch.elements,[{id:'latest-node',type:'rectangle'}]);
    await call('PUT /api/practice/:slug/:id',{elements:[]},f.ctx,session);
    assert.deepEqual((await store.readScenes(id)).at(-1).elements,[{id:'latest-node',type:'rectangle'}]);
    await assert.rejects(call('POST /api/practice/start',{discipline:'design',slug:'design-messaging',source:{interviewId:id}},f.ctx),e=>e.status===400);
  }
});

test('timer accepts both practice disciplines and rejects client-owned clock fields', async t => {
  const f = await fixture(t);
  for (const discipline of ['lld', 'design']) {
    const session = (await call('POST /api/practice/start', { discipline }, f.ctx)).json().session;
    const get = () => call('GET /api/practice/:slug/:id', {}, f.ctx, session).then(r => r.json());
    await assert.rejects(call('POST /api/practice/:slug/:id/timer', {}, f.ctx, session), e => e.status === 400);
    await assert.rejects(call('POST /api/practice/:slug/:id/timer', { running: 'false' }, f.ctx, session), e => e.status === 400);
    const initial = (await get()).session.timer;
    const forged = (await call('POST /api/practice/:slug/:id/timer', {
      running: false, elapsedMs: 99_999_999, runningSince: 1,
    }, f.ctx, session)).json();
    assert.ok(forged.timer.elapsedMs < 99_999_999, 'client cannot set elapsed time');
    assert.equal(forged.timer.runningSince, null);
    const resumed = (await call('POST /api/practice/:slug/:id/timer', {
      running: true, elapsedMs: 0, runningSince: 0,
    }, f.ctx, session)).json();
    assert.ok(resumed.timer.runningSince >= initial.runningSince, 'resume uses server time');
    assert.equal(resumed.timer.elapsedMs, forged.timer.elapsedMs);
  }
});

test('a practice branch starts its own timer instead of copying mock elapsed time', async t => {
  const f = await fixture(t);
  const mock = await sourceMock(f.root);
  const sourceDir = mock.directory;
  const { session: branch } = (await call('POST /api/practice/start', {
    discipline: 'lld', slug: mock.slug, source: { interviewId: mock.id },
  }, f.ctx)).json();
  const timer = (await call('GET /api/practice/:slug/:id', {}, f.ctx, branch)).json().session.timer;
  assert.equal(timer.elapsedMs, 0);
  assert.ok(timer.runningSince > 0);
  await call('POST /api/practice/:slug/:id/timer', { running: false }, f.ctx, branch);
  const sourceInterview = JSON.parse(await fs.readFile(path.join(sourceDir, 'interview.json')));
  assert.equal(sourceInterview.startedAt, mock.state.startedAt);
  assert.equal((await call('GET /api/practice/:slug/:id', {}, f.ctx, branch)).json().session.timer.elapsedMs >= 0, true);
});
test('a fresh practice starts with its initial work atomically', async t => {
  const f = await fixture(t);
  const { session } = (await call('POST /api/practice/start',{discipline:'lld',slug:'lld-locker',code:'initial = True'},f.ctx)).json();
  assert.equal((await call('GET /api/practice/:slug/:id',{},f.ctx,session)).json().code,'initial = True');
});

test('an unpublished branch is invisible to both history and learner context', async t => {
  const f = await fixture(t), pending = f.problem('practice','.creating-interrupted');
  await fs.mkdir(pending);
  await fs.writeFile(path.join(pending,'session.json'),JSON.stringify({...f.session,id:'interrupted'}));
  await fs.writeFile(path.join(pending,'exchanges.json'),JSON.stringify([{question:'Never published',status:'pending'}]));
  assert.equal((await call('GET /api/practice',{},f.ctx)).json().sessions.length,1);
  const profile = await readLearnerProfile(f.root);
  assert.equal(profile.observations.some(o=>o.question==='Never published'),false);
});

test('practice agent memory is supplied to later turns and tools target the exact session', async t => {
  let turn = 0, secondPrompt;
  const f = await fixture(t, opts => {
    void (async () => {
      turn++;
      assert.ok(opts.toolSpecs.some(s => s.name === 'edit_code'));
      assert.ok(opts.toolSpecs.some(s => s.name === 'run_code'));
      if (turn === 1) {
        const result = await opts.toolSession.call('update_memory', { scope: 'lld', find: '', replace: 'Observed fixture: review cancellation invariants next time.', why: 'Recorded practice discussion.' });
        assert.equal(result.ok, true);
      } else secondPrompt = opts.prompt;
      opts.onToken('Recorded the lesson.'); opts.onDone();
    })().catch(error => opts.onError(error.message));
  });
  await f.ask();
  const first = await f.record(), action = first.exchanges[0].actions[0];
  assert.equal(action.target, `practice:${f.session.slug}:${f.session.id}`);
  assert.equal(action.status, 'done');
  await f.ask({ requestId: 'question-two', question: 'What should I review next?' });
  assert.match(secondPrompt, /Observed fixture: review cancellation invariants/);
  assert.equal((await f.record()).exchanges.length, 2);
});


test('voice coaching gets spoken delivery guidance and each question records its input mode', async t => {
  let seen;
  const f = await fixture(t, options => {seen=options;options.onToken('Check ownership.');options.onDone();});
  await f.ask({mode:'voice'});
  assert.match(JSON.stringify(seen.conversation.context),/VOICE DELIVERY/);
  assert.equal((await f.record()).exchanges[0].mode,'voice');
  await f.ask({requestId:'typed-question',mode:'typed'});
  assert.doesNotMatch(JSON.stringify(seen.conversation.context),/VOICE DELIVERY/);
  assert.equal((await f.record()).exchanges[1].mode,'typed');
});

test('native conversation descriptor preserves full history and typed/voice identity', async t => {
  const calls = [];
  const f = await fixture(t, options => {
    calls.push(options); options.onToken('saved answer '.repeat(1600)); return options.onDone();
  });
  await f.ask({question:'EARLY-REQUIREMENT ' + 'detail '.repeat(1400),mode:'voice'});
  await f.ask({requestId:'next',question:'Continue.',mode:'typed'});
  const [first,next] = calls;
  assert.equal(first.conversation.key, `practice:${f.session.slug}:${f.session.id}`);
  assert.equal(next.conversation.key,first.conversation.key);
  assert.equal(next.systemPrompt,first.systemPrompt);
  assert.equal(next.conversation.requestId,'next');
  assert.match(next.conversation.bootstrapPrompt,/EARLY-REQUIREMENT/);
  assert.ok(next.conversation.bootstrapPrompt.includes('saved answer '.repeat(1600)));
  assert.equal(next.conversation.message,'Continue.');
  const initial = await beginConversation({root:f.root,choice:{provider:'claude',model:'opus'},systemPrompt:first.systemPrompt,conversation:first.conversation});
  await initial.nativeId('practice-native'); await initial.complete();
  const continued = await beginConversation({root:f.root,choice:{provider:'claude',model:'opus'},systemPrompt:next.systemPrompt,conversation:next.conversation});
  assert.doesNotMatch(continued.prompt,/saved answer/);
  await continued.complete();
});

test('stream checkpoints survive refresh, restart recovery, and final failure', async t => {
  let provider;
  const f = await fixture(t, options => { provider=options; options.onToken('Durable partial prefix'); });
  const running=f.ask();
  // Wait for the coalesced checkpoint, not a real provider or workspace.
  await new Promise(resolve=>setTimeout(resolve,500));
  assert.ok(provider);
  const directory=f.problem('practice',f.session.id);
  const disk=JSON.parse(await fs.readFile(path.join(directory,'exchanges.json'),'utf8'));
  assert.equal(disk[0].answer,'Durable partial prefix');
  assert.equal(disk[0].status,'pending');
  assert.equal((await f.record()).exchanges[0].answer,'Durable partial prefix');
  const restarted = await import('./routes.mjs?checkpoint-restart');
  const restartedResponse = response();
  await restarted.routes['GET /api/practice/:slug/:id']({}, restartedResponse, {...f.ctx,params:f.session});
  assert.equal(restartedResponse.json().exchanges[0].answer,disk[0].answer);
  assert.equal(restartedResponse.json().exchanges[0].status,'failed');
  assert.match(restartedResponse.json().exchanges[0].error,/interrupted/);
  await provider.onError('Interrupted fake provider');
  await running;
  const final=JSON.parse(await fs.readFile(path.join(directory,'exchanges.json'),'utf8'));
  assert.equal(final[0].answer,disk[0].answer);
  assert.equal(final[0].status,'failed');
  assert.equal(final[0].liveRevision,1);
});
