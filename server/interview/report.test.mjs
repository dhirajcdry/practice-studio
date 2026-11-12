import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReport, reportFacts, buildReport } from './report.mjs';
import { newState } from './state.mjs';

const turns = [
  { kind: 'opening', elapsedMs: 0, asked: 'Walk me through your approach.' },
  { kind: 'candidate', elapsedMs: 30000, said: 'I would track the furthest reachable index.' },
  { kind: 'event', elapsedMs: 300000, event: { type: 'run_result', passed: 1, failed: 2, total: 3 } },
  { kind: 'event', elapsedMs: 360000, event: { type: 'run_result', passed: 3, failed: 0, total: 3 } },
  { kind: 'event', elapsedMs: 420000, event: { type: 'verdict', verdict: 'Accepted', status: 'accepted', accepted: true } },
];

test('a quote the candidate never said is demoted to an observation', () => {
  const report = parseReport(JSON.stringify({ signal: 'hire', dimensions: [{ name: 'Problem solving', rating: 'strong', evidence: [
    { at: '00:30', quote: 'I would track the furthest reachable index', note: 'Invariant first.' },
    { at: '01:00', quote: 'I used dynamic programming.', note: '' },
  ] }] }), turns);
  assert.equal(report.signal, 'Hire');
  const [real, invented] = report.dimensions[0].evidence;
  assert.equal(real.quote, 'I would track the furthest reachable index');
  assert.equal(real.at, 30000);
  assert.equal(invented.quote, null);
  assert.equal(invented.note, 'I used dynamic programming.');
  assert.equal(report.dimensions[3].name, 'Testing');
  assert.equal(report.dimensions[3].rating, null, 'a missing area is unrated, not defaulted');
});

test('fenced or prefixed JSON parses; prose does not', () => {
  assert.equal(parseReport('Here you go:\n```json\n{"signal":"No hire"}\n```').signal, 'No hire');
  assert.equal(parseReport('## Hire signal\nLean hire'), null);
  assert.equal(parseReport('{"signal":"Maybe"}').signal, null, 'unknown signals are dropped');
});

test('facts are counted from the record', () => {
  const state = newState({ slug: 'jump-game', startedAt: 0 });
  state.endedAt = 600000; state.hints.push({ level: 'nudge', elapsedMs: 200000, phase: 'approach' });
  const facts = reportFacts(state, turns, 600000);
  assert.equal(facts.durationMs, 600000);
  assert.deepEqual(facts.runs.map(r => r.passed), [false, true]);
  assert.equal(facts.firstRunAt, 300000);
  assert.equal(facts.verdicts[0].accepted, true);
  assert.equal(facts.hints.length, 1);
  assert.ok(facts.talkShare > 0 && facts.talkShare < 1);
});

test('no report before a debrief exists', () => {
  assert.equal(buildReport(newState({ slug: 'x' }), turns), null);
});

test('report grounding uses exact quote provenance and bounds timeline timestamps', () => {
  const report = parseReport(JSON.stringify({ dimensions: [{ name: 'Testing', rating: 'Strong', evidence: [] }, { name: 'Coding', rating: 'Solid', evidence: [{ quote: 'I would track the furthest reachable index.', at: '09:00' }, { quote: 'i would track the furthest reachable index', at: '99:00' }] }], moments: [{ at: '01:80', text: 'invalid seconds' }, { at: '99:00', text: 'outside interview' }, { at: '00:30', text: 'Candidate observation' }] }), turns, { durationMs: 600000 });
  assert.equal(report.dimensions[3].rating, null);
  assert.equal(report.dimensions[1].evidence[0].at, 30000);
  assert.equal(report.dimensions[1].evidence[0].provenance, 'quote');
  assert.equal(report.dimensions[1].evidence[1].quote, null);
  assert.equal(report.dimensions[1].evidence[1].at, null);
  assert.equal(report.moments.length, 1);
});

test('practice items keep their fix headline and a bounded moment; older items get nulls', () => {
  const report = parseReport(JSON.stringify({ practice: [
    { fix: 'Name edge cases first', at: '00:20', title: 'Three cases before every run', why: 'No cases offered.' },
    { title: 'Older drill', why: 'Older report.' },
    { fix: 'Late', at: '99:00', title: 'Out of range', why: 'x' },
  ] }), turns, { durationMs: 600000 });
  assert.deepEqual(report.practice[0], { title: 'Three cases before every run', why: 'No cases offered.', fix: 'Name edge cases first', at: 20000 });
  assert.equal(report.practice[1].fix, null);
  assert.equal(report.practice[1].at, null);
  assert.equal(report.practice[2].at, null, 'a moment past the end of the interview is dropped');
});
