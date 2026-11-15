// Attended time for every mock (server/mock-clock.mjs): heartbeats, gaps, sleep, server
// restart, records from before heartbeats, pause/resume and extend interplay, phase times.
// Scratch workspaces and fake CLIs only; no model is ever run.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { silentGaps, withoutGaps, attendedRecords, AWAY_AFTER_MS, LEGACY_GAP_MS, awayText } from './mock-clock.mjs';
import { newState, elapsed, touch, pause, resume, advance, settleClock, interviewClock, phaseTimes } from './interview/state.mjs';
import { reportFacts } from './interview/report.mjs';
import { InterviewService, interviewRoutes } from './interview/routes.mjs';
import { designClock, designElapsed, settleDesignClock, pauseDesign, resumeDesign, touchDesign } from './design/clock.mjs';
import { buildDesignReport } from './design/report.mjs';
import { routes as designRoutes, DesignService } from './design/routes.mjs';

const MIN = 60_000, DAY = 24 * 60 * MIN;
const T0 = Date.parse('2026-10-03T09:00:00Z');

test('silent gaps are measured on the active axis, from the last recorded activity', () => {
  assert.deepEqual(silentGaps([0, 5 * MIN, 10 * MIN], 20 * MIN), []);
  assert.deepEqual(silentGaps([0, 5 * MIN], 5 * MIN + LEGACY_GAP_MS + 1), [{ fromMs: 5 * MIN, toMs: 5 * MIN + LEGACY_GAP_MS + 1 }]);
  const gaps = silentGaps([0, 10 * MIN, 50 * MIN], 55 * MIN);
  assert.deepEqual(gaps, [{ fromMs: 10 * MIN, toMs: 50 * MIN }]);
  assert.equal(withoutGaps(52 * MIN, gaps), 12 * MIN);
  assert.equal(withoutGaps(8 * MIN, gaps), 8 * MIN);
  assert.equal(withoutGaps(30 * MIN, gaps), 10 * MIN);
  // Records written after a correction are already on the corrected clock.
  const mapped = attendedRecords([{ elapsedMs: 52 * MIN }, { kind: 'clock_correction', gaps }, { elapsedMs: 13 * MIN }], gaps, 1);
  assert.deepEqual(mapped.map(r => r.attendedMs), [12 * MIN, undefined, 13 * MIN]);
  assert.equal(awayText(42 * DAY), '42 days');
  assert.equal(awayText(3 * 60 * MIN + 12 * MIN), '3 h 12 min');
});

test('coding: heartbeats keep the clock running; silence stops it at the last one', () => {
  const state = { ...newState({ slug: 'two-sum', startedAt: T0 }), lastSeenAt: T0 };
  for (let at = T0 + 30_000; at <= T0 + 10 * MIN; at += 30_000) assert.ok(touch(state, at));
  assert.equal(elapsed(state, T0 + 10 * MIN), 10 * MIN);
  // A short absence (under the grace period) still counts.
  assert.equal(elapsed(state, T0 + 10 * MIN + 80_000), 10 * MIN + 80_000);
  // Past the grace period, it stopped at the last heartbeat, however long ago that was.
  assert.equal(elapsed(state, T0 + 10 * MIN + AWAY_AFTER_MS + 1), 10 * MIN);
  assert.equal(elapsed(state, T0 + 42 * DAY), 10 * MIN);
  assert.equal(interviewClock(state, null, T0 + 42 * DAY).running, false);
  assert.equal(interviewClock(state, null, T0 + 42 * DAY).pauseReason, 'away');
  // A heartbeat never restarts a stopped clock.
  assert.equal(touch(state, T0 + 42 * DAY), false);
  assert.equal(state.lastSeenAt, T0 + 10 * MIN);
});

test('coding: laptop sleep and a server restart read the same as any other silence', () => {
  const saved = JSON.stringify({ ...newState({ slug: 'two-sum', startedAt: T0 }), lastSeenAt: T0 + 20 * MIN });
  // The process that wrote it is gone; a new one reads the file after the lid opens.
  const state = JSON.parse(saved), wake = T0 + 20 * MIN + 9 * 60 * MIN;
  const entry = settleClock(state, [], wake);
  assert.equal(entry.kind, 'pause'); assert.equal(entry.reason, 'away'); assert.equal(entry.basis, 'heartbeat');
  assert.equal(state.pausedAt, T0 + 20 * MIN);
  assert.equal(elapsed(state, wake), 20 * MIN);
  // Resume carries on from the attended time, and the clock counts again.
  resume(state, wake);
  assert.equal(elapsed(state, wake + MIN), 21 * MIN);
  assert.equal(state.lastSeenAt, wake);
  assert.equal(settleClock(state, [], wake + MIN), null);
});

test('coding: explicit pause, extend and phase times all use attended time', () => {
  const state = { ...newState({ slug: 'two-sum', startedAt: T0 }), lastSeenAt: T0 };
  const beat = (from, to) => { for (let at = from; at <= to; at += 30_000) assert.ok(touch(state, at)); };
  beat(T0 + 30_000, T0 + 5 * MIN); advance(state, 'code', T0 + 5 * MIN);
  beat(T0 + 5 * MIN + 30_000, T0 + 9 * MIN);
  // Leaves for an hour without pausing: Pause afterwards stops it at the last heartbeat.
  pause(state, T0 + 69 * MIN);
  assert.equal(state.pausedAt, T0 + 9 * MIN); assert.equal(state.pauseReason, 'away');
  assert.deepEqual(phaseTimes(state, T0 + 69 * MIN), { clarify: 5 * MIN, approach: 0, code: 4 * MIN, test: 0, followup: 0 });
  // Adding time changes the budget, never the elapsed count.
  state.minutes += 15;
  assert.equal(elapsed(state, T0 + 70 * MIN), 9 * MIN);
  resume(state, T0 + 70 * MIN); beat(T0 + 70 * MIN + 30_000, T0 + 71 * MIN);
  assert.equal(elapsed(state, T0 + 71 * MIN), 10 * MIN);
  assert.equal(phaseTimes(state, T0 + 71 * MIN).code, 5 * MIN);
  // An explicit pause while attended is exact.
  pause(state, T0 + 71 * MIN + 10_000);
  assert.equal(state.pauseReason, 'pause');
  assert.equal(elapsed(state, T0 + 3 * DAY), 10 * MIN + 10_000);
});

test('coding: a record from before heartbeats is corrected once, from its own stamps, and says so', () => {
  // Started Oct 3, last activity 20 minutes in, then abandoned without a pause for 42 days.
  const state = newState({ slug: 'two-sum', startedAt: T0 });
  state.lastSpeechAt = state.lastTypingAt = T0 + 18 * MIN;
  advance(state, 'code', T0 + 6 * MIN);
  state.hints.push({ level: 'nudge', elapsedMs: 15 * MIN, phase: 'code' });
  const turns = [
    { kind: 'opening', elapsedMs: 0, phase: 'clarify' },
    { kind: 'candidate', elapsedMs: 4 * MIN, phase: 'clarify', said: 'A map.' },
    { kind: 'turn', elapsedMs: 6 * MIN, phase: 'code', asked: 'Go ahead.' },
    { kind: 'event', elapsedMs: 20 * MIN, phase: 'code', event: { type: 'run_result', failed: 0 } },
  ];
  const now = T0 + 42 * DAY;
  const before = interviewClock(state, turns, now);
  assert.equal(before.running, false); assert.equal(before.pauseReason, 'away');
  assert.equal(before.elapsedMs, 20 * MIN);
  assert.equal(before.awayMs, 42 * DAY - 20 * MIN);
  const entry = settleClock(state, turns, now);
  assert.equal(entry.kind, 'clock_correction'); assert.equal(entry.basis, 'recorded activity');
  assert.equal(entry.thresholdMs, LEGACY_GAP_MS); assert.equal(entry.inferredPause, true);
  assert.equal(entry.attendedMs, 20 * MIN);
  assert.equal(elapsed(state, now), 20 * MIN);
  assert.equal(state.pausedAt, now); assert.equal(state.pauseReason, 'away');
  assert.equal(phaseTimes(state, now).code, 14 * MIN);
  assert.equal(state.hints[0].elapsedMs, 15 * MIN);
  // Tracked from now on: settling again changes nothing, and a later Resume continues at 20:00.
  assert.equal(settleClock(state, [...turns, entry], now + 1), null);
  resume(state, now + MIN);
  assert.equal(elapsed(state, now + 2 * MIN), 21 * MIN);
});

test('coding: a gap inside an older record is taken out of the clock and later stamps; a live tail keeps running', () => {
  const state = newState({ slug: 'two-sum', startedAt: T0 });
  const turns = [{ kind: 'opening', elapsedMs: 0, phase: 'clarify' }, { kind: 'candidate', elapsedMs: 10 * MIN, phase: 'clarify' }, { kind: 'candidate', elapsedMs: 3 * 60 * MIN, phase: 'clarify' }];
  const now = T0 + 3 * 60 * MIN + 2 * MIN;
  const entry = settleClock(state, turns, now);
  assert.equal(entry.inferredPause, false);
  assert.equal(state.pausedAt, null);
  assert.equal(elapsed(state, now), 12 * MIN);
  assert.equal(withoutGaps(turns[2].elapsedMs, entry.gaps), 10 * MIN);
});

test('coding: finished records are derived at read time, never edited; tracked ones are left alone', () => {
  const finished = { ...newState({ slug: 'two-sum', startedAt: T0 }), endedAt: T0 + 3 * DAY, debriefed: true };
  const turns = [{ kind: 'opening', elapsedMs: 0, phase: 'clarify' }, { kind: 'candidate', elapsedMs: 25 * MIN, phase: 'clarify', said: 'Done.' }, { kind: 'debrief', elapsedMs: 3 * DAY, asked: '{}' }];
  const copy = structuredClone({ finished, turns });
  const facts = reportFacts(finished, turns, T0 + 4 * DAY);
  assert.equal(facts.durationMs, 25 * MIN);
  assert.equal(facts.away.basis, 'recorded activity');
  assert.equal(facts.away.ms, 3 * DAY - 25 * MIN);
  assert.equal(settleClock(finished, turns, T0 + 4 * DAY), null);
  assert.deepEqual({ finished, turns }, copy);
  const tracked = { ...finished, lastSeenAt: T0 + 3 * DAY };
  assert.equal(reportFacts(tracked, turns, T0 + 4 * DAY).durationMs, 3 * DAY);
  assert.equal(reportFacts(tracked, turns, T0 + 4 * DAY).away, undefined);
});

test('design: the owner case: weeks without a pause come back paused at the last recorded activity', () => {
  const state = { prompt: 'Design a feed.', level: 'L4', minutes: 45, phase: 'api', startedAt: T0, debriefed: false };
  const turns = [
    { at: new Date(T0).toISOString(), kind: 'opening', elapsedMs: 0 },
    { at: new Date(T0 + 12 * MIN).toISOString(), kind: 'candidate', elapsedMs: 12 * MIN, phase: 'requirements' },
    { at: new Date(T0 + 13 * MIN).toISOString(), kind: 'turn', elapsedMs: 13 * MIN, phase: 'api' },
  ];
  // Drawing after the last turn is activity too.
  const scenes = [{ at: new Date(T0 + 19 * MIN).toISOString(), elements: [] }];
  const now = T0 + 42 * DAY;
  assert.equal(designClock(state, turns, scenes, now).elapsedMs, 19 * MIN);
  const entry = settleDesignClock(state, turns, scenes, now);
  assert.equal(entry.kind, 'clock_correction'); assert.equal(entry.inferredPause, true);
  assert.equal(state.spentMs, 19 * MIN); assert.equal(state.pauseReason, 'away');
  assert.equal(designClock(state, null, [], now + DAY).elapsedMs, 19 * MIN);
  // The variant already on disk: a bad resume shifted nothing and a navigation pause saved 42 days.
  const inflated = { ...structuredClone(state), lastSeenAt: undefined, pausedAt: now, spentMs: 42 * DAY, pauseReason: undefined };
  delete inflated.lastSeenAt;
  settleDesignClock(inflated, turns, scenes, now + MIN);
  assert.equal(inflated.spentMs, 19 * MIN); assert.equal(inflated.pauseReason, 'away');
  // Resume continues at 19:00 and heartbeats keep it going.
  resumeDesign(state, now + 2 * MIN);
  assert.ok(touchDesign(state, now + 2 * MIN + 30_000));
  assert.equal(designElapsed(state, now + 3 * MIN), 20 * MIN);
});

test('design: tracked interviews stop at the last heartbeat; pause after an absence is exact', () => {
  const state = { minutes: 45, startedAt: T0, lastSeenAt: T0, debriefed: false };
  for (let at = T0 + 30_000; at <= T0 + 10 * MIN; at += 30_000) assert.ok(touchDesign(state, at));
  assert.equal(designElapsed(state, T0 + 10 * MIN + AWAY_AFTER_MS - 1), 10 * MIN + AWAY_AFTER_MS - 1);
  assert.equal(designElapsed(state, T0 + 5 * 60 * MIN), 10 * MIN);
  assert.equal(touchDesign(state, T0 + 5 * 60 * MIN), false);
  pauseDesign(state, T0 + 5 * 60 * MIN);
  assert.equal(state.spentMs, 10 * MIN); assert.equal(state.pauseReason, 'away');
  state.minutes += 20;   // extending changes the budget only
  assert.equal(designClock(state, null, [], T0 + 6 * 60 * MIN).elapsedMs, 10 * MIN);
});

test('design: a finished older record reports attended time and says what was left out', () => {
  const state = { minutes: 45, startedAt: T0, endedAt: T0 + 2 * DAY, debriefed: true, turns: [] };
  const turns = [
    { kind: 'opening', elapsedMs: 0 },
    { kind: 'candidate', elapsedMs: 10 * MIN, phase: 'requirements', said: 'Reads dominate.' },
    { kind: 'turn', elapsedMs: 11 * MIN, phase: 'api', asked: 'And writes?' },
    { kind: 'candidate', elapsedMs: 2 * DAY - 5 * MIN, phase: 'api', said: 'A queue.' },
    { kind: 'debrief', elapsedMs: 2 * DAY, asked: 'Report.' },
  ];
  const report = buildDesignReport(state, turns);
  assert.equal(report.facts.durationMs, 16 * MIN);
  assert.equal(report.facts.away.ms, 2 * DAY - 16 * MIN);
  // Phase times come from the same attended stamps: nothing is placed inside the gap.
  assert.equal(report.facts.phases.find(p => p.phase === 'requirements').ms, 11 * MIN);
  assert.equal(report.facts.phases.find(p => p.phase === 'api').ms, null);
});

async function codingFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-clock-coding-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'two-sum.json'), JSON.stringify({ question: { title: 'Two Sum', content: '<p>Find two numbers.</p>' } }));
  const interview = new InterviewService({ root, binary: new URL('./interview/test/fake-interviewer.mjs', import.meta.url).pathname });
  async function call(route, body = {}, params = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    let output = '', status = 200;
    const res = { writeHead(code) { status = code; }, write(chunk) { output += chunk; }, end(chunk = '') { output += chunk; }, flushHeaders() {} };
    const [method, url] = route.split(' ');
    try { await interviewRoutes[`${method} ${url}`](req, res, { interview, params }); }
    catch (error) { return { status: error.status, error }; }
    return { status, output, events: [...output.matchAll(/event: (.+)\ndata: (.+)\n/g)].map(m => ({ name: m[1], data: JSON.parse(m[2]) })) };
  }
  return { root, interview, call };
}

test('coding routes: heartbeat renews, a lapse becomes one labelled away pause, polls report it, turns wait for Resume', async t => {
  const { interview, call } = await codingFixture(t);
  const opening = await call('POST /api/interview/start', { slug: 'two-sum', mode: 'typed', minutes: 45, code: 'pass' });
  const id = opening.events.find(e => e.name === 'interview').data.id, body = { slug: 'two-sum', interviewId: id };
  assert.ok(opening.events.find(e => e.name === 'interview').data.clock.running);
  const beat = JSON.parse((await call('POST /api/interview/heartbeat', body)).output);
  assert.equal(beat.state.clock.running, true);
  // Nobody there for ten minutes (the record is moved back, as a restarted server would find it).
  await interview.store.patchState('two-sum', id, s => { for (const key of ['startedAt', 'lastSeenAt', 'lastSpeechAt', 'lastTypingAt']) s[key] -= 10 * MIN; });
  const before = await interview.store.readTurns('two-sum', id);
  const poll = JSON.parse((await call('POST /api/interview/event', { ...body, event: { type: 'idle', secondsSinceSpeech: 1, secondsSinceTyping: 1 } })).output);
  assert.equal(poll.interjected, false);
  assert.equal(poll.state.status, 'paused'); assert.equal(poll.state.pauseReason, 'away');
  assert.ok(poll.state.clock.elapsedMs < 5000, `stopped at the last heartbeat, got ${poll.state.clock.elapsedMs}`);
  const after = await interview.store.readTurns('two-sum', id);
  assert.deepEqual(after.slice(0, before.length), before, 'existing lines are never rewritten');
  assert.deepEqual(after.slice(before.length).map(t => [t.kind, t.reason, t.basis]), [['pause', 'away', 'heartbeat']]);
  // A heartbeat cannot restart it; a turn waits for an explicit Resume.
  assert.equal(JSON.parse((await call('POST /api/interview/heartbeat', body)).output).state.clock.running, false);
  assert.equal((await call('POST /api/interview/turn', { ...body, said: 'Back.', requestId: 'back-1' })).status, 409);
  const resumed = JSON.parse((await call('POST /api/interview/resume', body)).output);
  assert.equal(resumed.state.clock.running, true);
  assert.ok(resumed.state.clock.elapsedMs < 5000);
});

test('coding routes: opening an older abandoned record settles it once, with the record left intact', async t => {
  const { interview, call } = await codingFixture(t);
  const id = '1759482000000-abcdef12', now = Date.now();
  const state = { ...newState({ slug: 'two-sum', startedAt: now - 42 * DAY }), statement: 'Two Sum' };
  state.lastSpeechAt = state.lastTypingAt = now - 42 * DAY + 18 * MIN;
  await interview.store.create('two-sum', id, state);
  const lines = [{ at: new Date(now - 42 * DAY).toISOString(), kind: 'opening', elapsedMs: 0, phase: 'clarify', asked: 'Go.' },
    { at: new Date(now - 42 * DAY + 20 * MIN).toISOString(), kind: 'candidate', elapsedMs: 20 * MIN, phase: 'clarify', said: 'A map.' }];
  for (const line of lines) await interview.store.append('two-sum', id, line);
  const detail = JSON.parse((await call('GET /api/interview/:slug/:id', {}, { slug: 'two-sum', id })).output);
  assert.equal(detail.status, 'paused'); assert.equal(detail.clock.pauseReason, 'away');
  assert.equal(detail.clock.elapsedMs, 20 * MIN);
  assert.equal(detail.clock.awayBasis, 'recorded activity');
  const raw = await interview.store.readTurns('two-sum', id);
  assert.deepEqual(raw.slice(0, 2), lines);
  assert.equal(raw[2].kind, 'clock_correction'); assert.equal(raw[2].thresholdMs, LEGACY_GAP_MS);
  // Opening it again appends nothing more.
  await call('GET /api/interview/:slug/:id', {}, { slug: 'two-sum', id });
  assert.equal((await interview.store.readTurns('two-sum', id)).length, 3);
});

test('design routes: an abandoned interview opens paused at its last activity; heartbeat never restarts it', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-clock-design-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const svc = new DesignService({ root, binary: '/nonexistent/never-run', log: { warn() {} } });
  async function call(route, body = {}, params = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    let output = '', status = 200;
    const res = { writeHead(code) { status = code; return res; }, write(chunk) { output += chunk; return true; }, end(chunk = '') { output += chunk; }, setHeader() {}, flushHeaders() {} };
    try { await designRoutes[route](req, res, { design: svc, params }); } catch (error) { return { status: error.status, error }; }
    return { status, body: output ? JSON.parse(output) : null };
  }
  const id = '2026-10-03T09-00-00-000Z', now = Date.now(), start = now - 42 * DAY;
  await svc.store.create(id, { prompt: 'Design a feed.', level: 'L4', minutes: 45, phase: 'api', startedAt: start, debriefed: false, claudeSessionId: 'kept' });
  const lines = [{ at: new Date(start).toISOString(), kind: 'opening', elapsedMs: 0, asked: 'Design a feed.' },
    { at: new Date(start + 15 * MIN).toISOString(), kind: 'turn', elapsedMs: 15 * MIN, said: 'Fan out on write.', asked: 'Why?', phase: 'api' }];
  for (const line of lines) await svc.store.appendTurn(id, line);
  const detail = (await call('GET /api/design/:id', {}, { id })).body;
  assert.equal(detail.clock.running, false); assert.equal(detail.clock.pauseReason, 'away');
  assert.equal(detail.clock.elapsedMs, 15 * MIN);
  assert.equal(detail.resumable, true);
  const raw = await svc.store.readTurns(id);
  assert.deepEqual(raw.slice(0, 2), lines);
  assert.equal(raw[2].kind, 'clock_correction');
  const beat = (await call('POST /api/design/heartbeat', { interviewId: id })).body;
  assert.equal(beat.clock.running, false);
  assert.equal((await call('POST /api/design/turn', { interviewId: id, said: 'Hi' })).status, 409);
  const resumed = (await call('POST /api/design/resume', { interviewId: id })).body;
  assert.equal(resumed.clock.running, true); assert.ok(Math.abs(resumed.clock.elapsedMs - 15 * MIN) < 2000);
  assert.equal((await svc.store.readTurns(id)).at(-1).kind, 'resume');
  // Attended now: a heartbeat renews it, and a pause records exactly when.
  assert.equal((await call('POST /api/design/heartbeat', { interviewId: id })).body.clock.running, true);
  const paused = (await call('POST /api/design/pause', { interviewId: id })).body;
  assert.equal(paused.clock.running, false); assert.equal(paused.clock.pauseReason, 'pause');
});
