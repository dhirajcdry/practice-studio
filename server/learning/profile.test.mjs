import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readLearnerProfile, learnerContext, setLearnerPreferences } from './profile.mjs';

test('profile preserves no-evidence distinction and bounded context', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-'));
  await fs.mkdir(path.join(root, 'problems', 'two-sum'), { recursive: true });
  await fs.writeFile(path.join(root, 'problems', 'two-sum', 'meta.json'), JSON.stringify({ submissions: [] }));
  const p = await readLearnerProfile(root);
  assert.deepEqual(p.attempted.coding, []); assert.deepEqual(p.completed.coding, []);
  assert.equal(p.assessments.length, 0); assert.equal(learnerContext(p).includes('untrusted data'), true);
});

test('directory scans ignore metadata files and non-directory entries', async t => {
  const { root } = await fixture(t);
  await fs.mkdir(path.join(root, 'problems', 'two-sum'), { recursive: true });
  await fs.writeFile(path.join(root, 'problems', '.DS_Store'), 'metadata');
  await fs.writeFile(path.join(root, 'problems', 'two-sum', 'meta.json'), JSON.stringify({}));
  await fs.writeFile(path.join(root, 'problems', 'two-sum', 'interviews'), 'not a directory');
  const p = await readLearnerProfile(root);
  assert.deepEqual(p.attempted.coding, []);
  assert.deepEqual(p.warnings, []);
});

test('preferences validate levels and atomically preserve fields', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-'));
  const value = await setLearnerPreferences(root, { targetLevel: { coding: 'L5' }, answerMode: 'voice' });
  assert.equal(value.targetLevel.default, 'L4'); assert.equal(value.targetLevel.coding, 'L5');
  await assert.rejects(() => setLearnerPreferences(root, { targetLevel: { design: 'L2' } }));
  const stored = JSON.parse(await fs.readFile(path.join(root, 'learner-profile.json'))); assert.equal(stored.answerMode, 'voice');
});

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-profile-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value)); };
  return { root, write };
}
const mock = (discipline = 'coding') => ({ discipline, startedAt: 1000, endedAt: 61000, debriefed: true, minutes: 45, targetLevel: 'L5', phase: 'debrief', phaseSinceMs: 0, phaseMs: { debrief: 0 }, pausedMs: 0, spentMs: 60000 });
const transcript = (dimension = 'Coding') => [
  { kind: 'turn', said: 'I missed the empty input', elapsedMs: 10000 },
  { kind: 'debrief', asked: JSON.stringify({ signal: 'Lean no', summary: 'Review boundary handling', dimensions: [{ name: dimension, rating: 'Weak', evidence: [{ quote: 'I missed the empty input' }, { quote: 'invented quote' }] }], practice: [{ title: 'Boundary tests', why: 'Empty input was missed' }] }) },
].map(x => JSON.stringify(x)).join('\n');

test('all identities survive more than 20 mocks; coding mocks do not fabricate solves', async t => {
  const { root, write } = await fixture(t);
  for (let i = 0; i < 25; i++) {
    const base = `problems/problem-${i}/interviews/${1700000000000 + i}-abcdef12`;
    await write(`${base}/interview.json`, mock()); await write(`${base}/turns.jsonl`, transcript());
  }
  const p = await readLearnerProfile(root);
  assert.equal(p.attempted.coding.length, 25); assert.equal(p.completed.coding.length, 0);
  assert.equal(p.completedInterviews.length, 25); assert.equal(p.assessments.length, 20);
  assert.equal(p.coverage.assessmentsTotal, 25);
  assert.equal(p.assessments[0].signal, 'Lean no'); assert.equal(p.assessments[0].targetLevel, 'L5');
  const evidence = p.assessments[0].dimensions.find(d => d.name === 'Coding').evidence;
  assert.equal(evidence[0].quote, 'I missed the empty input'); assert.equal(evidence[0].provenance, 'quote');
  assert.equal(evidence[1].quote, null); assert.equal(evidence[1].provenance, 'interpretation');
  assert.equal(p.preferences.targetLevel, undefined);
  assert.doesNotThrow(() => JSON.parse(learnerContext(p).split('\n').slice(1).join('\n')));
});

test('legacy and indexed design records share topic identity and do not duplicate mocks', async t => {
  const { root, write } = await fixture(t), id = '2026-10-20T00-00-00-000Z';
  const state = { ...mock('design'), prompt: 'Design a URL-shortening service.' };
  for (const base of [`design/${id}`, `problems/design-url-shortener/interviews/${id}`]) {
    await write(`${base}/interview.json`, state); await write(`${base}/turns.jsonl`, transcript('Architecture'));
  }
  await write(`design/${id}.json`, { topicSlug: 'design-url-shortener' });
  const second = '2026-10-21T00-00-00-000Z';
  await write(`design/${second}/interview.json`, state); await write(`design/${second}/turns.jsonl`, transcript('Architecture'));
  const p = await readLearnerProfile(root);
  assert.equal(p.attempted.design.length, 1); assert.equal(p.completed.design.length, 1);
  assert.equal(p.completedInterviews.length, 2); assert.equal(p.assessments.length, 2);
  assert.equal(p.attempted.design[0].slug, 'design-url-shortener'); assert.equal(p.attempted.design[0].statement, state.prompt);
});

test('sessions establish seen and accepted history; corrupt adjacent records do not erase evidence', async t => {
  const { root, write } = await fixture(t);
  await write('problems/two-sum/meta.json', '{bad');
  await write('problems/two-sum/sessions/a.jsonl', [
    { at: '2026-10-10', type: 'first_keystroke' },
    { at: '2026-10-11', type: 'run_result', data: { summary: { failed: 2, total: 3 } } },
    { at: '2026-10-12', type: 'verdict', data: { accepted: true, verdict: 'Accepted' } },
  ].map(JSON.stringify).join('\n'));
  await write('problems/two-sum/attempts/a.py', '# not executed');
  await fs.mkdir(path.join(root, 'TUTOR.md'));
  const p = await readLearnerProfile(root);
  assert.equal(p.attempted.coding.length, 1); assert.equal(p.completed.coding.length, 1);
  assert.equal(p.observations.find(x => x.type === 'run_result').failed, 2);
  assert.ok(p.warnings.some(x => x.includes('meta.json')));
});

test('no opening is legitimate; corrupt turns and completed-without-turns are explicit gaps', async t => {
  const { root, write } = await fixture(t);
  const base = 'problems/lld-locker/interviews/1700000000000-abcdef12';
  await write(`${base}/interview.json`, { ...mock('lld'), debriefed: false });
  let p = await readLearnerProfile(root); assert.deepEqual(p.warnings, []); assert.equal(p.assessments.length, 0);
  await write(`${base}/interview.json`, mock('lld'));
  p = await readLearnerProfile(root); assert.ok(p.warnings.some(x => x.includes('Missing recorded turns')));
  await write(`${base}/turns.jsonl`, transcript('Correctness') + '\n{bad');
  p = await readLearnerProfile(root); assert.equal(p.assessments.length, 0); assert.equal(p.completed.lld.length, 0); assert.ok(p.warnings.some(x => x.includes('Corrupt')));
});

test('concurrent preference updates merge; corrupt preferences cannot be overwritten', async t => {
  const { root, write } = await fixture(t);
  await Promise.all([setLearnerPreferences(root, { targetLevel: { coding: 'L5' } }), setLearnerPreferences(root, { targetLevel: { design: 'L6' }, answerMode: 'voice' })]);
  let p = await readLearnerProfile(root); assert.deepEqual(p.preferences.targetLevel, { default: 'L4', coding: 'L5', design: 'L6' });
  await write('learner-profile.json', '{bad');
  await assert.rejects(setLearnerPreferences(root, { answerMode: 'typed' }), /corrupt/);
  assert.equal(await fs.readFile(path.join(root, 'learner-profile.json'), 'utf8'), '{bad');
  assert.equal((await fs.readdir(root)).filter(x => x.endsWith('.tmp')).length, 0);
});

test('unsubstantiated ratings stay unrated and recent notes declare omitted coverage', async t => {
  const { root, write } = await fixture(t);
  for (let i = 0; i < 10; i++) {
    await write(`problems/p-${i}/sessions/a.jsonl`, JSON.stringify({ type: 'first_keystroke', at: `2026-10-${String(i + 1).padStart(2, '0')}` }));
    await write(`problems/p-${i}/NOTES.md`, 'x'.repeat(4000));
    await fs.utimes(path.join(root, `problems/p-${i}/NOTES.md`), i + 1000, i + 1000);
  }
  const base = 'problems/p-0/interviews/1700000000000-abcdef12';
  await write(`${base}/interview.json`, mock());
  await write(`${base}/turns.jsonl`, JSON.stringify({ kind: 'debrief', asked: JSON.stringify({ dimensions: [{ name: 'Coding', rating: 'Strong', summary: 'Unsupported claim' }] }) }));
  const p = await readLearnerProfile(root);
  assert.equal(p.assessments[0].dimensions.find(d => d.name === 'Coding').rating, null);
  assert.deepEqual(p.recurring, { strengths: [], weaknesses: [] });
  assert.equal(p.coverage.notesTotal, 10); assert.equal(p.coverage.notesIncluded, 8);
  assert.equal(p.documents['problems/p-9/NOTES.md'].truncatedCharacters, 1000);
  assert.equal(p.documents['problems/p-0/NOTES.md'], undefined);
});
