import test from 'node:test';
import assert from 'node:assert/strict';
import { levelKey, levelLabel, designLevelBar, LEVEL_KEYS } from './levels.mjs';
import { debriefPrompt } from './prompt.mjs';
import { newState } from './state.mjs';
import { systemPrompt, newInterview, debriefPrompt as mockDebrief } from '../design/interview.mjs';
import { practiceSystemPrompt } from '../practice/routes.mjs';

const flat = (s) => s.replace(/\s+/g, ' ');

test('role names map to Studio levels, and a company L5 is not Studio L5', () => {
  assert.equal(levelKey('L4'), 'L4');
  assert.equal(levelKey('l6'), 'L6');
  assert.equal(levelKey('SDE II (L5)'), 'L4');
  assert.equal(levelKey('SDE-2'), 'L4');
  assert.equal(levelKey('SDE III'), 'L5');
  assert.equal(levelKey('SDE I'), 'L3');
  assert.equal(levelKey('L9'), null);
  assert.equal(levelKey(undefined), null);
  assert.match(levelLabel('L4'), /mid-level, e\.g\. SDE II/);
});

test('every level has a bar, and an unknown level adds nothing', () => {
  for (const key of LEVEL_KEYS) assert.match(designLevelBar(key), new RegExp(`THE ${key} BAR`));
  assert.equal(designLevelBar('principal-ish'), '');
});

test('the mid-level bar treats an unresolved hard problem as a stretch, not a failure', () => {
  const bar = flat(designLevelBar('L4'));
  assert.match(bar, /Breadth matters more than depth/);
  assert.match(bar, /positive signal even when it is not fully resolved/);
  assert.match(bar, /stretch rather than a gap: fully resolving contention/);
});

test('the mock interviewer is told what its level means and not to re-raise answered gaps', () => {
  const p = flat(systemPrompt({ level: 'L4' }));
  assert.match(p, /targeting L4 \(mid-level/);
  assert.match(p, /THE L4 BAR/);
  assert.match(p, /do not keep pressing until it is fully solved/);
  assert.match(p, /do not raise it again unless their design has changed/);
  assert.match(flat(systemPrompt({ level: 'L5' })), /THE L5 BAR \(senior/);
  assert.match(flat(mockDebrief(newInterview({ level: 'L4' })).toString()), /THE L4 BAR/);
});

test('a design report graded at Mid-level uses the mid-level bar', () => {
  const state = { ...newState({ slug: 'system-design' }), discipline: 'design', targetLevel: 'L5' };
  assert.match(debriefPrompt(state, [], Date.now()), /THE L5 BAR/);
  assert.match(debriefPrompt({ ...state, reportDifficulty: 'mid-level' }, [], Date.now()), /THE L4 BAR \(mid-level/);
  assert.doesNotMatch(debriefPrompt({ ...state, discipline: 'lld' }, [], Date.now()), /BAR \(/);
});

test('system design practice carries a target level, defaulting to mid-level', () => {
  assert.match(practiceSystemPrompt('design', undefined), /preparing for L4 \(mid-level/);
  assert.match(practiceSystemPrompt('design', 'L5'), /THE L5 BAR/);
  assert.match(flat(practiceSystemPrompt('design', 'L4')), /label anything beyond it as a stretch/);
  assert.doesNotMatch(practiceSystemPrompt('lld', 'L4'), /TARGET LEVEL/);
});
