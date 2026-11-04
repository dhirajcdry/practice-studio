import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from './state.mjs';
import { turnPrompt, lldSystemPrompt, debriefPrompt } from './prompt.mjs';
import { createTagStripper } from './narration.mjs';
test('LLD reads full latest document every turn and gates the curveball from durable state', () => {
  const state = { ...newState({ slug: 'lld-locker' }), discipline: 'lld', lastCode: 'old', turns: 1, phase: 'code', gaps: { ownership: 2 } };
  const prompt = turnPrompt(state, { code: 'class CandidateOwned:\n    pass', said: 'Please review this.' });
  assert.match(prompt, /class CandidateOwned:/); assert.doesNotMatch(prompt, /Replace lines/);
  assert.match(prompt, /One curveball is due now/);
  state.curveballDone = true; assert.match(turnPrompt(state), /already delivered; never introduce another/);
  assert.match(lldSystemPrompt(), /Never hint/);
  assert.match(debriefPrompt(state, [], Date.now()), /technicalErrors/);
});
test('LLD private control tags never leak, even chunked character-by-character', () => {
  const tags = createTagStripper(); let shown = '';
  for (const c of 'Who owns this state? [[gap: ownership]] [[curveball: delivered]] [[phase: code]]') shown += tags.push(c);
  shown += tags.flush(); assert.equal(shown.trim(), 'Who owns this state?'); assert.equal(tags.gap, 'ownership'); assert.equal(tags.curveball, true);
});
