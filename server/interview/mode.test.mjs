import test from 'node:test';
import assert from 'node:assert/strict';
import { newState } from './state.mjs';

test('new interviews default to voice while explicit and legacy modes remain stable', () => {
  assert.equal(newState({ slug: 'x' }).mode, 'voice');
  assert.equal(newState({ slug: 'x', mode: 'typed' }).mode, 'typed');
  const legacy = { slug: 'x', minutes: 45 };
  assert.equal(legacy.mode, undefined, 'readers can treat absent legacy mode as typed');
});
