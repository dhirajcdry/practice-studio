import test from 'node:test';
import assert from 'node:assert/strict';
import { moveActive } from '../web/js/ui/menu.js';
test('UI menu navigation wraps and skips disabled entries', () => { const items = [{}, { disabled: true }, {}]; assert.equal(moveActive(items, 0, 1), 2); assert.equal(moveActive(items, 2, 1), 0); });
test('UI menu navigation handles empty menus', () => { assert.equal(moveActive([], 0, 1), -1); });
