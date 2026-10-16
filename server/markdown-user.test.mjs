import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeCode } from '../web/js/markdown.js';

test('detects Python with indentation', () => {
  assert.equal(looksLikeCode('def solve(nums):\n    return sorted(nums)'), true);
});

test('detects a JavaScript snippet', () => {
  assert.equal(looksLikeCode('const value = 1;\nlet result = value + 2;'), true);
});

test('leaves multiline English prose alone', () => {
  assert.equal(looksLikeCode('Please explain this approach.\nI am unsure about the complexity.'), false);
});

test('leaves single lines alone', () => {
  assert.equal(looksLikeCode('    return solve(nums)'), false);
  assert.equal(looksLikeCode('\nconst value = 1;\n\n'), false);
});
