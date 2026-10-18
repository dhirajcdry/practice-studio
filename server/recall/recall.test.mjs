import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getRecallDigest, saveRecallNote } from './index.mjs';
import { enqueueRecall, flushRecall, readRecallState, validRecallUrl } from './sync.mjs';

// No test in this file can contact Studycraft, even with a configured developer token.
const originalToken = process.env.STUDYCRAFT_RECALL_TOKEN;
const originalUrl = process.env.STUDYCRAFT_RECALL_URL;
process.env.STUDYCRAFT_RECALL_TOKEN = '';
process.env.STUDYCRAFT_RECALL_URL = 'http://127.0.0.1:49999/api/recall/import';
test.after(() => {
  if (originalToken === undefined) delete process.env.STUDYCRAFT_RECALL_TOKEN;
  else process.env.STUDYCRAFT_RECALL_TOKEN = originalToken;
  if (originalUrl === undefined) delete process.env.STUDYCRAFT_RECALL_URL;
  else process.env.STUDYCRAFT_RECALL_URL = originalUrl;
});
async function fixture(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-recall-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'problems', 'two-sum');
  await fsp.mkdir(path.join(dir, 'sessions'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'sessions', 'a.jsonl'), [
    { at: '2026-01-01', type: 'attempt_started', data: { attemptId: 'attempt-1' } },
    { at: '2026-01-01', type: 'run_result', data: { passed: 0, total: 1 } },
  ].map(JSON.stringify).join('\n') + '\n');
  await fsp.writeFile(path.join(dir, 'chats.jsonl'), JSON.stringify({ ask: 'Why does this fail?', answer: 'Check the invariant.' }) + '\n');
  return root;
}
const note = { slug: 'two-sum', patternId: 'hashing-complement', title: 'Hashing: complement', body: 'Look up before insertion.',
  intuition: 'Keep previously seen values.', recall: 'Why look up first?', trap: 'No trap recorded.', failingCase: 'No failing case recorded.' };
const reply = (payload, extra = {}) => new Response(JSON.stringify({ status: 'created', noteId: 'note-1',
  url: 'http://127.0.0.1:49999/notes/note-1', externalId: payload.externalId,
  evidenceHash: payload.evidenceHash, revisionId: payload.revisionId, ...extra }), { status: 200 });

test('digest contains actual fields, bounded evidence, stable hashes and missing values', async t => {
  const root = await fixture(t);
  const a = await getRecallDigest({ root, slug: 'two-sum' });
  assert.equal(a.problems[0].chats[0].ask, 'Why does this fail?');
  assert.match(a.problems[0].runs[0].data, /"passed":0/);
  assert.equal(a.problems[0].missing.failingCases, true);
  assert.equal(a.evidenceHash, (await getRecallDigest({ root, slug: 'two-sum' })).evidenceHash);
  assert.ok(JSON.stringify(a).length < 30000);
  await assert.rejects(getRecallDigest({ root, slug: '../outside' }));
});
test('one pattern accumulates sources across problems, preserves revisions and deduplicates exact retries', async t => {
  const root = await fixture(t);
  await saveRecallNote({ root, ...note });
  await saveRecallNote({ root, ...note });
  assert.equal((await readRecallState(root)).outbox.items.length, 1);
  await saveRecallNote({ root, ...note, slug: 'three-sum', trap: 'An inferred trap.' });
  const box = (await readRecallState(root)).outbox;
  assert.equal(box.items.length, 2);
  assert.equal(box.items[1].payload.author, 'tutor');
  assert.equal(box.items[1].payload.sources.length, 2);
  assert.ok(box.items[1].payload.sources.some(s => s.url === 'http://127.0.0.1:4173/#/p/two-sum'));
  const digest = await getRecallDigest({ root, slug: 'three-sum', patternId: note.patternId });
  assert.equal(digest.problems.length, 2);
  assert.equal(digest.existingPatterns[0].patternId, note.patternId);
});
test('concurrent patterns and generations cannot lose queued records', async t => {
  const root = await fixture(t);
  await Promise.all(['one', 'two', 'three'].map(patternId => saveRecallNote({ root, ...note, patternId })));
  assert.equal((await readRecallState(root)).outbox.items.length, 3);
});
test('offline restart retries immutable revisions in order, with auth and matching acknowledgments', async t => {
  const root = await fixture(t);
  await saveRecallNote({ root, ...note });
  await saveRecallNote({ root, ...note, body: 'A revision.' });
  process.env.STUDYCRAFT_RECALL_TOKEN = 'fake-token';
  try {
    const seen = [];
    const result = await flushRecall(root, { force: true, fetchImpl: async (url, req) => {
      assert.equal(url, process.env.STUDYCRAFT_RECALL_URL);
      assert.equal(req.headers.authorization, 'Bearer fake-token');
      assert.equal(req.redirect, 'error'); assert.ok(req.signal);
      const payload = JSON.parse(req.body); seen.push(payload); return reply(payload, { status: seen.length === 2 ? 'conflict' : 'created' });
    } });
    assert.deepEqual(result.map(r => r.status), ['saved', 'saved']);
    assert.equal(result[1].conflict, true);
    assert.equal((await readRecallState(root)).mapping[note.patternId].noteId, 'note-1');
    await enqueueRecall(root, seen[1], { fetchImpl: () => { throw Error('must not resend confirmed revision'); } });
    assert.equal((await readRecallState(root)).outbox.items.length, 2);
  } finally { process.env.STUDYCRAFT_RECALL_TOKEN = ''; }
});
test('malformed, mismatched and 409 replies stay pending; remote endpoints are refused', async t => {
  const root = await fixture(t); await saveRecallNote({ root, ...note });
  process.env.STUDYCRAFT_RECALL_TOKEN = 'fake-token';
  try {
    for (const fetchImpl of [
      async () => new Response('{}'),
      async (_url, req) => reply(JSON.parse(req.body), { revisionId: 'wrong' }),
      async () => new Response('{}', { status: 409 }),
      async () => { throw Error('offline'); },
    ]) assert.equal((await flushRecall(root, { force: true, fetchImpl }))[0].status, 'pending');
  } finally { process.env.STUDYCRAFT_RECALL_TOKEN = ''; }
  for (const url of ['https://example.com/api/recall/import', 'http://localhost/api/recall/import', 'http://127.0.0.1/api/recall/import?x=1', 'http://u:p@127.0.0.1/api/recall/import']) assert.equal(validRecallUrl(url), false);
});


test('a later revision cannot remap an existing pattern to a duplicate note', async t => {
  const root = await fixture(t);
  await saveRecallNote({ root, ...note });
  process.env.STUDYCRAFT_RECALL_TOKEN = 'fake-token';
  try {
    await flushRecall(root, { force: true, fetchImpl: async (_url, req) => reply(JSON.parse(req.body)) });
  } finally { process.env.STUDYCRAFT_RECALL_TOKEN = ''; }
  await saveRecallNote({ root, ...note, body: 'New revision.' });
  process.env.STUDYCRAFT_RECALL_TOKEN = 'fake-token';
  try {
    const result = await flushRecall(root, { force: true, fetchImpl: async (_url, req) => reply(JSON.parse(req.body), { noteId: 'duplicate-note' }) });
    assert.equal(result[0].status, 'pending');
    assert.equal((await readRecallState(root)).mapping[note.patternId].noteId, 'note-1');
  } finally { process.env.STUDYCRAFT_RECALL_TOKEN = ''; }
});
