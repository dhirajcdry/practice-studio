import test from 'node:test';
import assert from 'node:assert/strict';
import { checkNeetCodeShape, solutionMethods, neetcodeMismatch } from '../../web/js/neetcode-shape.js';

test('checks only direct Solution methods, ignoring comments, strings and nested definitions', () => {
  const code = `# class Solution: def islandsAndTreasure(self):
class Other:
    def islandsAndTreasure(self): pass
class Solution:
    """def islandsAndTreasure(self):"""
    def wallsAndGates(self, rooms):
        def islandsAndTreasure(): pass
        return 'def islandsAndTreasure(self):'
    class Nested:
        def islandsAndTreasure(self): pass
`;
  assert.deepEqual(checkNeetCodeShape(code, ['islandsAndTreasure']), { missing: ['islandsAndTreasure'], found: ['wallsAndGates'] });
  const mismatch = neetcodeMismatch(code, { methods: [{ name: 'islandsAndTreasure', params: ['grid'] }] });
  assert.equal(mismatch.message, 'NeetCode judges this problem and calls islandsAndTreasure(grid). Your code defines wallsAndGates.');
  const { start, end, to } = mismatch.rename;
  assert.equal(code.slice(start, end), 'wallsAndGates');
  const renamed = code.slice(0, start) + to + code.slice(end);
  assert.match(renamed, /islandsAndTreasure\(self, rooms\)/);
  assert.deepEqual(checkNeetCodeShape(renamed, ['islandsAndTreasure']).missing, []);
});

test('tabs, decorators and async methods have accurate name offsets', () => {
  const code = 'class Solution:\n\t@decorator\n\tasync def alienOrder(self, words):\n\t\tpass';
  const [method] = solutionMethods(code);
  assert.equal(method.name, 'alienOrder');
  assert.equal(code.slice(method.start, method.end), 'alienOrder');
});

test('class-shape mismatch has no rename button', () => {
  const shape = { methods: [{ name: 'encode', params: ['strs'] }, { name: 'decode', params: ['s'] }], testCaseType: 'class' };
  assert.equal(neetcodeMismatch('class Codec:\n    def encode(self, strs): pass', shape).rename, null);
  assert.equal(neetcodeMismatch('class Solution:\n    def encode(self, strs): pass\n    def decode(self, s): pass', shape), null);
});

test('Interval list-shaped implementations warn, attribute implementations work', () => {
  const shape = { methods: [{ name: 'canAttendMeetings', params: ['intervals'] }], intervals: true };
  for (const body of ['return intervals[0][1]', 'intervals.sort(key=lambda x: x[0])', 'for interval in intervals:\n            return interval[0]']) {
    const mismatch = neetcodeMismatch(`class Solution:\n    def canAttendMeetings(self, intervals):\n        ${body}`, shape);
    assert.match(mismatch.message, /Interval objects/);
    assert.equal(mismatch.rename, null);
  }
  assert.equal(neetcodeMismatch('class Solution:\n    def canAttendMeetings(self, intervals: List[Interval]) -> bool:\n        return intervals[0].end < intervals[1].start', shape), null);
  assert.equal(neetcodeMismatch('class Solution:\n    def canAttendMeetings(self, intervals):\n        pairs = [(i.start, i.end) for i in intervals]\n        pairs.sort(key=lambda x: x[0])\n        return pairs[0][1] > 0', shape), null);
});

test('legacy method can be renamed while helper methods stay intact', () => {
  const mismatch = neetcodeMismatch('class Solution:\n    def wallsAndGates(self, rooms): pass\n    def helper(self): pass', { methods: [{ name: 'islandsAndTreasure', params: ['grid'] }] });
  assert.equal(mismatch.rename.name, 'wallsAndGates');
  assert.equal(neetcodeMismatch('class Solution:\n    def __init__(self): pass', { methods: [{ name: 'islandsAndTreasure', params: ['grid'] }] }).rename, null);
});

test('submit panel refuses mismatches before events, fetches or Connector messages', async t => {
  const previous = { Node: globalThis.Node, document: globalThis.document, location: globalThis.location, fetch: globalThis.fetch, window: globalThis.window };
  t.after(() => Object.assign(globalThis, previous));
  class TestNode {
    constructor(tag) { this.tag = tag; this.children = []; this.listeners = {}; this.dataset = {}; this.textContent = ''; }
    append(child) { this.children.push(child); }
    replaceChildren(...children) { this.children = children; }
    setAttribute(name, value) { this[name] = value; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
  }
  globalThis.Node = TestNode;
  globalThis.document = { createElement: tag => new TestNode(tag), createTextNode: text => Object.assign(new TestNode('text'), { textContent: text }), createDocumentFragment: () => new TestNode('fragment'), documentElement: { dataset: { studioConnector: '1.1.0' } } };
  globalThis.location = { search: '' };
  let sent = 0, events = 0, fixed = 0;
  globalThis.fetch = () => { sent++; throw new Error('Unexpected network'); };
  globalThis.window = { postMessage: () => { sent++; }, addEventListener() {}, removeEventListener() {} };
  const { createSubmitPanel } = await import('../../web/js/submit.js');
  const message = 'NeetCode judges this problem and calls islandsAndTreasure(grid). Your code defines wallsAndGates.';
  const panel = createSubmitPanel({ slug: 'walls-and-gates', getTarget: () => 'neetcode', getCode: () => 'old code',
    getMismatch: () => ({ message, fix: () => { fixed++; } }), onEvent: () => { events++; } });
  // blocker() keeps naming a Connector panel kind; the mismatch is refused inside submit().
  assert.notEqual(panel.blocker(), message);
  await panel.submit();
  await panel.submit();
  assert.equal(sent, 0);
  assert.equal(events, 0);
  assert.equal(panel.isBusy(), false);
  const all = node => [node, ...node.children.flatMap(all)];
  assert.ok(all(panel.root).some(n => n.textContent === message));
  const button = all(panel.root).find(n => n.textContent === "Use NeetCode's name");
  button.listeners.click();
  assert.equal(fixed, 1);
  assert.equal(sent, 0);
});
