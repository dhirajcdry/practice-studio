import test from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, splitParameters, stackRows } from '../../web/js/statement-values.js';

const flat = text => text.replace(/\n\s*/g, '');

test('each parameter of an example input gets its own line', () => {
  assert.deepEqual(splitParameters('root = [3,5,1,6,2,0,8,null,null,7,4], p = 5, q = 1'), ['root = [3,5,1,6,2,0,8,null,null,7,4]', 'p = 5', 'q = 1']);
  assert.deepEqual(splitParameters('nums = [2,7,11,15], target = 9'), ['nums = [2,7,11,15]', 'target = 9']);
});

test('commas inside lists, strings and calls never split a value', () => {
  assert.deepEqual(splitParameters('s = "a, b = c", t = "x"'), ['s = "a, b = c"', 't = "x"']);
  assert.deepEqual(splitParameters('[1,2,3]'), ['[1,2,3]']);
  assert.deepEqual(splitParameters('words = ["a = 1, b = 2"]'), ['words = ["a = 1, b = 2"]']);
  assert.deepEqual(splitParameters('true'), ['true']);
  assert.deepEqual(splitParameters('The answer is 3, because a == b'), ['The answer is 3, because a == b']);
});

test('a long grid is stacked one row per line and a short one is left alone', () => {
  assert.equal(stackRows('[[1,2],[3,4]]'), '[[1,2],[3,4]]');
  const grid = 'grid = [["1","1","0","0","0"],["1","1","0","0","0"],["0","0","1","0","0"]]';
  assert.equal(stackRows(grid), 'grid = [["1","1","0","0","0"],\n        ["1","1","0","0","0"],\n        ["0","0","1","0","0"]]');
  assert.equal(stackRows('[[1,[2,3]],[4,[5,6]],[7,[8,9]],[10,[11,12]]]').split('\n').length, 4);
});

test('formatting changes layout only: joining the lines back gives the same value', () => {
  for (const value of [
    'root = [3,5,1,6,2,0,8,null,null,7,4], p = 5, q = 1',
    'board = [["5","3",".",".","7"],["6",".",".","1","9"],[".","9","8",".","."]], word = "ABCCED"',
    's = "A man, a plan, a canal: Panama"', '[]', '',
  ]) {
    // The comma between two parameters becomes the line break; everything else is untouched.
    const rejoined = splitParameters(value).map(part => flat(stackRows(part))).join(', ');
    assert.equal(rejoined.replace(/\s/g, ''), value.replace(/\s/g, ''));
    assert.equal(formatValue(value).split('\n').length >= splitParameters(value).length, true);
  }
});
