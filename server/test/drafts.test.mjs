import test from 'node:test';
import assert from 'node:assert/strict';

test('conversation drafts round trip, isolate slugs, and clear', async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
  const drafts = await import(`../../web/js/drafts.js?test=${Date.now()}`);
  drafts.saveDraft('two-sum', 'start here');
  assert.equal(drafts.readDraft('two-sum').text, 'start here');
  assert.equal(drafts.readDraft('three-sum'), null);
  drafts.clearDraft('two-sum');
  assert.equal(drafts.readDraft('two-sum'), null);
  delete globalThis.localStorage;
});

test('late detached dictation appends to the latest draft and updates a remounted composer', async () => {
  const data = new Map();
  globalThis.localStorage = {
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key),
  };
  try {
    const drafts = await import('../../web/js/drafts.js');
    drafts.saveDraft('two-sum', 'old text');
    drafts.saveDraft('two-sum', 'edited after returning');
    let visible = '';
    const unwatch = drafts.watchDraft('two-sum', value => { visible = value; });
    drafts.appendDraft('two-sum', 'final words');
    assert.equal(visible, 'edited after returning final words');
    assert.equal(drafts.readDraft('two-sum').text, visible);
    drafts.clearDraft('two-sum');
    assert.equal(visible, '');
    unwatch();
  } finally { delete globalThis.localStorage; }
});

test('storage refusal still preserves drafts during this page session', async () => {
  const drafts = await import('../../web/js/drafts.js');
  drafts.saveDraft('unavailable', 'kept in memory');
  drafts.appendDraft('unavailable', 'and dictation');
  assert.equal(drafts.readDraft('unavailable').text, 'kept in memory and dictation');
  drafts.clearDraft('unavailable');
  assert.equal(drafts.readDraft('unavailable'), null);
});

test('a full storage quota cannot roll a live draft back to the last persisted version', async () => {
  globalThis.localStorage = {
    getItem: () => JSON.stringify({ text: 'stale' }),
    setItem() { throw Error('quota exceeded'); }, removeItem() { throw Error('denied'); },
  };
  try {
    const drafts = await import('../../web/js/drafts.js');
    drafts.saveDraft('quota', 'new words');
    drafts.appendDraft('quota', 'tail');
    assert.equal(drafts.readDraft('quota').text, 'new words tail');
    drafts.clearDraft('quota');
    assert.equal(drafts.readDraft('quota'), null);
  } finally { delete globalThis.localStorage; }
});
