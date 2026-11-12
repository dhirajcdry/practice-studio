import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readTrackHome } from './track-home.mjs';
import { learnerRoutes } from './routes.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-track-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { root, write };
}
const state = (startedAt) => ({ discipline: 'lld', startedAt, endedAt: startedAt + 60000, debriefed: true, minutes: 45, targetLevel: 'L5', phase: 'debrief', phaseSinceMs: 0, phaseMs: { debrief: 0 }, pausedMs: 0, spentMs: 60000 });
const turns = report => [
  { kind: 'turn', said: 'Holds expire lazily on read', elapsedMs: 5000 },
  { kind: 'debrief', asked: typeof report === 'string' ? report : JSON.stringify(report) },
].map(x => JSON.stringify(x)).join('\n');

test('track home lists graded mocks newest first, with evidence-backed ratings only', async t => {
  const { root, write } = await workspace(t);
  const older = 'problems/lld-locker/interviews/1700000000000-aaaaaaaa';
  const newer = 'problems/lld-vending-machine/interviews/1700000100000-bbbbbbbb';
  await write(`${older}/interview.json`, state(1700000000000));
  await write(`${older}/turns.jsonl`, turns({ signal: 'Lean no', headline: 'Missed expiry', moveUp: 'Define the state machine first',
    dimensions: [{ name: 'Correctness', rating: 'Weak', evidence: [{ quote: 'Holds expire lazily on read' }] }, { name: 'Interfaces', rating: 'Strong', evidence: [] }],
    practice: [{ title: 'Trace an expiry', why: 'Expired holds were sold', fix: 'Walk one hold through every state' }] }));
  await write(`${newer}/interview.json`, state(1700000100000));
  await write(`${newer}/turns.jsonl`, turns('Prose feedback from an older report format.'));

  const home = await readTrackHome(root, 'lld');
  assert.equal(home.rubric.length, 9);
  assert.deepEqual(home.assessments.map(a => a.slug), ['lld-vending-machine', 'lld-locker']);
  const [prose, graded] = home.assessments;
  assert.equal(prose.structured, false);
  assert.deepEqual(prose.dimensions, []);
  assert.equal(graded.structured, true);
  assert.equal(graded.headline, 'Missed expiry');
  assert.equal(graded.moveUp, 'Define the state machine first');
  assert.equal(graded.dimensions.find(d => d.name === 'Correctness').rating, 'Weak');
  // A rating the interviewer gave without evidence is not a rating.
  assert.equal(graded.dimensions.find(d => d.name === 'Interfaces').rating, null);
  assert.equal(graded.practice[0].fix, 'Walk one hold through every state');
  assert.ok(home.problems.some(p => p.slug === 'lld-locker' && p.title));
  // Reading is not writing: the raw record is untouched.
  assert.match(await fs.readFile(path.join(root, older, 'turns.jsonl'), 'utf8'), /Holds expire lazily/);
});

test('track home route rejects unknown tracks', async t => {
  const { root } = await workspace(t);
  const res = { writeHead() {}, end() {} };
  await assert.rejects(learnerRoutes['GET /api/track-home']({ url: '/api/track-home?discipline=coding' }, res, { homeRoot: root }), /discipline must be/);
  let body = '';
  await learnerRoutes['GET /api/track-home']({ url: '/api/track-home?discipline=design' }, { writeHead() {}, end(chunk) { body = chunk; } }, { homeRoot: root });
  const home = JSON.parse(body);
  assert.equal(home.rubric.length, 7);
  assert.deepEqual(home.assessments, []);
});
