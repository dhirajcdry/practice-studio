import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DEFAULT_REPORT_DIFFICULTY, REPORT_DIFFICULTIES, readReportDifficulty, saveReportDifficulty, reportDifficultyRoutes } from './report-difficulty.mjs';
import { debriefPrompt } from './prompt.mjs';
import { newState } from './state.mjs';
import { buildReport, parseReport, reportMarkdown, reportDifficultyLabel } from './report.mjs';
import { reviewContextSections, reviewSystemPrompt } from './review.mjs';
import { focusedProfile } from '../coach/context-policy.mjs';
import { readLearnerProfile } from '../learning/profile.mjs';
import { problemDir } from '../storage-layout.mjs';
import { InterviewService, interviewRoutes } from './routes.mjs';
import { fixtureReport } from './test/report-fixture.mjs';

const binary = new URL('./test/fake-interviewer.mjs', import.meta.url).pathname;
async function scratch(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-report-difficulty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function route(key, root, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
  let status, output = '';
  const res = { writeHead(code) { status = code; }, end(chunk = '') { output += chunk; } };
  await reportDifficultyRoutes[key](req, res, { homeRoot: root });
  return { status, json: JSON.parse(output) };
}

test('settings: the default is beginner and a saved value is read back atomically', async t => {
  const root = await scratch(t);
  assert.deepEqual(REPORT_DIFFICULTIES, ['beginner', 'mid-level']);
  assert.equal(DEFAULT_REPORT_DIFFICULTY, 'beginner');
  assert.equal(await readReportDifficulty(root), 'beginner');
  assert.equal(await saveReportDifficulty(root, 'mid-level'), 'mid-level');
  assert.equal(await readReportDifficulty(root), 'mid-level');
  assert.deepEqual(await fs.readdir(root), ['report-settings.json'], 'no temp file is left behind');
});

test('settings: a corrupt or unknown saved value falls back to the default', async t => {
  const root = await scratch(t), file = path.join(root, 'report-settings.json');
  for (const bad of ['{not json', 'null', '[]', '{"difficulty":"impossible"}', '{}']) {
    await fs.writeFile(file, bad);
    assert.equal(await readReportDifficulty(root), 'beginner', bad);
  }
  await fs.rm(file); await fs.mkdir(file);
  assert.equal(await readReportDifficulty(root), 'beginner', 'an unreadable path');
});

test('settings: an invalid save is a 400 and keeps the saved value', async t => {
  const root = await scratch(t);
  await saveReportDifficulty(root, 'mid-level');
  for (const bad of ['impossible', '', undefined, null, 1, ['beginner']]) {
    await assert.rejects(saveReportDifficulty(root, bad), e => e.status === 400 && e.code === 'BAD_REQUEST');
  }
  assert.equal(await readReportDifficulty(root), 'mid-level');
});

test('routes: GET and PUT speak {difficulty}, and a bad PUT is rejected', async t => {
  const root = await scratch(t);
  assert.deepEqual(await route('GET /api/report/difficulty', root), { status: 200, json: { difficulty: 'beginner' } });
  assert.deepEqual(await route('PUT /api/report/difficulty', root, { difficulty: 'mid-level' }), { status: 200, json: { difficulty: 'mid-level' } });
  assert.deepEqual(await route('GET /api/report/difficulty', root), { status: 200, json: { difficulty: 'mid-level' } });
  await assert.rejects(route('PUT /api/report/difficulty', root, { difficulty: 'hard' }), e => e.status === 400);
  await assert.rejects(route('PUT /api/report/difficulty', root, {}), e => e.status === 400);
});

test('debriefPrompt: each difficulty sets its bar, and undefined keeps the target level', () => {
  const state = { ...newState({ slug: 'x' }), discipline: 'coding', targetLevel: 'L4' };
  const beginner = debriefPrompt({ ...state, reportDifficulty: 'beginner' }, [], Date.now());
  assert.match(beginner, /DIFFICULTY: Beginner/);
  assert.match(beginner, /core operation was left unwritten or could not run, Lean no is the ceiling/);
  assert.match(beginner, /Beginner grading never turns that into a pass/);
  assert.match(beginner, /substantial time left/);
  assert.ok(beginner.includes('mid-level SDE II (L4)'));
  const midLevel = debriefPrompt({ ...state, reportDifficulty: 'mid-level' }, [], Date.now());
  assert.ok(midLevel.includes('mid-level SDE II (L4)'));
  assert.ok(!midLevel.includes('DIFFICULTY: Beginner'));
  // The bar defines every signal, not only the failing ones, or borderline sessions drift to Lean no.
  for (const signal of ['Strong hire is', 'Hire means', 'Lean hire means', 'Lean no means', 'Reserve No hire']) assert.ok(midLevel.includes(signal), signal);
  assert.match(midLevel, /gaps alone do not make a Lean no/);
  assert.match(midLevel, /not by counting weak dimensions/);
  assert.match(midLevel, /"moveUp":/);
  assert.match(midLevel, /what they achieved first/);
  const legacy = debriefPrompt(state, [], Date.now());
  assert.match(legacy, /fair hiring panel at L4/);
  assert.ok(!legacy.includes('DIFFICULTY: Beginner'));
  assert.ok(!legacy.includes('mid-level SDE II (L4)'));
});

const finished = extra => ({ ...newState({ slug: 'two-sum' }), debriefed: true, endedAt: Date.now(), ...extra });
const debriefTurns = [{ kind: 'candidate', said: 'I will use a map.', elapsedMs: 1000 }, { kind: 'debrief', asked: fixtureReport() }];

test('report text and follow-up context carry the difficulty only when it is set', () => {
  const graded = finished({ reportDifficulty: 'beginner' }), old = finished();
  const report = buildReport(graded, debriefTurns), legacy = buildReport(old, debriefTurns);
  assert.equal(report.difficulty, 'beginner');
  assert.equal(Object.hasOwn(legacy, 'difficulty'), false);
  assert.match(reportMarkdown(report), /^\*\*Lean hire\*\* · Beginner difficulty \(a step below mid-level\) — /);
  assert.match(reportMarkdown({ ...report, difficulty: 'mid-level' }), /^\*\*Lean hire\*\* · Mid-level difficulty — /);
  assert.match(reportMarkdown(legacy), /^\*\*Lean hire\*\* — /);
  assert.match(report.judgement.moveUp, /would have made this a Hire/);
  assert.match(reportMarkdown(report), /### What would move this up a level\n\nProposing/);
  assert.equal(parseReport('{"signal":"Hire"}').moveUp, null, 'an older report has no such line, and none is invented');
  const section = (state, value) => reviewContextSections({ state, turns: debriefTurns, report: value }).find(([name]) => name === 'Report')[1];
  assert.equal(section(graded, report).difficulty, 'beginner');
  assert.equal(Object.hasOwn(section(old, legacy), 'difficulty'), false);
  assert.match(reviewSystemPrompt(), /if the Report has a difficulty, that same difficulty \(beginner means the bar a step below mid-level\), else the bar of a candidate who would pass at their level/);
});

test('learner history labels the difficulty beside a signal, and old records stay as they were', async t => {
  const root = await scratch(t);
  const write = async (id, extra) => {
    const dir = path.join(problemDir(root, 'two-sum'), 'interviews', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'interview.json'), JSON.stringify(finished({ targetLevel: 'L4', ...extra })));
    await fs.writeFile(path.join(dir, 'turns.jsonl'), debriefTurns.map(x => JSON.stringify(x)).join('\n'));
  };
  await write('1700000000000-abcdef12', { reportDifficulty: 'beginner', endedAt: 2000 });
  await write('1700000000001-abcdef12', { endedAt: 1000 });
  const profile = await readLearnerProfile(root);
  assert.equal(profile.assessments[0].reportDifficulty, 'beginner');
  assert.equal(Object.hasOwn(profile.assessments[1], 'reportDifficulty'), false);
  const { records } = focusedProfile(profile, { discipline: 'coding', slug: 'two-sum' }).priorAssessments;
  assert.equal(records.find(a => a.date === 2000).gradedAt, 'Beginner difficulty (a step below mid-level)');
  assert.equal(Object.hasOwn(records.find(a => a.date === 1000), 'gradedAt'), false);
});

async function interviewFixture(t) {
  const root = await scratch(t);
  await fs.mkdir(path.join(root, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'two-sum.json'), JSON.stringify({ question: { title: 'Two Sum', content: '<p>Find two numbers.</p>' } }));
  const log = path.join(root, 'prompts.jsonl');
  const previous = process.env.FAKE_INTERVIEW_PROMPT;
  process.env.FAKE_INTERVIEW_PROMPT = log;
  t.after(() => { if (previous === undefined) delete process.env.FAKE_INTERVIEW_PROMPT; else process.env.FAKE_INTERVIEW_PROMPT = previous; });
  const interview = new InterviewService({ root, binary });
  const call = async (key, body = {}, params = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]); req.url = key.split(' ')[1];
    let output = '';
    const res = { writeHead() {}, write(chunk) { output += chunk; }, end(chunk = '') { output += chunk; }, flushHeaders() {} };
    await interviewRoutes[`${key.split(' ')[0]} ${new URL(req.url, 'http://localhost').pathname}`](req, res, { interview, params });
    return { output, events: [...output.matchAll(/event: (.+)\ndata: (.+)\n/g)].map(m => ({ name: m[1], data: JSON.parse(m[2]) })) };
  };
  const prompts = async () => (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt);
  const begin = async () => (await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45 })).events.find(e => e.name === 'interview').data.id;
  return { root, interview, call, prompts, begin };
}

test('coding debrief uses the saved difficulty, freezes it, and every record shows it', async t => {
  const { root, interview, call, prompts, begin } = await interviewFixture(t);
  await saveReportDifficulty(root, 'mid-level');
  const id = await begin();
  const done = await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'end-mid', said: 'I will use a map.' });
  assert.equal(done.events.find(e => e.name === 'done').data.state.reportDifficulty, 'mid-level');
  const prompt = (await prompts()).at(-1);
  assert.ok(prompt.includes('mid-level SDE II (L4)'));
  assert.ok(!prompt.includes('DIFFICULTY: Beginner'));

  await saveReportDifficulty(root, 'beginner');
  assert.equal((await interview.store.readState('two-sum', id)).reportDifficulty, 'mid-level', 'a later change never regrades');
  const detail = JSON.parse((await call('GET /api/interview/:slug/:id', {}, { slug: 'two-sum', id })).output);
  assert.equal(detail.reportDifficulty, 'mid-level');
  assert.equal(detail.report.difficulty, 'mid-level');
  const { interviews } = JSON.parse((await call('GET /api/interview?slug=two-sum')).output);
  assert.equal(interviews.find(x => x.id === id).reportDifficulty, 'mid-level');
  const doc = await fs.readFile(path.join(problemDir(root, 'two-sum'), 'interviews', id, 'interview.md'), 'utf8');
  assert.match(doc, /\*\*Lean hire\*\* · Mid-level difficulty/);

  await call('POST /api/interview/ask', { slug: 'two-sum', interviewId: id, requestId: 'why-1', question: 'Why that rating?' });
  assert.match((await prompts()).at(-1), /"difficulty":\s*"mid-level"/, 'follow-ups see the frozen difficulty');
});

test('coding debrief with nothing saved uses the Beginner default', async t => {
  const { interview, call, prompts, begin } = await interviewFixture(t);
  const id = await begin();
  await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'end-default', said: 'I will use a map.' });
  assert.match((await prompts()).at(-1), /DIFFICULTY: Beginner/);
  assert.equal((await interview.store.readState('two-sum', id)).reportDifficulty, 'beginner');
});

test('retrying a failed debrief regenerates it at the current difficulty', async t => {
  const { root, interview, call, prompts, begin } = await interviewFixture(t);
  await saveReportDifficulty(root, 'mid-level');
  const id = await begin();
  const run = interview.run;
  interview.run = options => { queueMicrotask(() => options.onError('Provider failed.')); return { kill() {}, exited: Promise.resolve() }; };
  await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'end-retry', said: 'I will use a map.' });
  interview.run = run;
  assert.equal((await interview.store.readState('two-sum', id)).debriefed, false);

  await saveReportDifficulty(root, 'beginner');
  await call('POST /api/interview/retry', { slug: 'two-sum', interviewId: id, requestId: 'end-retry' });
  const state = await interview.store.readState('two-sum', id);
  assert.equal(state.debriefed, true);
  assert.equal(state.reportDifficulty, 'beginner');
  assert.match((await prompts()).at(-1), /DIFFICULTY: Beginner/);
});

test('an old record without the field still reads, reports and answers follow-ups', async t => {
  const { interview, call, prompts, begin } = await interviewFixture(t);
  const id = await begin();
  await call('POST /api/interview/done', { slug: 'two-sum', interviewId: id, requestId: 'end-old', said: 'I will use a map.' });
  const state = await interview.store.readState('two-sum', id);
  delete state.reportDifficulty;
  await interview.store.writeState('two-sum', id, state);
  const detail = JSON.parse((await call('GET /api/interview/:slug/:id', {}, { slug: 'two-sum', id })).output);
  assert.equal(Object.hasOwn(detail, 'reportDifficulty'), false);
  assert.equal(detail.report.judgement.signal, 'Lean hire');
  assert.equal(Object.hasOwn(detail.report, 'difficulty'), false);
  const answer = await call('POST /api/interview/ask', { slug: 'two-sum', interviewId: id, requestId: 'old-1', question: 'Why that rating?' });
  assert.ok(answer.events.some(e => e.name === 'done'));
  assert.doesNotMatch((await prompts()).at(-1), /"difficulty"/);
  assert.equal((await interview.store.readState('two-sum', id)).reportDifficulty, undefined, 'reading never backfills it');
});

test('the earlier difficulty id still reads as Mid-level, in settings and on saved reports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'report-difficulty-legacy-'));
  try {
    await fs.writeFile(path.join(root, 'report-settings.json'), JSON.stringify({ difficulty: 'amazon-sde-2' })); // privacy-ok: legacy id
    assert.equal(await readReportDifficulty(root), 'mid-level');
    assert.equal(await saveReportDifficulty(root, 'amazon-sde-2'), 'mid-level'); // privacy-ok: legacy id
    assert.equal(reportDifficultyLabel('amazon-sde-2'), 'Mid-level difficulty'); // privacy-ok: legacy id
    assert.match(debriefPrompt({ ...newState({ slug: 'x' }), discipline: 'coding', targetLevel: 'L3', reportDifficulty: 'amazon-sde-2' }, [], Date.now()), /mid-level SDE II \(L4\)/); // privacy-ok: legacy id
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
