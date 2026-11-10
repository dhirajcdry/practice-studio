import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedInterview, interviewDuration, relativeInterviewDate, interviewOutcome, debriefSections, recordedPhaseTimes, reportDifficultyLabel, signalLabel } from '../../web/js/interview-format.js';
test('duration counts active time and reports missing starts honestly', () => {
  assert.equal(interviewDuration({}), 'Not started');
  assert.equal(interviewDuration({ startedAt: 1000, endedAt: 1100 }), 'Less than a minute');
  const record = { startedAt: 1000, pausedAt: 181000, pausedMs: 60000 };
  assert.equal(elapsedInterview(record, 900000), 120000);
  assert.equal(interviewDuration(record), '2 min');
  assert.equal(interviewDuration({ startedAt: 1000, endedAt: 3000 }), 'Less than a minute');
});
test('dates compare local calendar days including month boundaries', () => {
  const now = new Date(2026, 9, 1, 10).getTime();
  assert.equal(relativeInterviewDate(new Date(2026, 8, 30, 23).getTime(), now), 'Yesterday');
  assert.match(relativeInterviewDate(now, now), /^Today,/);
  assert.equal(relativeInterviewDate(null, now), 'Starting…');
});
test('outcomes never manufacture a hire signal', () => {
  assert.deepEqual(interviewOutcome({ debriefed: true }), { label: 'Completed', tone: 'neutral' });
  assert.deepEqual(interviewOutcome({ debriefed: true, hireSignal: 'No hire' }), { label: 'No hire', tone: 'danger' });
  assert.equal(interviewOutcome({ endedAt: 4 }).label, 'Needs feedback');
  assert.equal(interviewOutcome({ pausedAt: 4 }).label, 'Paused');
});
test('a Beginner-graded signal says so, and its tone stays on the raw signal', () => {
  assert.deepEqual(interviewOutcome({ debriefed: true, hireSignal: 'Hire', reportDifficulty: 'beginner' }), { label: 'Hire (Beginner)', tone: 'success' });
  assert.deepEqual(interviewOutcome({ debriefed: true, hireSignal: 'No hire', reportDifficulty: 'beginner' }), { label: 'No hire (Beginner)', tone: 'danger' });
  assert.deepEqual(interviewOutcome({ debriefed: true, hireSignal: 'Hire', reportDifficulty: 'amazon-sde-2' }), { label: 'Hire', tone: 'success' });
  assert.deepEqual(interviewOutcome({ debriefed: true, hireSignal: 'Hire' }), { label: 'Hire', tone: 'success' });
  assert.deepEqual(interviewOutcome({ debriefed: true, reportDifficulty: 'beginner' }), { label: 'Completed', tone: 'neutral' });
  assert.equal(signalLabel(null, 'beginner'), null);
});
test('report difficulty names are known values only', () => {
  assert.equal(reportDifficultyLabel('beginner'), 'Beginner');
  assert.equal(reportDifficultyLabel('amazon-sde-2'), 'Amazon SDE II');
  assert.equal(reportDifficultyLabel(undefined), '');
  assert.equal(reportDifficultyLabel('nonsense'), '');
});
test('scorecards preserve unknown and unstructured feedback', () => {
  assert.deepEqual(debriefSections('Intro\n## Coding\nMixed — No evidence recorded.\n## Custom\nKeep this.'), [
    { heading: '', text: 'Intro' }, { heading: 'Coding', text: 'Mixed — No evidence recorded.' }, { heading: 'Custom', text: 'Keep this.' },
  ]);
  assert.deepEqual(recordedPhaseTimes({}), []);
  assert.deepEqual(recordedPhaseTimes({ startedAt: 1000, endedAt: 61000, phase: 'code', phaseSinceMs: 20000, phaseMs: { clarify: 20000, code: 0 } }), [{ phase: 'clarify', ms: 20000 }, { phase: 'code', ms: 40000 }]);
});
