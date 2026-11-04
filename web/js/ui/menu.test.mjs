import test from 'node:test';
import assert from 'node:assert/strict';
import { moveActive } from './menu.js';
test('moveActive wraps and skips disabled entries', () => { const items = [{}, { disabled: true }, {}]; assert.equal(moveActive(items, 0, 1), 2); assert.equal(moveActive(items, 2, 1), 0); });
test('moveActive returns -1 for empty or fully disabled menus', () => { assert.equal(moveActive([], 0, 1), -1); assert.equal(moveActive([{ disabled: true }], 0, 1), -1); });
