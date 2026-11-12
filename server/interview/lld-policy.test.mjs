import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from './state.mjs';
import { turnPrompt, systemPrompt, lldSystemPrompt, debriefPrompt } from './prompt.mjs';
import { createTagStripper } from './narration.mjs';
import { parseReport } from './report.mjs';
test('a coding mock follows the approach and agrees a plan before complexity', () => {
  const prompt = systemPrompt();
  assert.match(prompt, /Then agree on the plan before they write real code/);
  assert.match(prompt, /Okay, go ahead with that/);
  assert.match(prompt, /Ask about complexity only once you understand the approach, and only if they have not already said it/);
  assert.match(prompt, /Never call an approach right or optimal/);
  assert.match(prompt, /names no concrete input, ask once for one/);
  assert.doesNotMatch(prompt, /AND time\/space complexity before they code/);
  const opening = turnPrompt(newState({ slug: 'two-sum' }), { kind: 'opening' });
  assert.match(opening, /ask anything they need to/);
  assert.doesNotMatch(opening, /talk through their approach/);
});
test('an LLD change requirement waits for a design, and is dropped when it is too late to answer', () => {
  const startedAt = 1_000_000, minute = 60000;
  const at = (minutes, phase = 'code') => turnPrompt({ ...newState({ slug: 'lld-x', minutes: 60, startedAt }), discipline: 'lld', phase, scenario: { curveball: 'SECRET_CHANGE' } }, { said: 'x', now: startedAt + minutes * minute });
  // Entering the code phase once fired it at 26 minutes, before any code existed.
  assert.doesNotMatch(at(26), /SECRET_CHANGE/); assert.match(at(26), /not available yet/);
  assert.match(at(44), /SECRET_CHANGE/); assert.match(at(44), /do not ask them to code it/);
  assert.match(at(30, 'test'), /SECRET_CHANGE/);
  assert.doesNotMatch(at(58), /SECRET_CHANGE/); assert.match(at(58), /too late/);
});
test('the LLD plan moves a candidate on by share of time, without a clock on every turn', () => {
  const startedAt = 1_000_000, minute = 60000;
  const at = (minutes, phase, length = 60) => turnPrompt({ ...newState({ slug: 'lld-x', minutes: length, startedAt }), discipline: 'lld', phase, scenario: {} }, { said: 'x', now: startedAt + minutes * minute });
  assert.match(at(3, 'clarify'), /5% of the time is used, so the plan says requirements\.(?! They are behind)/);
  assert.match(at(15, 'clarify'), /They are behind it, still in clarify/);
  assert.match(at(45, 'code'), /plan says a trace through their code\. They are behind it/);
  assert.match(at(3, 'clarify', 30), /10% of the time/);
  assert.match(at(60, 'followup'), /100% of the time is used, so the plan says the changed requirement\.(?! They are behind)/);
  const system = lldSystemPrompt();
  assert.match(system, /Say the time only when it changes what they should do/);
  assert.match(system, /\[\[hint: nudge\]\]/);
  assert.match(system, /if you do not ask, it does not happen/);
});
test('every report judges against a passing candidate, not an ideal one', () => {
  for (const discipline of ['coding', 'lld', 'design']) {
    const prompt = debriefPrompt({ ...newState({ slug: 'x' }), discipline, targetLevel: 'L5', scenario: {} }, [], Date.now());
    assert.match(prompt, /a candidate who would pass at L5/);
    assert.match(prompt, /Count each shortfall once/);
    assert.match(prompt, /"signal": .*\| null/);
    assert.doesNotMatch(prompt, /highest priority|what a strong candidate/);
  }
});
test('a report with nothing to assess keeps its null signal and ratings', () => {
  const report = parseReport(JSON.stringify({ signal: null, headline: 'Too little to assess.', dimensions: [{ name: 'Coding', rating: null, summary: 'Nothing was written.', evidence: [] }] }));
  assert.equal(report.signal, null);
  assert.ok(report.dimensions.every(dimension => dimension.rating === null));
});
test('an LLD debrief does not fault what the interview never asked for', () => {
  const state = { ...newState({ slug: 'lld-x' }), discipline: 'lld', scenario: {} };
  assert.match(debriefPrompt(state, [], Date.now()), /call it not reached/);
});
test('reports credit what was said, not only the final code', () => {
  for (const reportDifficulty of [undefined, 'beginner']) {
    const prompt = debriefPrompt({ ...newState({ slug: 'lld-x' }), discipline: 'lld', scenario: {}, reportDifficulty }, [], Date.now());
    assert.match(prompt, /What the candidate said is evidence on a par with what they typed/);
    assert.match(prompt, /interviewer said talking it through was fine.*carries no weight anywhere/);
    assert.match(prompt, /A stub or placeholder they named, or a step they described correctly, is not one/);
    assert.match(prompt, /find the earliest candidate turn that mentions it/);
    assert.match(prompt, /key rules are either coded or correctly described|neither coded nor correctly described/);
    assert.match(prompt, /never a technical error/);
  }
});
test('LLD reads full latest document every turn and gates the curveball from durable state', () => {
  const state = { ...newState({ slug: 'lld-locker' }), discipline: 'lld', lastCode: 'old', turns: 1, phase: 'code', gaps: { ownership: 2 } };
  const prompt = turnPrompt(state, { code: 'class CandidateOwned:\n    pass', said: 'Please review this.' });
  assert.match(prompt, /class CandidateOwned:/); assert.doesNotMatch(prompt, /Replace lines/);
  state.curveballDone = true; assert.match(turnPrompt(state), /already delivered; never introduce another/);
  assert.match(lldSystemPrompt(), /give a go-ahead/); assert.match(lldSystemPrompt(), /Understand what they mean before you evaluate it/);
  assert.match(lldSystemPrompt(), /Stepping in is your judgment/); assert.match(lldSystemPrompt(), /reply with ONLY the phase tag/);
  assert.match(debriefPrompt(state, [], Date.now()), /technicalErrors/);
});
test('LLD private control tags never leak, even chunked character-by-character', () => {
  const tags = createTagStripper(); let shown = '';
  for (const c of 'Who owns this state? [[gap: ownership]] [[curveball: delivered]] [[phase: code]]') shown += tags.push(c);
  shown += tags.flush(); assert.equal(shown.trim(), 'Who owns this state?'); assert.equal(tags.gap, 'ownership'); assert.equal(tags.curveball, true);
});
