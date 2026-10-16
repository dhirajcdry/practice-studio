import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStreak, recentDays } from '../web/js/streak.js';

const NOW = new Date(2026, 9, 15, 22, 0);   // 15 Oct 2026, 10pm local
const day = (date, events = 1) => ({ date, events, attempts: 0 });

test('counts consecutive days ending today', () => {
  const s = computeStreak([day('2026-10-13'), day('2026-10-14'), day('2026-10-15')], NOW);
  assert.equal(s.current, 3);
  assert.equal(s.activeToday, true);
});

test('a streak survives today having no practice yet', () => {
  const s = computeStreak([day('2026-10-13'), day('2026-10-14')], NOW);
  assert.equal(s.current, 2);
  assert.equal(s.activeToday, false);
});

test('a whole missed day breaks it', () => {
  assert.equal(computeStreak([day('2026-10-12'), day('2026-10-13')], NOW).current, 0);
});

test('days with no runs or events do not count', () => {
  assert.equal(computeStreak([day('2026-10-14'), day('2026-10-15', 0)], NOW).current, 1);
});

test('a UTC-stamped date after today counts as today', () => {
  const s = computeStreak([day('2026-10-14'), { date: '2026-10-16', events: 0, attempts: 3 }], NOW);
  assert.equal(s.current, 2);
  assert.equal(s.activeToday, true);
});

test('best is the longest run, across month boundaries', () => {
  const s = computeStreak([
    day('2026-09-29'), day('2026-09-30'), day('2026-10-01'), day('2026-10-02'),
    day('2026-10-14'), day('2026-10-15'),
  ], NOW);
  assert.equal(s.best, 4);
  assert.equal(s.current, 2);
});

test('recentDays lists the last n days oldest first', () => {
  const days = recentDays(computeStreak([day('2026-10-15')], NOW), 3);
  assert.deepEqual(days, [
    { day: '2026-10-13', active: false },
    { day: '2026-10-14', active: false },
    { day: '2026-10-15', active: true },
  ]);
});

test('junk input is an empty streak, not a throw', () => {
  assert.deepEqual(
    { ...computeStreak(null, NOW), days: null },
    { current: 0, best: 0, activeToday: false, days: null, today: '2026-10-15' },
  );
});
