import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { InterviewService, interviewRoutes } from '../interview/routes.mjs';
import { routes as lldRoutes } from '../lld/routes.mjs';
import { newState, elapsed } from '../interview/state.mjs';
import { prepareProblem } from './selection.mjs';
import { problemDir } from '../storage-layout.mjs';

const proposed = { title: 'Museum reservations', statement: 'Design a museum reservation system.', family: 'museum-reservations', facts: 'PRIVATE_FACT_CAPACITY: slots have fixed capacity and can be cancelled.', curveball: 'PRIVATE_CURVEBALL: concurrent visitors book the last ticket.', rationale: 'PRIVATE_RATIONALE: exercise state transitions.' };
const historicalQuote = 'I forgot to release the reservation';
function report(quote, summary) {
  return JSON.stringify({ summary, dimensions: [{ name: 'Correctness', rating: 'Weak', evidence: [{ quote }] }], practice: [{ title: 'Transactional reservations', why: 'Cancellation must release capacity.' }] });
}
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-learning-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'sonnet' }));
  const calls = [];
  const run = options => {
    calls.push(options);
    const answer = options.prompt.includes('going over it with the candidate afterwards') ? 'Review cancellation against the recorded invariant.'
      : options.prompt.includes("Write the candidate's report") ? report('I will track remaining capacity', 'CURRENT_SESSION_ASSESSMENT')
        : 'What happens to capacity when a reservation is cancelled? [[phase: code]]';
    queueMicrotask(() => { options.onToken(answer); options.onDone('fake-session'); });
    return { kill() {} };
  };
  const interview = new InterviewService({ root, run });
  async function call(table, method, url, body = {}) {
    let selected, params;
    for (const [key, handler] of Object.entries(table)) {
      const [verb, pattern] = key.split(' '), actual = url.split('/'), expected = pattern.split('/');
      if (verb !== method || actual.length !== expected.length) continue;
      const found = {};
      if (expected.every((part, i) => part.startsWith(':') ? (found[part.slice(1)] = actual[i], true) : part === actual[i])) { selected = handler; params = found; break; }
    }
    assert.ok(selected, `${method} ${url}`);
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = url; req.method = method;
    let output = '', status;
    const res = { writeHead(code) { status = code; }, write(chunk) { output += chunk; }, end(chunk = '') { output += chunk; }, flushHeaders() {} };
    await selected(req, res, { interview, homeRoot: root, params });
    return { status, output, events: [...output.matchAll(/event: (.+)\ndata: (.+)\n/g)].map(m => ({ name: m[1], data: JSON.parse(m[2]) })) };
  }
  const prepared = await prepareProblem(root, { discipline: 'lld', targetLevel: 'L5', minutes: 60, requestId: 'integration-preparation' }, {
    run: options => { queueMicrotask(() => { options.onToken(JSON.stringify(proposed)); options.onDone(); }); return { kill() {} }; },
  });
  async function start() {
    const response = await call(interviewRoutes, 'POST', '/api/interview/start', { slug: prepared.slug, discipline: 'lld', targetLevel: 'L5', minutes: 60, mode: 'typed', requestId: 'integration-opening', code: 'FORGED_INITIAL_CODE', statement: 'FORGED_STATEMENT' });
    const id = response.events.find(e => e.name === 'interview')?.data.id ?? JSON.parse(response.output).id;
    return { response, id, slug: prepared.slug, body: { slug: prepared.slug, interviewId: id } };
  }
  return { root, interview, call, calls, prepared, start };
}
function noPrivatePayload(text) {
  for (const value of ['PRIVATE_FACT_CAPACITY','PRIVATE_CURVEBALL','PRIVATE_RATIONALE','FORGED_INITIAL_CODE','FORGED_STATEMENT']) assert.ok(!text.includes(value), `private or forged content leaked: ${value}`);
}
function historicalProfile(prompt) {
  const match = prompt.match(/"priorAssessments":(\{"records"[\s\S]*?\}),"recentObservations"/);
  assert.ok(match, 'prompt includes structured historical profile');
  return { assessments: JSON.parse(match[1]).records, completedInterviews: [] };
}
async function seedOtherTopic(f) {
  const slug = 'lld-locker', id = '1700000000000-abcdef12';
  const state = { ...newState({ slug, startedAt: 1700000000000, mode: 'typed' }), discipline: 'lld', title: 'Locker system', statement: 'Design a parcel locker system.', targetLevel: 'L4', endedAt: 1700000060000, debriefed: true };
  await f.interview.store.create(slug, id, state);
  await f.interview.store.append(slug, id, { kind: 'candidate', said: historicalQuote, elapsedMs: 10000 });
  await f.interview.store.append(slug, id, { kind: 'debrief', asked: report(historicalQuote, 'OTHER_TOPIC_ASSESSMENT'), elapsedMs: 60000 });
  await fs.mkdir(problemDir(f.root, slug), { recursive: true });
  await fs.writeFile(path.join(problemDir(f.root, slug), 'NOTES.md'), 'OTHER_TOPIC_NOTE: keep cancellation and capacity accounting consistent.');
  return { slug, id, source: `problems/${slug}/interviews/${id}` };
}

test('prepared LLD starts blank, hides private data, appears in catalogue and preserves its document', async t => {
  const f = await fixture(t), x = await f.start();
  noPrivatePayload(x.response.output); assert.ok(x.response.output.includes(proposed.statement));
  assert.equal(f.calls.length, 0, 'opening is the server-owned statement, without a provider call');
  const codeURL = `/api/lld/${x.slug}/${x.id}/code`;
  assert.deepEqual(JSON.parse((await f.call(lldRoutes, 'GET', codeURL)).output), { code: '' });
  const savedCode = 'class ReservationBook:\n    def cancel(self, key):\n        return key\n';
  await f.call(lldRoutes, 'PUT', codeURL, { code: savedCode });
  assert.equal(JSON.parse((await f.call(lldRoutes, 'GET', codeURL)).output).code, savedCode);
  const list = await f.call(lldRoutes, 'GET', '/api/lld'); noPrivatePayload(list.output);
  const catalog = JSON.parse(list.output);
  assert.deepEqual(catalog.scenarios.find(p => p.slug === x.slug), { slug: x.slug, title: proposed.title, statement: proposed.statement, discipline: 'lld' });
  assert.equal(catalog.interviews.find(row => row.id === x.id).title, proposed.title);
  const detail = await f.call(interviewRoutes, 'GET', `/api/interview/${x.slug}/${x.id}`); noPrivatePayload(detail.output);
  const resumed = await f.start(); assert.equal(JSON.parse(resumed.response.output).id, x.id);
  assert.equal(JSON.parse((await f.call(lldRoutes, 'GET', codeURL)).output).code, savedCode);
  await f.call(interviewRoutes, 'POST', '/api/interview/done', { ...x.body, code: savedCode, said: 'I will track remaining capacity', requestId: 'finish-code' });
  assert.equal(JSON.parse((await f.call(lldRoutes, 'GET', codeURL)).output).code, savedCode);
});

test('mode persists during pause without changing identity, clock or prior transcript; invalid and finished updates fail', async t => {
  const f = await fixture(t), x = await f.start();
  await f.call(interviewRoutes, 'POST', '/api/interview/pause', x.body);
  const before = await f.interview.store.readState(x.slug, x.id), turnsBefore = await f.interview.store.readTurns(x.slug, x.id);
  const response = await f.call(interviewRoutes, 'POST', '/api/interview/mode', { ...x.body, mode: 'voice' });
  const after = await f.interview.store.readState(x.slug, x.id), turnsAfter = await f.interview.store.readTurns(x.slug, x.id);
  assert.equal(JSON.parse(response.output).state.mode, 'voice'); assert.equal(after.mode, 'voice');
  for (const key of ['startedAt','pausedAt','pausedMs','endedAt','phaseSinceMs','turns']) assert.equal(after[key], before[key], key);
  assert.deepEqual(after.phaseMs, before.phaseMs); assert.equal(elapsed(after, Date.now() + 60000), elapsed(before));
  assert.deepEqual(turnsAfter.filter(row => row.kind !== 'mode'), turnsBefore);
  assert.deepEqual(turnsAfter.filter(row => row.kind === 'mode').map(row => row.mode), ['voice']);
  assert.deepEqual(await f.interview.store.list(x.slug), [x.id]);
  await assert.rejects(f.call(interviewRoutes, 'POST', '/api/interview/mode', { ...x.body, mode: 'hybrid' }), { code: 'BAD_REQUEST' });
  assert.equal((await f.interview.store.readState(x.slug, x.id)).mode, 'voice');
  await f.call(interviewRoutes, 'POST', '/api/interview/done', { ...x.body, requestId: 'finish-paused' });
  await assert.rejects(f.call(interviewRoutes, 'POST', '/api/interview/mode', { ...x.body, mode: 'typed' }), error => ['ENDED','FINISHED'].includes(error.code));
});

test('live interviewer receives no past assessment or notes; the debrief does', async t => {
  const f = await fixture(t), other = await seedOtherTopic(f), x = await f.start();
  await f.call(interviewRoutes, 'POST', '/api/interview/turn', { ...x.body, said: 'I will track remaining capacity', code: 'capacity = {}', requestId: 'live-answer' });
  const live = f.calls.at(-1).prompt;
  assert.doesNotMatch(live, /OTHER_TOPIC_ASSESSMENT|OTHER_TOPIC_NOTE|NOTES\.md|CURRENT_SESSION_ASSESSMENT/);
  assert.equal(f.calls.at(-1).tools, '');
  await f.call(interviewRoutes, 'POST', '/api/interview/done', { ...x.body, code: 'capacity = {}', requestId: 'live-debrief' });
  const debrief = f.calls.at(-1).prompt, history = historicalProfile(debrief);
  const prior = history.assessments.find(a => a.summary === 'OTHER_TOPIC_ASSESSMENT');
  assert.ok(prior); assert.equal(prior.source, `tracks/lld/${other.source}`);
  assert.equal(prior.dimensions.find(d => d.name === 'Correctness').evidence[0].quote, historicalQuote);
  assert.ok(!history.assessments.some(a => a.slug === x.slug && a.summary === 'CURRENT_SESSION_ASSESSMENT'));
});

test('post-interview review has cross-topic evidence but keeps the current report out of historical judgements', async t => {
  const f = await fixture(t), other = await seedOtherTopic(f), x = await f.start();
  await f.call(interviewRoutes, 'POST', '/api/interview/done', { ...x.body, said: 'I will track remaining capacity', code: 'capacity = {}', requestId: 'finish-review' });
  const response = await f.call(interviewRoutes, 'POST', '/api/interview/ask', { ...x.body, question: 'How should I improve cancellation handling?', requestId: 'review-question' });
  assert.ok(response.events.some(e => e.name === 'done'));
  const prompt = f.calls.at(-1).prompt;
  assert.ok(prompt.includes('CURRENT_SESSION_ASSESSMENT'), 'current report is separately available for review');
  assert.ok(prompt.includes('OTHER_TOPIC_ASSESSMENT'));
  assert.doesNotMatch(prompt, /OTHER_TOPIC_NOTE|NOTES\.md/);
});
