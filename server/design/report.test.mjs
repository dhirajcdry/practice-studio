// Phase durations for a system design report, counted from a made-up raw record.
import test from 'node:test';
import assert from 'node:assert/strict';

import { designPhaseTimes, buildDesignReport } from './report.mjs';

const min = n => n * 60000;
const byPhase = phases => Object.fromEntries(phases.map(p => [p.phase, p.ms]));

test('phase durations come from the turns: answers own the time before them, replies the time after', () => {
  const turns = [
    { kind: 'opening', elapsedMs: 0, asked: 'Design a parking garage system.' },
    { kind: 'candidate', elapsedMs: min(4), phase: 'requirements', said: 'Who parks, and how many floors?' },
    { kind: 'turn', elapsedMs: min(4.5), phase: 'entities', asked: 'Assume three floors.' },
    { kind: 'tool_action', elapsedMs: min(6), action: { type: 'board' } },
    { kind: 'candidate', elapsedMs: min(9), phase: 'entities', said: 'Spot, ticket, gate.' },
    { kind: 'turn', elapsedMs: min(9.5), phase: 'api', asked: 'What does the gate call?' },
    { kind: 'candidate', elapsedMs: min(14), phase: 'api', said: 'POST /tickets.' },
    { kind: 'interviewer_silent', elapsedMs: min(14.5), phase: 'api' },
    { kind: 'debrief', elapsedMs: min(30), asked: '{}' },
  ];
  const times = byPhase(designPhaseTimes(turns));
  assert.equal(times.requirements, min(4.5));
  assert.equal(times.entities, min(5));
  assert.equal(times.api, min(5));
  // Never reached: stated as not recorded, not as zero.
  for (const phase of ['estimates', 'design', 'deepdive', 'bottlenecks']) assert.equal(times[phase], null);
});

test('the debrief and the time after the last turn are never added to a phase', () => {
  const times = byPhase(designPhaseTimes([
    { kind: 'opening', elapsedMs: 0, asked: 'Design a chat service.' },
    { kind: 'candidate', elapsedMs: min(2), phase: 'requirements', said: 'One-to-one first.' },
    { kind: 'debrief', elapsedMs: min(40), asked: '{}' },
  ]));
  assert.equal(times.requirements, min(2));
});

test('turns with no time or no phase are left unplaced instead of guessed', () => {
  assert.deepEqual(designPhaseTimes([{ kind: 'turn', said: 'An older turn.', asked: 'Go on.', phase: 'api' }]), []);
  assert.deepEqual(designPhaseTimes([]), []);
  // A reply without a phase before the first answer: its time belongs nowhere.
  const times = byPhase(designPhaseTimes([
    { kind: 'opening', elapsedMs: 0, asked: 'Design a feed.' },
    { kind: 'turn', elapsedMs: min(3), said: 'Older shape.', asked: 'And then?' },
    { kind: 'turn', elapsedMs: min(5), said: 'Fan-out.', asked: 'Why?', phase: 'design' },
    { kind: 'candidate', elapsedMs: min(8), phase: 'design', said: 'Read-heavy.' },
    { kind: 'candidate', elapsedMs: min(9), phase: 'not-a-phase', said: 'Unknown tag.' },
  ]));
  assert.equal(times.requirements, null);
  assert.equal(times.design, min(4));
});

test('the design report carries the derived phases', () => {
  const report = buildDesignReport({ debriefed: true, startedAt: 1000, endedAt: 1000 + min(10), minutes: 45 }, [
    { kind: 'opening', elapsedMs: 0, asked: 'Design a URL shortener.' },
    { kind: 'candidate', elapsedMs: min(3), phase: 'requirements', said: 'Reads dominate.' },
    { kind: 'debrief', elapsedMs: min(10), asked: '{"signal":"Hire"}' },
  ]);
  assert.equal(report.facts.phases.length, 7);
  assert.equal(byPhase(report.facts.phases).requirements, min(3));
});
