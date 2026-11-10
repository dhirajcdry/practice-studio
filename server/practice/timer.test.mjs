import test from 'node:test';
import assert from 'node:assert/strict';
import { elapsedPracticeTime, setTimerRunning, TIMER_LEASE_MS, MAX_TIMER_RUN_MS, expireTimer, renewTimer } from './timer.mjs';

test('elapsedPracticeTime reports only active time and tolerates legacy records', () => {
  assert.equal(elapsedPracticeTime(undefined, 10_000), 0);
  assert.equal(elapsedPracticeTime(null, 10_000), 0);
  assert.equal(elapsedPracticeTime({ elapsedMs: 0, runningSince: null }, 10_000), 0);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: null }, 10_000), 1_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: 8_000 }, 10_000), 3_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 1_500, runningSince: 12_000 }, 10_000), 1_500);
});

test('setTimerRunning pauses and resumes without losing elapsed time', () => {
  const started = setTimerRunning({ elapsedMs: 0, runningSince: 1_000, leaseUntil: 50_000 }, false, 3_500);
  assert.deepEqual(started, { elapsedMs: 2_500, runningSince: null, leaseUntil: null });
  const repeatedPause = setTimerRunning(started, false, 9_000);
  assert.deepEqual(repeatedPause, started, 'pause is idempotent');
  const resumed = setTimerRunning(started, true, 10_000);
  assert.deepEqual(resumed, { elapsedMs: 2_500, runningSince: 10_000, leaseUntil: 10_000 + TIMER_LEASE_MS });
  assert.deepEqual(setTimerRunning(resumed, true, 11_000), resumed, 'resume is idempotent');
  const pausedAgain = setTimerRunning(resumed, false, 46_000);
  assert.deepEqual(pausedAgain, { elapsedMs: 32_500, runningSince: null, leaseUntil: null });
  assert.equal(elapsedPracticeTime(pausedAgain, 3_600_000), 32_500);
  assert.equal(elapsedPracticeTime({ elapsedMs: 3_600_000, runningSince: 3_600_000 }, 7_200_001), 7_200_001);
});

test('setTimerRunning normalizes malformed and legacy timer values', () => {
  assert.deepEqual(setTimerRunning({}, true, 123), { elapsedMs: 0, runningSince: 123, leaseUntil: 123 + TIMER_LEASE_MS });
  assert.deepEqual(setTimerRunning({ elapsedMs: -10, runningSince: -1 }, false, 100), { elapsedMs: 0, runningSince: null, leaseUntil: null });
  assert.deepEqual(setTimerRunning({ elapsedMs: '4', runningSince: '8' }, false, 100), { elapsedMs: 4, runningSince: null, leaseUntil: null });
});

test('expired leases freeze at the lease boundary', () => {
  const timer = { elapsedMs: 400, runningSince: 1_000, leaseUntil: 2_000 };
  assert.deepEqual(expireTimer(timer, 9_000), { elapsedMs: 1_400, runningSince: null, leaseUntil: null });
});

test('heartbeats renew only a live run and never restart a stopped or expired clock', () => {
  const active = setTimerRunning({ elapsedMs: 5, runningSince: null }, true, 1_000);
  const renewed = renewTimer(active, 1_000, 10_000);
  assert.equal(renewed.leaseUntil, 40_000);
  assert.equal(renewed.runningSince, 1_000);
  const paused = setTimerRunning(renewed, false, 12_000);
  assert.deepEqual(renewTimer(paused, 1_000, 14_000), paused);
  assert.equal(renewTimer(active, 1_000, 40_000).runningSince, null);
  assert.deepEqual(renewTimer(active, 999, 2_000), active, 'another run cannot renew this lease');
  const resumed = setTimerRunning(active, true, 90_000);
  assert.equal(resumed.elapsedMs, 30_005, 'resuming an expired lease preserves its elapsed time');
  assert.equal(resumed.runningSince, 90_000);
});

test('an open tab cannot renew a continuous run beyond 12 hours', () => {
  const start = 1_000, savedElapsed = 50_000;
  let timer = setTimerRunning({ elapsedMs: savedElapsed }, true, start);
  for (let now = start + 10_000; now < start + MAX_TIMER_RUN_MS; now += 10_000) {
    timer = renewTimer(timer, start, now);
    assert.equal(timer.runningSince, start);
    assert.ok(timer.leaseUntil <= start + MAX_TIMER_RUN_MS);
  }
  assert.equal(timer.leaseUntil, start + MAX_TIMER_RUN_MS, 'the final lease ends exactly at the cutoff');
  const paused = renewTimer(timer, start, start + MAX_TIMER_RUN_MS);
  assert.deepEqual(paused, { elapsedMs: savedElapsed + MAX_TIMER_RUN_MS, runningSince: null, leaseUntil: null });
  assert.deepEqual(renewTimer(paused, start, start + MAX_TIMER_RUN_MS * 2), paused, 'late heartbeats stay stopped');
  const resumed = setTimerRunning(paused, true, start + MAX_TIMER_RUN_MS * 2);
  assert.equal(resumed.elapsedMs, paused.elapsedMs, 'an explicit resume preserves prior practice time');
  assert.equal(resumed.runningSince, start + MAX_TIMER_RUN_MS * 2);
  assert.equal(resumed.leaseUntil, resumed.runningSince + TIMER_LEASE_MS);
});

test('old running timers are bounded, while already paused totals are preserved', () => {
  const start = 1_000, now = start + 32 * 60 * 60 * 1000;
  for (const leaseUntil of [null, now + TIMER_LEASE_MS]) {
    const timer = { elapsedMs: 500, runningSince: start, leaseUntil };
    assert.equal(elapsedPracticeTime(timer, now), 500 + MAX_TIMER_RUN_MS);
    assert.deepEqual(expireTimer(timer, now), { elapsedMs: 500 + MAX_TIMER_RUN_MS, runningSince: null, leaseUntil: null });
  }
  const paused = { elapsedMs: 32 * 60 * 60 * 1000, runningSince: null, leaseUntil: null };
  assert.deepEqual(expireTimer(paused, now), paused, 'the limit applies to each uninterrupted run, not lifetime totals');
});
