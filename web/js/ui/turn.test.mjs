import test from 'node:test';
import assert from 'node:assert/strict';
import { activitySteps, activitySummary, isNoteOnlyReply } from './turn.js';

const note = { display: { doing: 'Saving a private note', done: 'Saved a private note', effect: 'note' } };
test('note-only notice includes empty and short text but excludes substantive replies', () => {
  for (const text of ['', 'Saved.', 'a'.repeat(199)]) assert.equal(isNoteOnlyReply({ text, activity: [note] }), true);
  assert.equal(isNoteOnlyReply({ text: 'a'.repeat(200), activity: [note] }), false);
});
test('note-only notice excludes live turns, reviews and learner changes or handoffs', () => {
  assert.equal(isNoteOnlyReply({ activity: [note], finished: false }), false);
  assert.equal(isNoteOnlyReply({ activity: [note], kind: 'attempt-review' }), false);
  assert.equal(isNoteOnlyReply({ activity: [] }), false);
  for (const effect of ['change', 'handoff']) {
    assert.equal(isNoteOnlyReply({ activity: [note, { effect }] }), false);
    assert.equal(isNoteOnlyReply({ activity: [note], actions: [{ display: { effect } }] }), false);
  }
});
test('activity derives event gaps, preserves unknown duration and does not expose raw tools', () => {
  const input = [{ name: 'unknown_secret', summary: 'private/path', at: '2025-01-01T10:00:00Z' }, { ...note, at: '2025-01-01T10:00:03Z' }];
  const steps = activitySteps(input, '2025-01-01T10:00:05Z');
  assert.deepEqual(steps.map(step => step.ms), [3000, 2000]);
  assert.equal(steps[0].display.done, 'Used a tool');
  assert.equal(activitySteps([{}])[0].ms, null);
  assert.equal(input[0].ms, undefined);
  assert.equal(activitySummary(steps), 'Looked at 1 thing · saved a private note');
  assert.equal(activitySummary([]), '');
  assert.equal(activitySummary([{ effect: 'change' }]), '');
});

test('turn slots stay independent during prose updates and empty replies have no Copy', async t => {
  // A DOM-shaped test double checks ownership/atomic replacement, not browser layout.
  class Node {
    constructor(tag = '') { this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this.hidden = false; this.replacements = 0; this.listeners = {}; }
    get classList() { return { add: (...names) => { this.className += ' ' + names.join(' '); }, contains: name => this.className.split(' ').includes(name) }; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = value; if (name === 'hidden') this.hidden = true; }
    addEventListener(name, callback) { this.listeners[name] = callback; }
    append(...nodes) { for (const node of nodes) for (const child of node.tagName === '#fragment' ? node.children : [node]) { child.remove(); this.children.push(child); child.parentNode = this; } }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
    replaceChildren(...nodes) { this.replacements++; this.children = []; this.append(...nodes); }
    set textContent(text) { this.children = []; this.text = String(text); }
    get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  }
  const before = { document: globalThis.document, Node: globalThis.Node };
  globalThis.Node = Node;
  globalThis.document = { createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag),
    createDocumentFragment: () => new Node('#fragment'), createTextNode: text => Object.assign(new Node('#text'), { textContent: text }) };
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete globalThis[name]; else globalThis[name] = value; } });
  const { createReply } = await import('./turn.js');
  const { el, replace } = await import('../dom.js');
  const reply = createReply(); t.after(reply.dispose);
  const [, activity, changes, body, notice] = reply.node.children;
  reply.setActivity([{ display: { doing: 'Reading context', done: 'Read context', effect: 'read' }, ms: 1200 }]);
  activity.children[0].listeners.click();
  assert.equal(activity.children[0].attributes['aria-expanded'], 'true');
  reply.setChanges([{ id: 'fixture', title: 'Added a test case', state: 'pending', actions: [{ label: 'Undo', onClick() {} }] }]);
  reply.finish();
  assert.equal(reply.node.children.some(child => child.className === 'ui-turn-foot'), false);
  const activityContents = activity.children, changeContents = changes.children;
  const activityReplacements = activity.replacements, changeReplacements = changes.replacements;
  body.dataset.markdown = 'Answer'; replace(body, el('p', { text: 'Answer' }));
  reply.finish({ at: '2025-01-01T10:00:00Z', durationMs: 5000 });
  const foot = reply.node.children.at(-1);
  assert.equal(foot.hidden, false);
  assert.equal(foot.children[0].attributes['aria-label'], 'Copy reply');
  assert.equal(activity.children, activityContents); assert.equal(changes.children, changeContents);
  assert.equal(activity.replacements, activityReplacements); assert.equal(changes.replacements, changeReplacements);
  reply.setNotice({ tone: 'warn', head: 'Stopped before it finished' });
  assert.equal(notice.hidden, false); assert.equal(body.textContent, 'Answer');
  reply.setNotice(null); assert.equal(notice.hidden, true);
});

test('a saved step carries only a tool name and takes its wording from the table', async () => {
  const { setToolDisplay } = await import('../tool-display.js');
  setToolDisplay({ get_submissions: { doing: 'Reading your submissions', done: 'Read your submissions', effect: 'read' },
    save_note: { doing: 'Saving a private note', done: 'Saved a private note', effect: 'note' } });
  try {
    const steps = activitySteps([{ tool: 'mcp__studio__get_submissions', ms: 2000 }, { tool: 'save_note' }, { tool: 'never_heard_of_it' }]);
    assert.deepEqual(steps.map(step => step.display.done), ['Read your submissions', 'Saved a private note', 'Used a tool']);
    assert.deepEqual(steps.map(step => step.effect), ['read', 'note', 'read']);
    // The note-only rule works from tool names alone, as a replayed turn supplies them.
    assert.equal(isNoteOnlyReply({ text: 'Saved.', activity: [{ tool: 'save_note' }] }), true);
    assert.equal(isNoteOnlyReply({ text: 'Saved.', activity: [], actions: [{ tool: 'save_note' }] }), true);
  } finally { setToolDisplay(null); }
});
