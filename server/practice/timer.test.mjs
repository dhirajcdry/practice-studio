import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedPracticeTime, setTimerRunning } from './timer.mjs';

test('elapsedPracticeTime reports only active time and tolerates legacy records', () => {
  assert.equal(elapsedPracticeTime(undefined, 10_000), 0);
  assert.equal(elapsedPracticeTime(null, 10_000), 0);
  assert.equal(elapsedPracticeTime({ elapsedMs: 0, runningSince: null }, 10_000), 0);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: null }, 10_000), 1_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: 8_000 }, 10_000), 3_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: 12_000 }, 10_000), 1_500);
});

test('setTimerRunning pauses and resumes without losing elapsed time', () => {
  const started = setTimerRunning({ elapsedMs: 0, runningSince: 1_000 }, false, 3_500);
  assert.deepEqual(started, { elapsedMs: 2_500, runningSince: null });
  const repeatedPause = setTimerRunning(started, false, 9_000);
  assert.deepEqual(repeatedPause, started, 'pause is idempotent');
  const resumed = setTimerRunning(started, true, 10_000);
  assert.deepEqual(resumed, { elapsedMs: 2_500, runningSince: 10_000 });
  assert.deepEqual(setTimerRunning(resumed, true, 11_000), resumed, 'resume is idempotent');
  const pausedAgain = setTimerRunning(resumed, false, 46_000);
  assert.deepEqual(pausedAgain, { elapsedMs: 38_500, runningSince: null });
  assert.equal(elapsedPracticeTime(pausedAgain, 3_600_000), 38_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 3_600_000, runningSince: 3_600_000 }, 7_200_001), 7_200_001);
});

test('setTimerRunning normalizes malformed and legacy timer values', () => {
  assert.deepEqual(setTimerRunning({}, true, 123), { elapsedMs: 0, runningSince: 123 });
  assert.deepEqual(setTimerRunning({ elapsedMs: -10, runningSince: -1 }, false, 100), { elapsedMs: 0, runningSince: null });
  assert.deepEqual(setTimerRunning({ elapsedMs: '4', runningSince: '8' }, false, 100), { elapsedMs: 4, runningSince: null });
});
