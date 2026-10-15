import test from 'node:test';
import assert from 'node:assert/strict';
import { designDraftNotice } from '../../web/js/design-draft.js';
import { saveDraft, appendDraft, readDraft, watchDraft } from '../../web/js/drafts.js';

test('a recovered voice answer requires Send or Edit; typed and empty drafts do not show a notice', () => {
  assert.deepEqual(designDraftNotice({ text: ' restored ', pending: true, mode: 'voice' }),
    { visible: true, tail: 'restored', blocksMic: true });
  assert.equal(designDraftNotice({ text: 'restored', pending: true }).visible, false);
  assert.equal(designDraftNotice({ text: '  ', pending: true, mode: 'voice' }).blocksMic, false);
  assert.equal(designDraftNotice({ text: 'live speech', mode: 'voice' }).visible, false);
  assert.equal(designDraftNotice({ text: 'x'.repeat(200) + ' tail', pending: true, mode: 'voice' }).tail.length, 160);
});

test('detached design phrases append to the latest draft and notify a resumed composer', () => {
  const key = 'design:test-detached';
  saveDraft(key, 'old');
  saveDraft(key, 'edited on return');
  let notice;
  const off = watchDraft(key, text => { notice = designDraftNotice({ text, pending: true, mode: 'voice' }); });
  appendDraft(key, 'last spoken phrase');
  assert.equal(readDraft(key).text, 'edited on return last spoken phrase');
  assert.equal(notice.visible, true);
  assert.equal(notice.blocksMic, true);
  off();
});
