import test from 'node:test';
import assert from 'node:assert/strict';
import { ago, briefTitle, buildSessions, continueItem, dimensionTrend, filterProblems, filterSessions, headerSummary, lastLine, modeOrDefault, practiceMinutes, practiceSettings, problemTone, statusLine, OWN, SURPRISE, TONE_LABELS } from '../../web/js/track-home-model.js';

const NOW = new Date(2026, 10, 13, 15, 0).getTime();
const daysAgo = n => NOW - n * 86400000;
const problems = [
  { slug: 'lld-a', title: 'Problem A' },
  { slug: 'lld-b', title: 'Problem B' },
  { slug: 'lld-c', title: 'Problem C' },
];
const report = (id, slug, days, signal, ratings = {}) => ({ id, slug, title: slug, date: new Date(daysAgo(days)).toISOString(), structured: true, signal,
  headline: `Headline ${id}`, moveUp: null, dimensions: Object.entries(ratings).map(([name, rating]) => ({ name, rating, summary: `${name} in ${id}` })) });

test('relative days are worded from the calendar, not from 24-hour blocks', () => {
  assert.equal(ago(NOW - 3600000, NOW), 'today');
  assert.equal(ago(new Date(2026, 10, 12, 23, 30).getTime(), NOW), 'yesterday');
  assert.equal(ago(daysAgo(3), NOW), '3 days ago');
  assert.equal(ago(0, NOW), '');
});

test('sessions merge newest first and carry their assessment', () => {
  const items = buildSessions({
    interviews: [{ id: 'm1', slug: 'lld-a', startedAt: daysAgo(3), debriefed: true }, { id: 'm2', slug: 'lld-a', startedAt: daysAgo(0), debriefed: false }],
    sessions: [{ id: 'p1', slug: 'lld-b', updatedAt: new Date(daysAgo(1)).toISOString(), title: 'Problem B' }],
    assessments: [report('m1', 'lld-a', 3, 'Lean no')],
    problems,
  });
  assert.deepEqual(items.map(i => i.key), ['mock:m2', 'practice:p1', 'mock:m1']);
  assert.equal(items[2].assessment.signal, 'Lean no');
  assert.equal(items[0].title, 'Problem A');
  assert.equal(continueItem(items).key, 'mock:m2');
  assert.equal(continueItem(items.filter(i => i.key !== 'mock:m2')).key, 'practice:p1');
  assert.equal(continueItem(items.filter(i => i.kind === 'mock' && i.finished)), null);
  assert.deepEqual(filterSessions(items, 'practice').map(i => i.key), ['practice:p1']);
  assert.equal(filterSessions(items, 'mocks').length, 2);
});

test('status lines come only from records', () => {
  const items = buildSessions({
    interviews: [{ id: 'm1', slug: 'lld-a', startedAt: daysAgo(3), debriefed: true }, { id: 'm0', slug: 'lld-a', startedAt: daysAgo(9), debriefed: true },
      { id: 'm3', slug: 'lld-c', startedAt: daysAgo(0), debriefed: false }],
    sessions: [{ id: 'p1', slug: 'lld-b', updatedAt: daysAgo(1) }],
    assessments: [report('m1', 'lld-a', 3, 'Hire')],
    problems,
  });
  assert.equal(statusLine('lld-a', items, NOW), 'Mocked 2 times · last: Hire · 3 days ago');
  assert.equal(statusLine('lld-b', items, NOW), 'Practised yesterday');
  assert.equal(statusLine('lld-c', items, NOW), 'Mock unfinished · started today');
  assert.equal(statusLine('lld-z', items, NOW), 'Not tried yet');
  // A finished mock with no structured report names no signal rather than inventing one.
  const prose = buildSessions({ interviews: [{ id: 'x', slug: 'lld-a', startedAt: daysAgo(2), debriefed: true }], problems });
  assert.equal(statusLine('lld-a', prose, NOW), 'Mocked 1 time · 2 days ago');
});

test('the stage opens on Practise unless this viewer last used Mock', () => {
  assert.equal(modeOrDefault(undefined), 'practise');
  assert.equal(modeOrDefault('mock'), 'mock');
  assert.equal(modeOrDefault('something-else'), 'practise');
});

test('each problem chip carries the status its records give it, never an invented one', () => {
  const items = buildSessions({
    interviews: [{ id: 'm1', slug: 'lld-a', startedAt: daysAgo(3), debriefed: true }, { id: 'm2', slug: 'lld-c', startedAt: daysAgo(1), debriefed: false },
      { id: 'm4', slug: 'lld-d', startedAt: daysAgo(2), debriefed: true }, { id: 'm5', slug: 'lld-e', startedAt: daysAgo(2), debriefed: true },
      { id: 'm6', slug: 'lld-f', startedAt: daysAgo(2), debriefed: true }],
    sessions: [{ id: 'p1', slug: 'lld-b', updatedAt: daysAgo(1) }, { id: 'p2', slug: 'lld-a', updatedAt: daysAgo(0) }],
    assessments: [report('m1', 'lld-a', 3, 'Hire'), report('m4', 'lld-d', 2, 'Lean no'), report('m5', 'lld-e', 2, 'No hire')],
    problems,
  });
  assert.equal(problemTone('lld-a', items), 'success', 'the newest finished mock decides, even after later practice');
  assert.equal(problemTone('lld-b', items), 'practised');
  assert.equal(problemTone('lld-c', items), 'unfinished');
  assert.equal(problemTone('lld-d', items), 'warn');
  assert.equal(problemTone('lld-e', items), 'danger');
  assert.equal(problemTone('lld-f', items), 'mocked', 'a mock without a structured report has no grade');
  assert.equal(problemTone('lld-z', items), 'new');
  assert.deepEqual(Object.keys(TONE_LABELS), ['new', 'practised', 'unfinished', 'success', 'warn', 'danger', 'mocked']);
});

test('the filter matches every typed word in a title', () => {
  const list = [{ slug: 'a', title: 'Parking garage' }, { slug: 'b', title: 'Parcel lockers' }, { slug: 'c', title: 'Rate limiter' }];
  assert.deepEqual(filterProblems(list, 'par').map(p => p.slug), ['a', 'b']);
  assert.deepEqual(filterProblems(list, 'PARK gar').map(p => p.slug), ['a']);
  assert.deepEqual(filterProblems(list, '  ').length, 3);
  assert.deepEqual(filterProblems(list, 'queue'), []);
});

test('the last practice and last mock lines come from the newest records, or say there are none', () => {
  assert.equal(lastLine('practise', [], NOW), 'No practice yet');
  assert.equal(lastLine('mock', [], NOW), 'No mock yet');
  const items = buildSessions({
    interviews: [{ id: 'm1', slug: 'lld-a', startedAt: daysAgo(3), debriefed: true }, { id: 'm0', slug: 'lld-b', startedAt: daysAgo(6), debriefed: true }],
    sessions: [{ id: 'p1', slug: 'lld-b', title: 'Problem B', updatedAt: daysAgo(5), timer: { elapsedMs: 41 * 60000, runningSince: null } }],
    assessments: [report('m1', 'lld-a', 3, 'Lean no')],
    problems,
  });
  assert.equal(lastLine('practise', items, NOW), 'Last practice: Problem B · 41 min · 5 days ago');
  assert.equal(lastLine('mock', items, NOW), 'Last mock: Problem A · Lean no · 3 days ago');
  const open = buildSessions({ interviews: [{ id: 'x', slug: 'lld-a', startedAt: daysAgo(0), debriefed: false }], problems });
  assert.equal(lastLine('mock', open, NOW), 'Last mock: Problem A · Unfinished · today');
  const prose = buildSessions({ interviews: [{ id: 'x', slug: 'lld-a', startedAt: daysAgo(1), debriefed: true }], problems });
  assert.equal(lastLine('mock', prose, NOW), 'Last mock: Problem A · No grade · yesterday');
  // A stopwatch that never ran, ran under a minute, or is running elsewhere names no time.
  assert.equal(practiceMinutes(undefined), '');
  assert.equal(practiceMinutes({ elapsedMs: 0, runningSince: null }), '');
  assert.equal(practiceMinutes({ elapsedMs: 59000, runningSince: null }), '');
  assert.equal(practiceMinutes({ elapsedMs: 600000, runningSince: 1 }), '');
  assert.equal(practiceMinutes({ elapsedMs: 65 * 60000, runningSince: null }), '1 h 5 min');
  assert.equal(practiceMinutes({ elapsedMs: 120 * 60000, runningSince: null }), '2 h');
});

test('practice offers only the settings it honours, and never a clock', () => {
  assert.deepEqual(practiceSettings('design', { chosen: true }), ['mode', 'level', 'model']);
  assert.deepEqual(practiceSettings('design', { choice: OWN }), ['mode', 'level', 'model']);
  // LLD practice coaching ignores the level; only preparing a surprise problem uses it.
  assert.deepEqual(practiceSettings('lld', { chosen: true }), ['mode', 'model']);
  assert.deepEqual(practiceSettings('lld', { choice: OWN }), ['mode', 'model']);
  assert.deepEqual(practiceSettings('lld', { choice: SURPRISE }), ['mode', 'level', 'model']);
});

test('a brief is named by its first line, cut at a word', () => {
  assert.equal(briefTitle('  Design a parking garage  \nWith two floors.'), 'Design a parking garage');
  const long = briefTitle('Design a booking system for a small chain of climbing gyms with members, day passes and route setting schedules');
  assert.ok(long.length <= 80 && long.endsWith('…') && !/\s…$/.test(long), long);
  assert.equal(briefTitle(''), '');
});

test('the header counts only what exists', () => {
  assert.equal(headerSummary(problems, [], NOW), '3 problems');
  assert.equal(headerSummary([], [], NOW), '');
  const items = buildSessions({
    interviews: [{ id: 'a', slug: 'lld-a', startedAt: daysAgo(2), debriefed: true }, { id: 'b', slug: 'lld-a', startedAt: daysAgo(1), debriefed: false }],
    sessions: [{ id: 'p', slug: 'lld-b', updatedAt: daysAgo(4) }], problems,
  });
  assert.equal(headerSummary(problems, items, NOW), '3 problems · 1 mock finished · 1 unfinished · 1 practice session · last session yesterday');
});

test('each skill shows its newest evidence-backed rating and the last five reports in order', () => {
  const rubric = ['Requirements', 'Interfaces', 'Testing'];
  const assessments = [
    report('r6', 'lld-a', 1, 'Hire', { Requirements: 'Strong', Interfaces: null }),
    report('r5', 'lld-a', 2, 'Lean hire', { Requirements: 'Solid', Interfaces: 'Mixed' }),
    report('r4', 'lld-b', 3, 'Lean no', { Requirements: 'Mixed' }),
    report('r3', 'lld-b', 4, 'Lean no', { Requirements: 'Weak' }),
    report('r2', 'lld-c', 5, 'No hire', { Requirements: 'Weak' }),
    report('r1', 'lld-c', 6, 'No hire', { Requirements: 'Weak', Interfaces: 'Weak' }),
    { id: 'prose', slug: 'lld-a', date: new Date(daysAgo(0)).toISOString(), structured: false, signal: null, dimensions: [] },
  ];
  const trend = dimensionTrend(rubric, assessments);
  assert.equal(trend.lead.id, 'r6', 'a report without structure never leads');
  assert.equal(trend.reports, 5);
  const [req, ifc, testing] = trend.rows;
  assert.deepEqual(req.marks.map(m => m.rating), ['Weak', 'Weak', 'Mixed', 'Solid', 'Strong']);
  assert.equal(req.latest.rating, 'Strong');
  // Interfaces: the newest report gave no evidence, so the latest is the one before it.
  assert.equal(ifc.latest.rating, 'Mixed');
  assert.deepEqual(ifc.marks.map(m => m.rating), [null, null, null, 'Mixed', null]);
  assert.equal(testing.latest, null);
  assert.ok(testing.marks.every(m => m.rating === null));
  assert.deepEqual(dimensionTrend(rubric, [assessments[6]]), { lead: null, reports: 0, rows: rubric.map(name => ({ name, latest: null, marks: [] })) });
});
