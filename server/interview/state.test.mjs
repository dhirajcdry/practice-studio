import test from 'node:test';
import assert from 'node:assert/strict';
import { newState, shouldInterject, observe, advance, pause, resume, elapsed, phaseTimes, recordHints, factBlock, codeContext } from './state.mjs';
import { createTagStripper } from './narration.mjs';
import { createNarrationFilter } from '../design/narration.mjs';
const fresh = () => newState({ slug: 'two-sum', startedAt: 1000 });
const event = (type, speech = 200, typing = 200, extra = {}) => ({ type, secondsSinceSpeech: speech, secondsSinceTyping: typing, ...extra });
test('interjection timing table and verdicts wait for the floor', () => {
  for (const [label, phase, e, now, last, expected] of [
    ['speaking', 'code', event('verdict', 200, 200, { speaking: true }), 200000, null, false],
    ['last word', 'code', event('verdict', 19.9), 200000, null, false],
    ['20s boundary', 'code', event('verdict', 20), 200000, null, true],
    ['cooldown', 'code', event('verdict'), 200000, 80001, false],
    ['120s boundary', 'code', event('verdict'), 200000, 80000, true],
    ['clarify idle', 'clarify', event('idle', 45, 45), 200000, null, true],
    ['approach typing', 'approach', event('idle', 100, 44.9), 200000, null, false],
    ['code 89s', 'code', event('idle', 89, 200), 200000, null, false],
    ['code 90s', 'code', event('idle', 90, 90), 200000, null, true],
    ['failed run 30s', 'code', event('run_result', 30, 200, { failed: 1 }), 200000, null, false],
    ['failed run after30', 'code', event('run_result', 30.1, 200, { failed: 1 }), 200000, null, true],
    ['passed run', 'code', event('run_result', 200, 200, { failed: 0 }), 200000, null, false],
    ['phase hint only', 'code', event('phase_hint'), 200000, null, false],
  ]) {
    const s = fresh(); s.phase = phase; s.lastInterjectAt = last;
    assert.equal(shouldInterject(s, e, now), expected, label);
  }
  const s = fresh(); observe(s, event('verdict', 0), 200000);
  assert.equal(shouldInterject(s, event('idle', 0), 200000), false);
  assert.equal(shouldInterject(s, event('idle', 20, 0), 220000), true);
  pause(s, 220000); assert.equal(shouldInterject(s, event('verdict'), 250000), false);
  resume(s, 250000); s.debriefed = true;
  assert.equal(shouldInterject(s, event('verdict'), 300000), false);
});
test('wall time, explicit pause, phase and hint evidence', () => {
  const s = fresh(); advance(s, 'approach', 11000); pause(s, 16000); resume(s, 46000);
  assert.equal(elapsed(s, 51000), 20000);
  assert.deepEqual(phaseTimes(s, 51000), { clarify: 10000, approach: 10000, code: 0, test: 0, followup: 0 });
  recordHints(s, ['nudge', 'unknown'], 51000);
  assert.deepEqual(s.hints, [{ level: 'nudge', elapsedMs: 20000, phase: 'approach' }]);
  assert.ok(factBlock(s, 51000).length < 1500);
  s.endedAt = 51000; assert.equal(elapsed(s, 90000), 20000);
  s.endedAt = null; pause(s, 51000); s.endedAt = 90000;
  assert.equal(elapsed(s, 100000), 20000, 'ending while paused excludes that pause');
});
test('warning is due once, subject to safety', () => {
  const s = fresh(); s.phase = 'followup';
  assert.equal(shouldInterject(s, event('idle'), s.startedAt + 43 * 60000), true);
  s.warningGiven = true;
  assert.equal(shouldInterject(s, event('idle'), s.startedAt + 43 * 60000), false);
});
test('diffs anchor line replacement, refresh full buffer and never fabricate unavailable code', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const b = a.replace('line 15', 'changed');
  assert.match(codeContext(a, b, 1), /Replace lines 16–16/);
  assert.match(codeContext(a, b, 5), /^Full buffer/);
  assert.equal(codeContext(a, a, 1), 'Buffer unchanged.');
  assert.equal(codeContext(a, undefined, 1), 'Buffer unavailable.');
});
test('phase and hint tags are stripped at EVERY character boundary before narration', () => {
  const source = 'What changes? [[phase: code]] [[hint: nudge]]';
  for (let split = 0; split <= source.length; split++) {
    const tags = createTagStripper();
    const out = tags.push(source.slice(0, split)) + tags.push(source.slice(split)) + tags.flush();
    assert.equal(out, 'What changes?  '); assert.equal(tags.phase, 'code'); assert.deepEqual(tags.hints, ['nudge']);
  }
  const tags = createTagStripper(); let text = '';
  for (const c of 'Hello [[ PHASE : approach ]]') text += tags.push(c);
  assert.equal(text + tags.flush(), 'Hello '); assert.equal(tags.phase, 'approach');
  const guard = createNarrationFilter();
  assert.equal(guard.push('Why?\nCand').text, 'Why?\n');
  assert.equal(guard.push('idate: use a map').tripped, true);
});
