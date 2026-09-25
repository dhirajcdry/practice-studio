// The rules the prompt states and the server has to hold.
//
// Everything here is a rule that reads fine in a prompt and decays over 45 minutes
// because obeying it requires counting something the model cannot see. The test for
// each one is the same question: does the brief the model receives on turn 20 still
// contain the fact, or only the original request?

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_IDS, MAX_FOLLOWUPS, DEFAULT_MINUTES,
  systemPrompt, newInterview, recordTurn, enterPhase, buildTurn,
  talkShare, curveballDue, expectedPhase, debriefPrompt, openingPrompt,
  createTagStripper,
} from './interview.mjs';
import { sceneToGraph } from './graph.mjs';

const MIN = 60_000;
const T0 = Date.parse('2026-09-10T17:00:00.000Z');
const at = (mins) => T0 + mins * MIN;

const fresh = (over = {}) => newInterview({ startedAt: T0, ...over });

function graphOf(labels, edges = []) {
  const els = [];
  const ids = {};
  labels.forEach((label, i) => {
    const boxId = `b${i}`;
    ids[label] = boxId;
    els.push({ id: boxId, type: 'rectangle', x: i * 200, y: 0, width: 120, height: 60 });
    els.push({ id: `t${i}`, type: 'text', x: i * 200, y: 20, width: 100, height: 20, text: label, containerId: boxId });
  });
  edges.forEach(([from, to], i) => {
    els.push({
      id: `a${i}`, type: 'arrow', x: 0, y: 0, width: 10, height: 0, points: [[0, 0], [10, 0]],
      startBinding: { elementId: ids[from] }, endBinding: { elementId: ids[to] },
    });
  });
  return sceneToGraph(els);
}

/* ---- the character ---- */

test('the system prompt carries the probe list, which is the tuned part', () => {
  const p = systemPrompt();
  for (const probe of ['hot partitions', 'Write amplification', 'idempotency', 'who reads from it']) {
    assert.ok(p.toLowerCase().includes(probe.toLowerCase()), `lost the "${probe}" probe`);
  }
  assert.match(p, /L4/);
  assert.match(p, /45-minute/);
});

test('the level and length are the caller\'s, not baked in', () => {
  const p = systemPrompt({ level: 'L6', minutes: 60 });
  assert.match(p, /L6/);
  assert.match(p, /60-minute/);
});

test('the opening asks for one line and nothing else', () => {
  const text = openingPrompt(fresh());
  assert.match(text, /one-line problem statement and nothing else/);
  assert.match(text, /One line, then stop/);
});

test('a problem already done is named so it is not picked again', () => {
  const text = openingPrompt(fresh(), { avoid: ['Design a URL shortener', 'Design Twitter'] });
  assert.match(text, /already been asked/);
  assert.match(text, /URL shortener/);
});

/* ---- follow-up budget: "max 2 follow-ups per gap" ---- */

test('the follow-up budget is counted and restated, not left to memory', () => {
  const s = fresh();
  recordTurn(s, { said: 'shard by user id', asked: 'what makes that key hot?', gap: 'hot-partition' });
  assert.match(buildTurn(s, { now: at(5) }).text, /1 follow-up left on this gap/);

  recordTurn(s, { said: 'hmm', asked: 'what about a celebrity?', gap: 'hot-partition' });
  assert.match(buildTurn(s, { now: at(6) }).text, /budget spent\. Note it silently and move on\./);
});

test('a new gap gets a fresh budget', () => {
  const s = fresh();
  recordTurn(s, { said: 'a', asked: 'q1', gap: 'hot-partition' });
  recordTurn(s, { said: 'b', asked: 'q2', gap: 'hot-partition' });
  recordTurn(s, { said: 'c', asked: 'q3', gap: 'cache-bounds' });
  const text = buildTurn(s, { now: at(9) }).text;
  assert.match(text, /probing "cache-bounds" — 1 follow-up left/);
  assert.equal(MAX_FOLLOWUPS, 2);
});

/* ---- talk ratio: "you talk ~20% of the time" ---- */

test('talking too much is measured and said out loud', () => {
  const s = fresh();
  // Three turns where the interviewer lectures and the candidate barely speaks.
  for (let i = 0; i < 3; i += 1) {
    recordTurn(s, { said: 'yes', asked: 'so '.repeat(60) });
  }
  assert.ok(talkShare(s) > 0.9);
  assert.match(buildTurn(s, { now: at(10) }).text, /you have spoken \d+% of the words\. Target is 20%/);
});

test('a quiet interviewer is not nagged', () => {
  const s = fresh();
  for (let i = 0; i < 3; i += 1) {
    recordTurn(s, { said: 'because '.repeat(80), asked: 'why?' });
  }
  assert.ok(talkShare(s) < 0.2);
  assert.doesNotMatch(buildTurn(s, { now: at(10) }).text, /Target is 20%/);
});

/* ---- phases: "nudge me if I skip a phase" ---- */

test('the phase is stated every turn', () => {
  const s = fresh();
  enterPhase(s, 'estimates');
  assert.match(buildTurn(s, { now: at(12) }).text, /\[phase: scale estimates\]/);
});

test('skipping straight to the design is noticed and named', () => {
  const s = fresh();
  enterPhase(s, 'design');
  const text = buildTurn(s, { now: at(15) }).text;
  assert.match(text, /never covered: core entities, API, scale estimates/);
  assert.match(text, /nudge, do not cover it for them/);
});

test('running behind the clock is a nudge, not a jump', () => {
  const s = fresh();               // still on requirements...
  const text = buildTurn(s, { now: at(30) }).text;   // ...30 minutes in
  // Two-thirds through 45 minutes is phase 5 of 7, not the last one.
  assert.match(text, /the clock is at "high-level design & data model"/);
  assert.match(text, /if they have finished here, move them on/);
  assert.equal(expectedPhase(s, at(30)), 'design');
  assert.equal(expectedPhase(s, at(43)), 'bottlenecks');
});

test('a phase that was actually visited is not reported as skipped', () => {
  const s = fresh();
  for (const p of PHASE_IDS.slice(0, 5)) enterPhase(s, p);
  assert.doesNotMatch(buildTurn(s, { now: at(20) }).text, /never covered/);
});

/* ---- the curveball ---- */

test('the curveball is due in the middle of the interview, not at the start or the end', () => {
  const s = fresh();
  assert.equal(curveballDue(s, at(2)), false, 'fired before there was a design to disturb');
  assert.equal(curveballDue(s, at(22)), true);
  assert.equal(curveballDue(s, at(40)), false, 'fired with no time left to recover');
  assert.match(buildTurn(fresh(), { now: at(22) }).text, /curveball is due this turn/);
});

test('the curveball fires once', () => {
  const s = fresh();
  s.curveballDone = true;
  assert.equal(curveballDue(s, at(22)), false);
  assert.doesNotMatch(buildTurn(s, { now: at(22) }).text, /curveball/);
});

/* ---- the whiteboard ---- */

test('the diagram is sent on the first turn that has one', () => {
  const g = graphOf(['Client', 'API'], [['Client', 'API']]);
  const text = buildTurn(fresh(), { now: at(5), graph: g }).text;
  assert.match(text, /THE WHITEBOARD NOW:/);
  assert.match(text, /Client -> API/);
});

test('an unchanged diagram is not re-sent — it would cost every turn and say nothing', () => {
  const g = graphOf(['Client', 'API'], [['Client', 'API']]);
  const text = buildTurn(fresh(), { now: at(6), graph: g, previousGraph: g }).text;
  assert.doesNotMatch(text, /THE WHITEBOARD NOW:/);
});

test('a changed diagram is re-sent, with what changed said in one line', () => {
  const before = graphOf(['Client', 'API'], [['Client', 'API']]);
  const after = graphOf(['Client', 'API', 'Redis'], [['Client', 'API'], ['API', 'Redis']]);
  const text = buildTurn(fresh(), { now: at(7), graph: after, previousGraph: before }).text;
  assert.match(text, /THE WHITEBOARD NOW:/);
  assert.match(text, /Since your last question they: drew Redis; connected API -> Redis/);
});

test('a component nothing reads from reaches the interviewer as exactly that', () => {
  const g = graphOf(['Client', 'API', 'Redis'], [['Client', 'API']]);
  assert.match(buildTurn(fresh(), { now: at(8), graph: g }).text,
    /DRAWN BUT UNCONNECTED[\s\S]*Redis/);
});

/* ---- silence ---- */

test('silence is reported as silence, never as an answer', () => {
  const text = buildTurn(fresh(), { now: at(4), said: '' }).text;
  assert.match(text, /has not said anything since your last question/);
  assert.doesNotMatch(text, /THE CANDIDATE SAID/);
});

/* ---- the debrief ---- */

test('the debrief drops the character and asks for the four sections', () => {
  const s = fresh();
  const text = debriefPrompt(s);
  assert.match(text, /Drop the interviewer character/);
  assert.match(text, /strong hire \/ hire \/ lean no \/ no hire/);
  assert.match(text, /Hard technical errors/);
  assert.match(text, /unsparing/);
  assert.match(text, /Do not invent an exchange/);
});

test('the debrief knows which phases were never reached', () => {
  const s = fresh();
  enterPhase(s, 'entities');
  // Reaching "core entities" leaves everything from the API onward untouched.
  assert.match(debriefPrompt(s),
    /never reached: API, scale estimates, high-level design & data model, one deep dive, bottlenecks & tradeoffs/);
});

test('"done" routes to the debrief rather than another question', () => {
  const turn = buildTurn(fresh(), { now: at(44), done: true });
  assert.equal(turn.kind, 'debrief');
  assert.match(turn.text, /interview is over/);
});

test('a normal turn always ends by asking for one question in the interviewer voice', () => {
  const turn = buildTurn(fresh(), { now: at(3), said: 'I think we need a queue' });
  assert.equal(turn.kind, 'turn');
  assert.match(turn.text, /Ask your next question\. One question\. Interviewer voice only\./);
  // …and the phase line, which is stripped before the candidate ever sees it.
  assert.match(turn.text, /End with the \[\[phase: …\]\] line\.$/);
});

test('the elapsed clock is stated, because 45 minutes is the whole frame', () => {
  assert.match(buildTurn(fresh(), { now: at(17) }).text, /\[17 min elapsed of 45\]/);
  assert.equal(DEFAULT_MINUTES, 45);
});

/* ---- memory across interviews ---- */

// The prompt is hard-wrapped, so these match against a single-spaced copy rather than
// against the literal line breaks — otherwise rewrapping a paragraph fails the test
// without changing a word of what the interviewer is told.
const flat = (text) => String(text).replace(/\s+/g, ' ');

test('the interviewer is told its own history is on disk, and how to use it', () => {
  const p = flat(systemPrompt());
  assert.match(p, /design\/<timestamp>\/interview\.md/);
  assert.match(p, /DESIGN\.md/);
  // The value is in asking harder where they have failed before, not in reciting it.
  assert.match(p, /push harder where they have failed before/);
  assert.match(p, /never quote a past interview at them mid-interview/);
});

test('memory is written at the debrief, not during the interview', () => {
  assert.match(flat(debriefPrompt(newInterview({ startedAt: T0 }))), /update DESIGN\.md/);
  assert.match(flat(systemPrompt()), /Update DESIGN\.md at the debrief, not during\./);
});

test('the spoken medium is stated, because a paragraph read aloud is a monologue', () => {
  assert.match(flat(systemPrompt()), /being spoken/);
});

// The phase tag arrives as ordinary tokens, split wherever the stream happens to split
// it. Every split must strip the same way, or the candidate reads "[[phase: …]]".
test('the phase tag is stripped however the stream splits it', () => {
  const reply = 'Design a feed.\n\n[[phase: requirements]]';
  for (let cut = 1; cut < reply.length; cut++) {
    const s = createTagStripper();
    const shown = s.push(reply.slice(0, cut)) + s.push(reply.slice(cut)) + s.flush();
    assert.equal(shown, 'Design a feed.\n\n', `split at ${cut}`);
    assert.equal(s.phase, 'requirements', `split at ${cut}`);
  }
});

test('a bracket that is not a tag is still shown', () => {
  const s = createTagStripper();
  const shown = s.push('Use a[0] and [[x') + s.push(']] here') + s.flush();
  assert.equal(shown, 'Use a[0] and [[x]] here');
});
