import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
    await interviewRoutes[route](req, res, { interview, params });
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
  const suppressed = await call('POST /api/interview/event', { ...body, event: { type: 'verdict', verdict: 'Accepted', secondsSinceSpeech: 0, secondsSinceTyping: 0 } });
  assert.equal(JSON.parse(suppressed.output).interjected, false);
  const interjection = await call('POST /api/interview/event', { ...body, event: { type: 'idle', secondsSinceSpeech: 25, secondsSinceTyping: 0 } });
  assert.match(interjection.output, /It passed/);
  const cooldown = await call('POST /api/interview/event', { ...body, event: { type: 'idle', secondsSinceSpeech: 200, secondsSinceTyping: 200 } });
  assert.equal(JSON.parse(cooldown.output).interjected, false);
  const done = await call('POST /api/interview/done', { ...body, requestId: 'end-1' });
  assert.match(done.output, /Testing & verification/);
  state = await interview.store.readState(body.slug, id); assert.equal(state.debriefed, true);
  assert.equal(state.hireSignal, 'Lean hire');
  const turns = await interview.store.readTurns(body.slug, id);
  assert.equal(turns.filter(t => t.kind === 'candidate').length, 1);
  assert.ok(turns.some(t => t.kind === 'debrief'));
  assert.equal(interview.live.size, 0);
  const doc = await fs.readFile(path.join(root, 'problems', body.slug, 'interviews', id, 'interview.md'), 'utf8');
  assert.equal(doc, renderInterview({ state, turns }));
  const get = await call('GET /api/interview/:slug/:id', {}, { slug: body.slug, id });
  assert.equal(JSON.parse(get.output).debriefed, true);
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
  interview.run = options => { fail = options.onError; return { kill() {} }; };
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
  assert.ok(calls.at(-1).resumeSessionId); assert.equal(calls.at(-1).tools, '');
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'codex', model: 'gpt-6-astra' }));
  await call('POST /api/interview/turn', { ...body, said: 'Now use the saved approach.', requestId: 'provider-2', code: 'mapping = {}' });
  assert.match(calls.at(-1).prompt, /Keep every duplicate index/); assert.match(calls.at(-1).prompt, /Full buffer/);
  assert.equal(calls.at(-1).resumeSessionId, null);
  await call('POST /api/interview/turn', { ...body, said: 'And now test it.', requestId: 'provider-3', code: 'mapping = {}' });
  assert.doesNotMatch(calls.at(-1).prompt, /Complete record/);
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  await call('POST /api/interview/turn', { ...body, said: 'Explain the cost.', requestId: 'provider-4' });
  assert.equal(calls.at(-1).resumeSessionId, null); assert.match(calls.at(-1).prompt, /Codex fixture reply/);
});
