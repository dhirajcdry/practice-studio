import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { problemDir } from '../storage-layout.mjs';
import { Readable } from 'node:stream';
import { InterviewService, interviewRoutes } from './routes.mjs';
import { newState } from './state.mjs';
import { renderInterview } from './render.mjs';
import { permissionArgs } from '../coach/claude-cli.mjs';
const binary = new URL('./test/fake-interviewer.mjs', import.meta.url).pathname;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coding-interview-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'two-sum.json'), JSON.stringify({ question: { title: 'Two Sum', content: '<p>Find two numbers.</p>' } }));
  const interview = new InterviewService({ root, binary });
  async function call(route, body = {}, params = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = route.split(' ')[1];
    let output = '', status;
    const res = { writeHead(code) { status = code; }, write(chunk) { output += chunk; }, end(chunk = '') { output += chunk; }, flushHeaders() {} };
    const method = route.split(' ')[0], url = route.split(' ')[1];
    await interviewRoutes[`${method} ${new URL(url, 'http://localhost').pathname}`](req, res, { interview, params });
    return { status, output, events: [...output.matchAll(/event: (.+)\ndata: (.+)\n/g)].map(m => ({ name: m[1], data: JSON.parse(m[2]) })) };
  }
  return { root, interview, call };
}
test('fake CLI start → turn → safe verdict → cooldown → debrief, raw record and reload', async t => {
  const { root, interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45, code: 'pass' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  assert.match(opening.output, /Find two numbers/); assert.doesNotMatch(opening.output, /\[\[phase/);
  const body = { slug: 'two-sum', interviewId: id };
  const turn = await call('POST /api/interview/turn', { ...body, said: 'I will use a map.', requestId: 'answer-1', code: 'x = {}' });
  assert.ok(turn.events.some(e => e.name === 'accepted')); assert.match(turn.output, /What will/);
  let state = await interview.store.readState(body.slug, id); assert.equal(state.phase, 'code');
  const duplicate = await call('POST /api/interview/turn', { ...body, said: 'I will use a map.', requestId: 'answer-1' });
  assert.equal(JSON.parse(duplicate.output).duplicate, true);
  await assert.rejects(call('POST /api/interview/done', { ...body, requestId: 'answer-1' }), /another interview action/);
  const suppressed = await call('POST /api/interview/event', { ...body, event: { type: 'verdict', verdict: 'Accepted', secondsSinceSpeech: 0, secondsSinceTyping: 0 } });
  assert.equal(JSON.parse(suppressed.output).interjected, false);
  const interjection = await call('POST /api/interview/event', { ...body, event: { type: 'idle', secondsSinceSpeech: 25, secondsSinceTyping: 0 } });
  assert.match(interjection.output, /It passed/);
  const cooldown = await call('POST /api/interview/event', { ...body, event: { type: 'idle', secondsSinceSpeech: 200, secondsSinceTyping: 200 } });
  assert.equal(JSON.parse(cooldown.output).interjected, false);
  const done = await call('POST /api/interview/done', { ...body, requestId: 'end-1' });
  assert.match(done.output, /Lean hi/);
  state = await interview.store.readState(body.slug, id); assert.equal(state.debriefed, true);
  assert.equal(state.hireSignal, 'Lean hire');
  const turns = await interview.store.readTurns(body.slug, id);
  assert.equal(turns.filter(t => t.kind === 'candidate').length, 1);
  assert.ok(turns.some(t => t.kind === 'debrief'));
  assert.equal(interview.live.size, 0);
  const doc = await fs.readFile(path.join(problemDir(root, body.slug), 'interviews', id, 'interview.md'), 'utf8');
  assert.equal(doc, renderInterview({ state, turns }));
  const get = await call('GET /api/interview/:slug/:id', {}, { slug: body.slug, id });
  const detail = JSON.parse(get.output);
  assert.equal(detail.debriefed, true);
  assert.equal(detail.report.judgement.signal, 'Lean hire');
  assert.deepEqual(detail.report.judgement.dimensions.map(d => d.rating), ['Strong', 'Solid', 'Solid', null]);
  assert.equal(detail.report.judgement.dimensions[0].evidence[0].quote, 'I will use a map.', 'a real quote stays a quote');
  assert.equal(detail.report.facts.candidateTurns, 1);
  assert.match(doc, /### Problem solving — Strong/, 'interview.md renders the report, not raw JSON');
});
test('finishing without a candidate response skips debrief generation and is replayable', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45 });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  let runs = 0;
  const original = interview.run;
  interview.run = options => { runs++; return original(options); };
  const done = await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'silent-end', said: '   ' });
  const state = await interview.store.readState('two-sum', id);
  assert.equal(runs, 0, 'silent completion never launches the provider');
  assert.equal(state.debriefed, true);
  assert.equal(state.completionReason, 'no-response');
  assert.equal(state.hireSignal, undefined);
  assert.match(done.output, /"completionReason":"no-response"/);
  assert.equal((await interview.store.readTurns('two-sum', id)).filter(t => t.kind === 'debrief').length, 0);
  const replay = await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'silent-end' });
  assert.equal(JSON.parse(replay.output).duplicate, true);
  interview.run = original;
});

test('a final answer submitted with Finish still receives a report', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'voice' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'final-answer', said: 'I will use a map.' });
  const state = await interview.store.readState('two-sum', id);
  assert.equal(state.completionReason, undefined);
  assert.equal(state.hireSignal, 'Lean hire');
  const turns = await interview.store.readTurns('two-sum', id);
  assert.ok(turns.some(turn => turn.kind === 'candidate' && turn.said === 'I will use a map.'));
  assert.ok(turns.some(turn => turn.kind === 'debrief'));
});

test('store rejects traversal, preserves append bytes, surfaces corrupt evidence', async t => {
  const { interview } = await fixture(t), store = interview.store, id = '1760000000000-abcdef12';
  assert.throws(() => store.dir('../escape', id)); assert.throws(() => store.dir('two-sum', '../escape'));
  await store.create('two-sum', id, newState({ slug: 'two-sum' }));
  await store.append('two-sum', id, { said: 'first' });
  const file = path.join(store.dir('two-sum', id), 'turns.jsonl');
  const before = await fs.readFile(file, 'utf8'); await store.append('two-sum', id, { said: 'second' });
  assert.ok((await fs.readFile(file, 'utf8')).startsWith(before));
  await fs.appendFile(file, 'broken\n'); await assert.rejects(store.readTurns('two-sum', id));
});
test('records are denied to both Claude file writers', () => {
  const { deny } = permissionArgs('/scratch');
  for (const tool of ['Write', 'Edit']) assert.ok(deny.includes(`${tool}(//scratch/problems/*/interviews/**)`));
});

test('concurrency rejects second mutation, input survives error and retry is not duplicated', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id, said: 'Keep this answer.', requestId: 'retry-id' };
  const run = interview.run;
  let fail;
  // A controlled fake CLI boundary makes the race deterministic, without a socket or
  // timing assumption. The opening and recovery still execute a real fake subprocess.
  interview.run = options => { fail = options.onError; options.onToken('A reply before the provider failed.'); return { kill() {} }; };
  const first = call('POST /api/interview/turn', body);
  while (!fail) await new Promise(resolve => setTimeout(resolve, 1));
  await assert.rejects(call('POST /api/interview/turn', body), /still finishing/);
  const before = await interview.store.readTurns(body.slug, id);
  assert.ok(before.some(row => row.said === body.said));
  fail('Fake provider failed.'); await first;
  interview.run = run;
  await call('POST /api/interview/turn', body);
  const after = await interview.store.readTurns(body.slug, id);
  assert.equal(after.filter(row => row.said === body.said).length, 1);
  assert.ok(after.some(row => row.kind === 'error'));
  assert.ok(after.some(row => row.kind === 'partial' && row.asked === 'A reply before the provider failed.'));
});
test('stop settles an SSE response even when kill has no callback; explicit pause freezes clock', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id };
  let launched = false, killed = false;
  interview.run = options => { launched = true; queueMicrotask(() => options.onToken('A partial question')); return { kill() { killed = true; } }; };
  const inFlight = call('POST /api/interview/turn', { ...body, said: 'Hello', requestId: 'stop-me' });
  while (!launched) await new Promise(resolve => setTimeout(resolve, 1));
  await call('POST /api/interview/stop', body);
  const stopped = await inFlight;
  assert.ok(killed); assert.match(stopped.output, /"stopped":true/);
  const interrupted = await interview.store.readTurns(body.slug, id);
  assert.ok(interrupted.some(row => row.kind === 'partial' && row.asked === 'A partial question'));
  const paused = JSON.parse((await call('POST /api/interview/pause', body)).output).state;
  assert.ok(paused.pausedAt);
  await assert.rejects(call('POST /api/interview/turn', body), /Resume/);
  const resumed = JSON.parse((await call('POST /api/interview/resume', body)).output).state;
  assert.equal(resumed.startedAt, paused.startedAt); assert.equal(resumed.pausedAt, null);
  assert.ok(resumed.pausedMs >= 0);
});

test('provider switching rehydrates full evidence and never cross-resumes native sessions', async t => {
  const { root, interview, call } = await fixture(t);
  const previousBinary = process.env.STUDIO_CODEX_BINARY;
  process.env.STUDIO_CODEX_BINARY = new URL('../coach/test/bin/fake-codex.mjs', import.meta.url).pathname;
  t.after(() => { for (const c of interview.conversations.values()) c.close?.(); if (previousBinary === undefined) delete process.env.STUDIO_CODEX_BINARY; else process.env.STUDIO_CODEX_BINARY = previousBinary; });
  const calls = [], real = interview.run;
  interview.run = options => { calls.push(options); return real(options); };
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', code: 'pass' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id };
  await call('POST /api/interview/turn', { ...body, said: 'Keep every duplicate index.', requestId: 'provider-1', code: 'mapping = {}' });
  assert.equal(calls.at(-1).resumeSessionId, null); assert.equal(calls.at(-1).tools, '');
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'codex', model: 'gpt-6-astra' }));
  await call('POST /api/interview/turn', { ...body, said: 'Now use the saved approach.', requestId: 'provider-2', code: 'mapping = {}' });
  assert.match(calls.at(-1).prompt, /Keep every duplicate index/); assert.match(calls.at(-1).prompt, /Current workspace/);
  assert.equal(calls.at(-1).resumeSessionId, null);
  await call('POST /api/interview/turn', { ...body, said: 'And now test it.', requestId: 'provider-3', code: 'mapping = {}' });
  assert.doesNotMatch(calls.at(-1).prompt, /Complete record/);
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  await call('POST /api/interview/turn', { ...body, said: 'Explain the cost.', requestId: 'provider-4' });
  assert.equal(calls.at(-1).resumeSessionId, null); assert.match(calls.at(-1).prompt, /Codex fixture reply/);
});

test('noise turns are skipped before the provider and remain idempotent', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  let calls = 0;
  interview.run = options => { calls++; options.onDone('noise-session'); return { kill() {} }; };
  const body = { slug: 'two-sum', interviewId: id, said: '(keyboard clicking) Thanks.', requestId: 'noise-1' };
  const firstOutput = (await call('POST /api/interview/turn', body)).output;
  assert.match(firstOutput, /"skipped"\s*:\s*true/); assert.equal(calls, 0);
  const secondOutput = (await call('POST /api/interview/turn', body)).output;
  assert.match(secondOutput, /"duplicate"\s*:\s*true/); assert.match(secondOutput, /"skipped"\s*:\s*true/); assert.equal(calls, 0);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.filter(row => row.kind === 'candidate').length, 0);
  assert.deepEqual(turns.find(row => row.kind === 'skipped_noise').raw, '(keyboard clicking) Thanks.');
});

test('candidate transcript is cleaned before recording and prompting', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  let prompt = '';
  interview.run = options => { prompt = options.prompt; options.onDone('clean-session'); return { kill() {} }; };
  await call('POST /api/interview/turn', { slug: 'two-sum', interviewId: id, said: 'I will [background noise] use a map.', requestId: 'clean-1' });
  assert.match(prompt, /I will use a map/); assert.doesNotMatch(prompt, /background noise/);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.find(row => row.kind === 'candidate').said, 'I will use a map.');
});

test('filler provider replies are suppressed while substantive split replies are emitted', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id };
  const state = await interview.store.readState('two-sum', id);
  state.pendingEvents = [{ type: 'verdict', verdict: 'Accepted', elapsedMs: 12 }];
  const phase = state.phase;
  await interview.store.writeState('two-sum', id, state);
  interview.run = options => {
    options.onToken('Sure, take'); options.onToken(' your time. [[phase: followup]] [[hint: nudge]]'); options.onDone('filler-session'); return { kill() {} };
  };
  const filler = await call('POST /api/interview/turn', { ...body, said: 'I have an approach.', requestId: 'filler-1' });
  assert.doesNotMatch(filler.output, /Sure/);
  let after = await interview.store.readState('two-sum', id);
  assert.equal(after.phase, phase); assert.deepEqual(after.hints, state.hints); assert.equal(after.turns, state.turns); assert.deepEqual(after.pendingEvents, state.pendingEvents);
  assert.ok((await interview.store.readTurns('two-sum', id)).some(row => row.kind === 'suppressed_filler'));
  interview.run = options => {
    options.onToken('Sure'); options.onToken(' — what is the complexity?'); options.onDone('substantive-session'); return { kill() {} };
  };
  const substantive = await call('POST /api/interview/turn', { ...body, said: 'The map gives constant lookup.', requestId: 'substantive-1' });
  assert.match(substantive.output, /what is the complexity/);
});

test('failed opening retries the saved opening, and duplicate retries do not generate again', async t => {
  const { interview, call } = await fixture(t);
  const run = interview.run;
  interview.run = options => { options.onError('Opening unavailable'); return { kill() {} }; };
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', requestId: 'opening-retry' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  assert.match(opening.output, /Opening unavailable/);
  interview.run = run;
  const body = { slug: 'two-sum', interviewId: id, requestId: 'opening-retry' };
  const retry = await call('POST /api/interview/retry', body);
  assert.match(retry.output, /Find two numbers/);
  assert.ok(JSON.parse((await call('POST /api/interview/retry', body)).output).duplicate);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.filter(row => row.kind === 'opening').length, 1);
  assert.equal(turns.filter(row => row.kind === 'candidate').length, 0);
});

test('failed answers retain partial evidence without advancing phase and retry their original answer', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const before = await interview.store.readState('two-sum', id);
  interview.run = options => {
    options.onToken('A useful partial question. [[phase: followup]] [[hint: explicit]]');
    options.onError('Provider disconnected'); return { kill() {} };
  };
  const body = { slug: 'two-sum', interviewId: id, requestId: 'answer-retry' };
  const failure = await call('POST /api/interview/turn', { ...body, said: 'Use a map of indices.' });
  assert.ok(failure.events.some(e => e.name === 'token' && e.data.text.includes('partial question')));
  const after = await interview.store.readState('two-sum', id);
  assert.equal(after.phase, before.phase); assert.deepEqual(after.hints, before.hints); assert.equal(after.turns, before.turns);
  let prompt;
  interview.run = options => { prompt = options.prompt; options.onToken('How do duplicates work?'); options.onDone('retry-session'); return { kill() {} }; };
  await call('POST /api/interview/retry', { ...body, said: 'This must not replace the original.' });
  assert.match(prompt, /Use a map of indices/); assert.doesNotMatch(prompt, /This must not replace/);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.filter(row => row.kind === 'candidate').length, 1);
});

test('empty and stopped debriefs remain unfinished, and can be retried without duplicating the final answer', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id, requestId: 'debrief-retry' };
  const run = interview.run;
  interview.run = options => { options.onDone('empty-session'); return { kill() {} }; };
  const empty = await call('POST /api/interview/done', { ...body, said: 'My final explanation.' });
  assert.match(empty.output, /empty debrief/);
  assert.equal((await interview.store.readState('two-sum', id)).debriefed, false);
  await assert.rejects(call('POST /api/interview/turn', { ...body, requestId: 'late-answer', said: 'Too late' }), /interview has ended/);
  let launched = false;
  interview.run = options => { launched = true; options.onToken('## Coding\nSome evidence.'); return { kill() {} }; };
  const pending = call('POST /api/interview/retry', body);
  while (!launched) await new Promise(resolve => setTimeout(resolve, 1));
  await call('POST /api/interview/stop', body);
  const stopped = await pending;
  assert.equal(stopped.events.find(e => e.name === 'done').data.state.debriefed, false);
  const partialState = await interview.store.readState('two-sum', id);
  const partialTurns = await interview.store.readTurns('two-sum', id);
  assert.match(renderInterview({ state: partialState, turns: partialTurns }), /Debrief \(interrupted\)/);
  interview.run = run;
  await call('POST /api/interview/retry', body);
  assert.equal((await interview.store.readState('two-sum', id)).debriefed, true);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.filter(row => row.kind === 'candidate').length, 1);
  assert.equal(turns.filter(row => row.kind === 'debrief').length, 1);
});

test('failed interjections retry without recording the triggering result twice', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const run = interview.run;
  const body = { slug: 'two-sum', interviewId: id, requestId: 'interjection-retry', event: {
    type: 'verdict', verdict: 'Accepted', requestId: 'verdict-once', secondsSinceSpeech: 40, secondsSinceTyping: 40,
  } };
  interview.run = options => { options.onError('Interjection unavailable'); return { kill() {} }; };
  await call('POST /api/interview/event', body);
  interview.run = run;
  const retried = await call('POST /api/interview/event', body);
  assert.match(retried.output, /It passed/);
  const turns = await interview.store.readTurns('two-sum', id);
  assert.equal(turns.filter(row => row.event?.requestId === 'verdict-once').length, 1);
});

test('fresh start creates a second interview and pauses the first; retrying its request id is idempotent', async t => {
  const { interview, call } = await fixture(t);
  const first = await call('POST /api/interview/start', { slug: 'two-sum', requestId: 'first' });
  const firstId = first.events.find(e => e.name === 'interview').data.id;
  const second = await call('POST /api/interview/start', { slug: 'two-sum', fresh: true, requestId: 'fresh-1' });
  const secondId = second.events.find(e => e.name === 'interview').data.id;
  assert.notEqual(secondId, firstId);
  assert.ok((await interview.store.readState('two-sum', firstId)).pausedAt);
  const retry = await call('POST /api/interview/start', { slug: 'two-sum', fresh: true, requestId: 'fresh-1' });
  assert.equal(JSON.parse(retry.output).id, secondId);
  assert.equal((await interview.store.list('two-sum')).length, 2);
});

test('resume pauses the other interview and fresh start pauses across slugs', async t => {
  const { root, interview, call } = await fixture(t);
  await fs.mkdir(path.join(root, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'three-sum.json'), JSON.stringify({ question: { title: 'Three Sum', content: '<p>Find three numbers.</p>' } }));
  const first = await call('POST /api/interview/start', { slug: 'two-sum' });
  const firstId = first.events.find(e => e.name === 'interview').data.id;
  const second = await call('POST /api/interview/start', { slug: 'three-sum', fresh: true });
  const secondId = second.events.find(e => e.name === 'interview').data.id;
  const resumed = await call('POST /api/interview/resume', { slug: 'two-sum', interviewId: firstId });
  assert.equal(JSON.parse(resumed.output).state.pausedAt, null);
  assert.ok((await interview.store.readState('three-sum', secondId)).pausedAt);
});

test('invalid fresh start and busy target leave existing interviews unchanged', async t => {
  const { interview, call } = await fixture(t);
  const first = await call('POST /api/interview/start', { slug: 'two-sum' });
  const firstId = first.events.find(e => e.name === 'interview').data.id;
  await assert.rejects(call('POST /api/interview/start', { slug: 'missing', fresh: true }), /cached statement/);
  assert.equal((await interview.store.readState('two-sum', firstId)).pausedAt, null);
  const live = { completion: Promise.resolve() };
  interview.live.set(`two-sum/${firstId}`, live);
  await assert.rejects(call('POST /api/interview/start', { slug: 'two-sum', fresh: true }), /still finishing/);
  interview.live.delete(`two-sum/${firstId}`);
  assert.equal((await interview.store.readState('two-sum', firstId)).pausedAt, null);
  assert.equal((await interview.store.list('two-sum')).length, 1);
});

test('list status distinguishes in-progress generation from stranded accepted request', async t => {
  const { interview, call } = await fixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const state = await interview.store.readState('two-sum', id);
  state.requests.pending = { status: 'accepted', kind: 'turn', said: 'answer' };
  await interview.store.writeState('two-sum', id, state);
  interview.live.set(`two-sum/${id}`, { completion: Promise.resolve() });
  let listed = JSON.parse((await call('GET /api/interview?slug=two-sum')).output).interviews[0];
  assert.equal(listed.status, 'in_progress'); assert.equal(listed.needsAttention, false);
  interview.live.delete(`two-sum/${id}`);
  listed = JSON.parse((await call('GET /api/interview?slug=two-sum')).output).interviews[0];
  assert.equal(listed.status, 'needs_attention'); assert.equal(listed.needsAttention, true);
});

test('follow-up questions about a finished interview stream, persist beside the record, and never touch it', async t => {
  const { root, interview, call } = await fixture(t);
  const promptLog = path.join(root, 'prompts.jsonl');
  process.env.FAKE_INTERVIEW_PROMPT = promptLog;
  t.after(() => { delete process.env.FAKE_INTERVIEW_PROMPT; });
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45, code: 'pass' });
  const id = opening.events.find(e => e.name === 'interview').data.id;
  const body = { slug: 'two-sum', interviewId: id };
  await assert.rejects(call('POST /api/interview/ask', { ...body, question: 'What should I test?', requestId: 'early-1' }), /Finish the interview/);
  await call('POST /api/interview/turn', { ...body, said: 'I will use a map.', requestId: 'answer-1', code: 'seen = {}' });
  await call('POST /api/interview/done', { ...body, requestId: 'end-1' });
  const record = await fs.readFile(path.join(problemDir(root, 'two-sum'), 'interviews', id, 'turns.jsonl'), 'utf8');

  const asked = await call('POST /api/interview/ask', { ...body, question: 'What test cases could I have tried?', requestId: 'q-1' });
  assert.ok(asked.events.some(e => e.name === 'accepted'));
  const done = asked.events.find(e => e.name === 'done');
  assert.match(done.data.answer, /\[3,3\], 6/);
  const prompt = (await fs.readFile(promptLog, 'utf8')).trim().split('\n').map(JSON.parse).at(-1).prompt;
  assert.match((await fs.readFile(promptLog,'utf8')).trim().split('\n').map(JSON.parse).at(-1).args.join(' '), /going over it with the candidate/);
  assert.match(prompt, /What test cases could I have tried\?/);
  assert.match(prompt, /I will use a map\./, 'the record is in the prompt');
  assert.match(prompt, /"signal":"Lean hire"/, 'the report is in the prompt');
  assert.doesNotMatch(prompt, /Earlier questions/);

  const duplicate = await call('POST /api/interview/ask', { ...body, question: 'What test cases could I have tried?', requestId: 'q-1' });
  assert.equal(JSON.parse(duplicate.output).duplicate, true);
  await call('POST /api/interview/ask', { ...body, question: 'And for negatives?', requestId: 'q-2' });
  const second = (await fs.readFile(promptLog, 'utf8')).trim().split('\n').map(JSON.parse).at(-1).prompt;
  assert.doesNotMatch(second, /Earlier questions and your answers/);
  assert.match(second, /And for negatives/);
  assert.equal((await fs.readFile(promptLog, 'utf8')).trim().split('\n').filter(line => line.includes('going over it')).length, 2, 'a duplicate never reaches the provider');

  const detail = JSON.parse((await call('GET /api/interview/:slug/:id', {}, { slug: 'two-sum', id })).output);
  assert.deepEqual(detail.followups.map(f => [f.requestId, f.question, Boolean(f.answer), f.failed]),
    [['q-1', 'What test cases could I have tried?', true, false], ['q-2', 'And for negatives?', true, false]]);
  assert.equal(await fs.readFile(path.join(problemDir(root, 'two-sum'), 'interviews', id, 'turns.jsonl'), 'utf8'), record, 'turns.jsonl is unchanged');
  assert.equal(interview.live.size, 0);
  await assert.rejects(call('POST /api/interview/ask', { ...body, question: '   ', requestId: 'q-3' }), /at most 4000/);
});

test('an older interview with a prose debrief can still be asked about, with that debrief in the prompt', async t => {
  const { root, call } = await fixture(t);
  const promptLog = path.join(root, 'prompts.jsonl');
  process.env.FAKE_INTERVIEW_PROMPT = promptLog; process.env.FAKE_INTERVIEW_LEGACY_DEBRIEF = '1';
  t.after(() => { delete process.env.FAKE_INTERVIEW_PROMPT; delete process.env.FAKE_INTERVIEW_LEGACY_DEBRIEF; });
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45, code: 'pass' });
  const body = { slug: 'two-sum', interviewId: opening.events.find(e => e.name === 'interview').data.id };
  await call('POST /api/interview/turn', { ...body, said: 'I will use a map.', requestId: 'answer-1' });
  await call('POST /api/interview/done', { ...body, requestId: 'end-1' });
  const asked = await call('POST /api/interview/ask', { ...body, question: 'What should I have tested?', requestId: 'q-1' });
  assert.ok(asked.events.some(e => e.name === 'done'));
  const prompt = (await fs.readFile(promptLog, 'utf8')).trim().split('\n').map(JSON.parse).at(-1).prompt;
  assert.match(prompt, /Your written debrief/);
  assert.match(prompt, /The approach was clear\./);
});

test('mock native descriptor keeps full speech on bootstrap and no transcript in updates', async t => {
  const {interview,call}=await fixture(t);
  const calls=[];
  interview.run=options=>{
    calls.push(options);
    queueMicrotask(async()=>{options.onToken('What is the complexity?');await options.onDone('fake-native');});
    return {kill(){}};
  };
  const opening=await call('POST /api/interview/start',{slug:'two-sum',mode:'typed'});
  const id=opening.events.find(e=>e.name==='interview').data.id;
  await interview.store.append('two-sum',id,{kind:'candidate',said:'old exact speech '.repeat(2000)});
  await call('POST /api/interview/turn',{slug:'two-sum',interviewId:id,requestId:'next',said:'Use a map.',mode:'voice'});
  const next=calls.at(-1);
  assert.equal(next.conversation.key,`interview:two-sum:${id}`);
  assert.equal(next.systemPrompt,calls[0].systemPrompt);
  assert.ok(next.conversation.bootstrapPrompt.includes('old exact speech '.repeat(2000)));
  assert.ok(!next.conversation.message.includes('old exact speech'));
  assert.ok(!JSON.stringify(next.conversation.context).includes('old exact speech '.repeat(100)));
});
