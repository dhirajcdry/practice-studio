import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { CoachService, handleCoachMessage, handleCoachRuns } from '../routes.mjs';
import { upkeepQueue } from '../upkeep.mjs';
import { DesignService, routes as designRoutes } from '../../design/routes.mjs';

const fake = new URL('./bin/fake-claude.mjs', import.meta.url).pathname;
const designFake = new URL('../../design/test/fake-claude.mjs', import.meta.url).pathname;
class Response extends EventEmitter {
  text = '';
  writeHead() {}
  write(text) { this.text += text; this.emit('write', text); }
  end(text = '') { this.text += text; this.emit('finish'); }
}
const request = body => Readable.from([Buffer.from(JSON.stringify(body))]);
async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-answer-upkeep-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'problems/two-sum'), { recursive: true });
  await fs.writeFile(path.join(root, 'TUTOR.md'), 'Learner profile');
  await fs.writeFile(path.join(root, 'problems/two-sum/NOTES.md'), 'Prior notes');
  return root;
}

test('Claude answer sends done and finishes run before enqueuing the same-model upkeep', async t => {
  const root = await workspace(t), res = new Response(), jobs = [], logs = [];
  const promptFile = path.join(root, 'prompt.txt'), argsFile = path.join(root, 'args.json');
  await fs.writeFile(path.join(root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'opus' }));
  const coach = new CoachService({ root, binary: fake, env: { ...process.env, FAKE_CLAUDE_PROMPT_FILE: promptFile, FAKE_CLAUDE_ARGS_FILE: argsFile }, log: { info: line => logs.push(line) } });
  t.mock.method(upkeepQueue, 'enqueue', job => {
    assert.match(res.text, /event: done/);
    assert.equal(coach.runs.summaries()[0].status, 'done');
    jobs.push(job);
  });
  await handleCoachMessage(request({ slug: 'two-sum', message: 'help' }), res, { coach });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].model, 'opus');
  assert.equal(jobs[0].kind, 'question');
  assert.ok(jobs[0].sessionId);
  const first = await fs.readFile(promptFile, 'utf8');
  assert.match(first, /Learner profile/);
  assert.match(first, /Prior notes/);
  assert.match(first, /Files you must NEVER write/);
  const args = JSON.parse(await fs.readFile(argsFile));
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob');
  await handleCoachMessage(request({ slug: 'two-sum', message: 'another question' }), res, { coach });
  const second = await fs.readFile(promptFile, 'utf8');
  assert.doesNotMatch(second, /Learner profile|Prior notes/);
  assert.match(second, /unchanged since earlier in this conversation/);
  await fs.writeFile(path.join(root, 'problems/two-sum/NOTES.md'), 'Updated observation');
  await handleCoachMessage(request({ slug: 'two-sum', kind: 'attempt-review' }), res, { coach });
  assert.match(await fs.readFile(promptFile, 'utf8'), /Updated observation/);
  assert.equal(jobs.at(-1).kind, 'attempt-review');
  assert.equal(logs.filter(line => line.includes('[coach] timing')).length, 3);
  const list = new Response();
  await handleCoachRuns({}, list, { coach });
  assert.deepEqual(JSON.parse(list.text).upkeep, { running: null, queued: 0 });
});

test('failed and stopped coach turns never enqueue upkeep', async t => {
  const root = await workspace(t), jobs = [];
  t.mock.method(upkeepQueue, 'enqueue', job => jobs.push(job));
  for (const mode of ['crash', 'hang']) {
    const coach = new CoachService({ root, binary: fake, env: { ...process.env, FAKE_CLAUDE_MODE: mode }, log: { warn() {} } });
    const res = new Response();
    if (mode === 'hang') res.on('write', text => {
      if (text.includes('event: token')) coach.runs.stop(coach.runs.liveFor('two-sum'));
    });
    await handleCoachMessage(request({ slug: 'two-sum', message: 'help' }), res, { coach });
    assert.equal(coach.runs.summaries()[0].status, mode === 'crash' ? 'error' : 'stopped');
  }
  assert.equal(jobs.length, 0);
});

test('design opening preloads memory; only completed debrief queues upkeep after done', async t => {
  const root = await workspace(t), jobs = [];
  await fs.writeFile(path.join(root, 'DESIGN.md'), 'Design observation');
  const promptFile = path.join(root, 'design-prompt.txt');
  t.mock.method(upkeepQueue, 'enqueue', job => { assert.match(current.text, /event: done/); jobs.push(job); });
  const old = process.env.STUDIO_FAKE_PROMPT_FILE;
  process.env.STUDIO_FAKE_PROMPT_FILE = promptFile;
  t.after(() => { if (old === undefined) delete process.env.STUDIO_FAKE_PROMPT_FILE; else process.env.STUDIO_FAKE_PROMPT_FILE = old; });
  const design = new DesignService({ root, binary: designFake, log: { warn() {} } });
  let current;
  const call = async (route, body) => {
    current = new Response();
    const finished = new Promise(resolve => current.once('finish', resolve));
    await designRoutes[route](request(body), current, { design });
    await finished;
    return current.text;
  };
  const opening = await call('POST /api/design/start', { prompt: 'Design a cache' });
  const id = JSON.parse(opening.match(/event: interview\ndata: (.*)/)[1]).id;
  assert.match(await fs.readFile(promptFile, 'utf8'), /Design observation/);
  assert.equal(jobs.length, 0);
  await call('POST /api/design/turn', { interviewId: id, said: 'I would use a cache' });
  assert.doesNotMatch(await fs.readFile(promptFile, 'utf8'), /Design observation/);
  assert.equal(jobs.length, 0);
  await fs.writeFile(path.join(root, 'design', id, 'NOTES.md'), 'Changed design notes');
  await call('POST /api/design/done', { interviewId: id });
  assert.match(await fs.readFile(promptFile, 'utf8'), /Changed design notes/);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].slug, `design:${id}`);
  assert.equal(jobs[0].kind, 'design-debrief');
});
