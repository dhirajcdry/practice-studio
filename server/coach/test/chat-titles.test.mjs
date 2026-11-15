// Chat titles: the rules, where Studio keeps them, how the list shows named and unnamed
// chats, the coach's name_chat tool over both providers, the learner's rename, and that
// adding the tool changes nothing for mocks or for the transcript.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateChatTitle, fallbackChatTitle, readChatTitles, setChatTitle, displayTitle, titlesFile, TITLE_MAX } from '../chat-titles.mjs';
import { ActionStore, TOOL_SPECS, TOOL_NAMES, createToolSession, validateArgs, toolDisplay } from '../tools.mjs';
import { CoachRuns } from '../runs.mjs';
import { routes, CoachService } from '../routes.mjs';
import { appendTurn, chatFile, readTurns } from '../transcript.mjs';
import { createWorkspaceTools } from '../workspace-tools.mjs';
import { ABILITIES_GUIDE } from '../context.mjs';
import { beginConversation, buildConversation } from '../native-sessions.mjs';
import { HttpError, sendError } from '../../http-util.mjs';
import { permissionArgs } from '../claude-cli.mjs';
import { workspace } from './tools-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(HERE, 'bin', 'fake-claude.mjs');
const FAKE_CODEX = path.join(HERE, 'bin', 'fake-codex.mjs');

// ------------------------------------------------------------------ rules

test('a title is one plain line of 3 to 60 characters', () => {
  assert.deepEqual(validateChatTitle('  Hints on   the two-pointer bug '), { ok: true, title: 'Hints on the two-pointer bug' });
  assert.deepEqual(validateChatTitle('"Why a hash map"'), { ok: true, title: 'Why a hash map' });
  for (const bad of ['', 'ab', 'x'.repeat(TITLE_MAX + 1), 'Two\nlines', '**Bold** title', 'Use `dict` here', '# Heading', '<b>html</b>', '[link](x)', 42, null]) {
    assert.equal(validateChatTitle(bad).ok, false, String(bad));
  }
  assert.equal(validateChatTitle('x'.repeat(TITLE_MAX)).ok, true);
});

test('an unnamed chat is labelled by its tidied first question, never more', () => {
  assert.equal(fallbackChatTitle('help me with this.. just minor hints.. what am i doing incorrect here?'),
    'Help me with this. Just minor hints. What am i doing…');
  assert.equal(fallbackChatTitle('why   a\n\nhash map?'), 'Why a hash map?');
  assert.equal(fallbackChatTitle('what does this do?\n```python\nfor i in range(10):\n    pass\n```\nthanks'), 'What does this do? Thanks');
  assert.equal(fallbackChatTitle('is `seen` the right name???'), 'Is seen the right name?');
  assert.equal(fallbackChatTitle('```python\nx = 1\n```'), '');
  const long = fallbackChatTitle('I am struggling to understand how these overlapping intervals should merge, especially when');
  assert.ok(long.length <= 60, long);
  assert.ok(long.endsWith('…'));
  assert.ok(!/\s…$/.test(long), 'cut at a word boundary, without a dangling space');
  // Every word in the label is a word the learner wrote.
  const source = 'how these overlapping intervals should merge especially when'.split(' ');
  for (const word of long.replace('…', '').toLowerCase().split(/\W+/).filter(Boolean)) assert.ok(['i', 'am', 'struggling', 'to', 'understand', ...source].includes(word), word);
});

test('the list title prefers a saved name, then the first question, then the kind of chat', () => {
  const thread = { sessionId: 's1', turns: [{ ask: '' , kind: 'attempt-review' }, { ask: 'and now?' }] };
  assert.deepEqual(displayTitle(thread, { s1: { title: 'Reviewing the greedy attempt', by: 'coach' } }), { title: 'Reviewing the greedy attempt', titleSource: 'coach' });
  assert.deepEqual(displayTitle(thread, {}), { title: 'And now?', titleSource: 'message' });
  assert.deepEqual(displayTitle({ sessionId: null, turns: [{ ask: '', kind: 'attempt-review' }] }), { title: 'Attempt review', titleSource: 'message' });
  assert.deepEqual(displayTitle({ sessionId: 's2', turns: [{ ask: '```py\nx\n```' }] }), { title: 'Code question', titleSource: 'message' });
});

// ------------------------------------------------------------------ storage

test('titles live beside the transcript, atomically, and a learner title is kept from the coach', async t => {
  const w = await workspace(); t.after(w.cleanup);
  await appendTurn({ root: w.root, slug: 'two-sum', turn: { sessionId: 's1', ask: 'why a hash map?', answer: 'Lookups.' } });
  const before = await fsp.readFile(chatFile(w.root, 'two-sum'), 'utf8');

  assert.deepEqual(await readChatTitles(w.root, 'two-sum'), {});
  const first = await setChatTitle(w.root, 'two-sum', 's1', 'Why a hash map', { by: 'coach' });
  assert.deepEqual({ ok: first.ok, changed: first.changed, title: first.title }, { ok: true, changed: true, title: 'Why a hash map' });
  assert.equal((await setChatTitle(w.root, 'two-sum', 's1', 'Why a hash map', { by: 'coach' })).changed, false);
  assert.equal((await readChatTitles(w.root, 'two-sum')).s1.by, 'coach');

  const mine = await setChatTitle(w.root, 'two-sum', 's1', 'My hash map question', { by: 'learner' });
  assert.equal(mine.ok, true);
  const refused = await setChatTitle(w.root, 'two-sum', 's1', 'Something else', { by: 'coach' });
  assert.equal(refused.ok, false); assert.equal(refused.status, 409); assert.match(refused.message, /Keep their title/);
  assert.deepEqual((await readChatTitles(w.root, 'two-sum')).s1.title, 'My hash map question');

  assert.equal((await setChatTitle(w.root, 'two-sum', 'orphan:2026', 'Nope', {})).ok, false);
  assert.equal((await setChatTitle(w.root, 'two-sum', 's1', 'x', {})).status, 400);

  // Concurrent writes serialize: neither name is lost.
  await Promise.all([setChatTitle(w.root, 'two-sum', 'a', 'Title A'), setChatTitle(w.root, 'two-sum', 'b', 'Title B')]);
  const all = await readChatTitles(w.root, 'two-sum');
  assert.equal(all.a.title, 'Title A'); assert.equal(all.b.title, 'Title B');
  assert.deepEqual((await fsp.readdir(path.dirname(titlesFile(w.root, 'two-sum')))).filter(name => name.endsWith('.tmp')), []);

  // The transcript itself is never rewritten.
  assert.equal(await fsp.readFile(chatFile(w.root, 'two-sum'), 'utf8'), before);
  // A damaged file is no titles, not a failure.
  await fsp.writeFile(titlesFile(w.root, 'two-sum'), '{nope');
  assert.deepEqual(await readChatTitles(w.root, 'two-sum'), {});
});

test('the coach can never write the titles file itself; only Studio does', () => {
  const { allow, deny } = permissionArgs('/ws');
  for (const tool of ['Write', 'Edit']) assert.ok(deny.includes(`${tool}(//ws/tracks/*/problems/*/chat-titles.json)`), tool);
  assert.ok(!allow.some(rule => rule.includes('chat-titles')));
});

// ------------------------------------------------------------------ the tool

function toolSession(root, capabilities) {
  const runs = new CoachRuns();
  const run = runs.start({ slug: 'two-sum' });
  const events = [];
  run.subscribers.add({ action: payload => events.push(payload), token() {}, tool() {}, done() {}, end() {}, error() {}, send() {} });
  return { tools: createToolSession({ root, slug: 'two-sum', store: new ActionStore(), runs, run, log: { warn() {} }, capabilities }), events };
}

test('name_chat is one validated tool whose action is quiet: no receipt card, no activity claim', async t => {
  const w = await workspace(); t.after(w.cleanup);
  const spec = TOOL_SPECS.find(s => s.name === 'name_chat');
  assert.ok(spec && TOOL_NAMES.includes('name_chat'));
  assert.equal(spec.inputSchema.properties.title.maxLength, TITLE_MAX);
  assert.deepEqual(spec.inputSchema.required, ['title']);
  assert.equal(validateArgs('name_chat', { title: 'x'.repeat(61) }).ok, false);
  assert.equal(validateArgs('name_chat', { title: 'Fine', extra: 1 }).ok, false);
  assert.equal(toolDisplay('mcp__studio__name_chat').effect, 'meta');
  assert.match(ABILITIES_GUIDE, /name_chat/);

  // Without a chat to name (any workspace other than the coding chat) it refuses.
  const bare = toolSession(w.root, {});
  assert.equal((await bare.tools.call('name_chat', { title: 'Hints on the bug' })).ok, false);

  const { tools, events } = toolSession(w.root, { nameChat: title => setChatTitle(w.root, 'two-sum', 'chat-1', title, { by: 'coach' }).then(r => ({ ...r, sessionId: 'chat-1' })) });
  const bad = await tools.call('name_chat', { title: '**Bold**' });
  assert.equal(bad.ok, false); assert.match(bad.text, /plain words/);
  const ok = await tools.call('name_chat', { title: 'Hints on the two-pointer bug' });
  assert.equal(ok.ok, true);
  assert.equal((await readChatTitles(w.root, 'two-sum'))['chat-1'].title, 'Hints on the two-pointer bug');
  const again = await tools.call('name_chat', { title: 'Hints on the two-pointer bug' });
  assert.match(again.text, /already titled/);
  await tools.flush();
  assert.equal(events.length, 1, 'one action for the change, none for the repeat');
  assert.equal(events[0].chatTitle, 'Hints on the two-pointer bug');
  assert.equal(events[0].sessionId, 'chat-1');

  // The page draws no card for it, and the activity line claims nothing.
  globalThis.location ??= { search: '', hostname: '127.0.0.1', origin: 'http://127.0.0.1' };
  const { changeCards } = await import('../../../web/js/ui/turn-changes.js');
  const { activitySummary, isNoteOnlyReply } = await import('../../../web/js/ui/turn.js');
  assert.deepEqual(changeCards([{ ...events[0], display: toolDisplay('name_chat') }]), []);
  assert.equal(activitySummary([{ effect: 'meta' }]), '');
  assert.equal(isNoteOnlyReply({ text: '', activity: [{ effect: 'meta' }] }), false);
});

test('mocks and practice never see name_chat, so their tool signatures are unchanged', async t => {
  const w = await workspace(); t.after(w.cleanup);
  for (const kind of ['coding', 'board', 'review', 'code']) for (const liveMock of [false, true]) {
    const tools = await createWorkspaceTools({ root: w.root, slug: 'two-sum', kind, liveMock, getState: async () => ({}), runCode: async () => ({}), sessionContext: {}, setProblem: async () => ({}) });
    try {
      assert.ok(!tools.options.toolSpecs.some(s => s.name === 'name_chat'), `${kind} ${liveMock}`);
      assert.equal((await tools.options.toolSession.call('name_chat', { title: 'Sneaky title' })).ok, false);
    } finally { await tools.dispose(); }
  }
});

test('the coding chat resumes the same native segment across turns with the new tool list', async t => {
  const w = await workspace(); t.after(w.cleanup);
  const choice = { provider: 'claude', model: 'default' };
  const conversation = n => buildConversation({ key: 'coding:two-sum:chat-1', requestId: `r${n}`, message: `q${n}`, context: [['Problem', { slug: 'two-sum' }]], bootstrap: { instructions: ABILITIES_GUIDE, sections: [] } });
  const one = await beginConversation({ root: w.root, conversation: conversation(1), choice, systemPrompt: 'coach', toolSpecs: TOOL_SPECS });
  assert.equal(one.metadata.resumed, false);
  await one.nativeId('native-1');
  await one.complete();
  // A title change is not context: naming between turns cannot force a new segment.
  await setChatTitle(w.root, 'two-sum', 'chat-1', 'Hints on the two-pointer bug');
  const two = await beginConversation({ root: w.root, conversation: conversation(2), choice, systemPrompt: 'coach', toolSpecs: TOOL_SPECS });
  try {
    assert.equal(two.metadata.resumed, true);
    assert.equal(two.metadata.reason, null);
    assert.equal(two.resumeSessionId, 'native-1');
    assert.ok(!two.prompt.includes('Hints on the two-pointer bug'), 'the title is never sent back to the model');
  } finally { await two.complete(); }
});

// ------------------------------------------------------------------ routes, both providers

function serverFor(coach) {
  const table = Object.entries(routes).map(([key, handler]) => { const [method, pattern] = key.split(' '); return { method, parts: pattern.split('/').filter(Boolean), handler }; });
  return http.createServer((req, res) => {
    const segments = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean);
    for (const route of table) {
      if (route.method !== req.method || route.parts.length !== segments.length) continue;
      const params = {};
      if (!route.parts.every((p, i) => (p.startsWith(':') ? (params[p.slice(1)] = segments[i], true) : p === segments[i]))) continue;
      Promise.resolve(route.handler(req, res, { coach, params })).catch(err => {
        if (res.headersSent) return res.end();
        if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
        return sendError(res, 500, 'INTERNAL_ERROR', String(err));
      });
      return;
    }
    sendError(res, 404, 'NOT_FOUND', 'no such route');
  });
}
async function fixture(t, { provider = 'claude', env = {} } = {}) {
  const w = await workspace(); t.after(w.cleanup);
  await fsp.writeFile(path.join(w.root, 'coach-settings.json'), JSON.stringify(provider === 'codex' ? { provider: 'codex', model: 'gpt-6-astra' } : { provider: 'claude', model: 'default' }));
  const coach = new CoachService({ root: w.root, binary: FAKE_CLAUDE, timeoutMs: 15_000, log: { warn() {}, error() {}, info() {} }, env: { ...process.env, ...env } });
  const server = serverFor(coach);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  return { root: w.root, base: `http://127.0.0.1:${server.address().port}` };
}
async function events(response) {
  const out = []; const decoder = new TextDecoder(); let buf = '';
  for await (const chunk of response.body) {
    buf += decoder.decode(chunk, { stream: true }); let end;
    while ((end = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, end); buf = buf.slice(end + 2);
      const name = block.split('\n').find(l => l.startsWith('event: '))?.slice(7);
      if (name) out.push({ event: name, data: JSON.parse(block.split('\n').filter(l => l.startsWith('data: ')).map(l => l.slice(6)).join('\n')) });
    }
  }
  return out;
}
const ask = (base, message, extra = {}) => fetch(`${base}/api/coach/message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'two-sum', message, ...extra }) });
const history = async base => (await fetch(`${base}/api/problems/two-sum/history`)).json();

for (const provider of ['claude', 'codex']) {
  test(`${provider}: the coach names the chat during an ordinary turn, and the list shows it`, async t => {
    const calls = JSON.stringify([{ tool: 'name_chat', arguments: { title: 'Hints on the two-pointer bug' } }]);
    let env;
    if (provider === 'codex') {
      const prior = process.env.STUDIO_CODEX_BINARY; process.env.STUDIO_CODEX_BINARY = FAKE_CODEX;
      t.after(() => { if (prior === undefined) delete process.env.STUDIO_CODEX_BINARY; else process.env.STUDIO_CODEX_BINARY = prior; });
      env = { FAKE_CODEX_TOOL_CALLS: calls };
    } else env = { FAKE_CLAUDE_MODE: 'tools', FAKE_CLAUDE_TOOL_CALLS: calls };
    const f = await fixture(t, { provider, env });

    const seen = await events(await ask(f.base, 'help me with this.. just minor hints.. what am i doing incorrect here?'));
    assert.equal(seen.at(-1).event, 'done', JSON.stringify(seen.at(-1)));
    const action = seen.find(e => e.event === 'action')?.data;
    assert.equal(action.tool, 'name_chat');
    assert.equal(action.chatTitle, 'Hints on the two-pointer bug');
    const [turn] = await readTurns({ root: f.root, slug: 'two-sum' });
    assert.equal(action.sessionId, turn.sessionId, 'the title belongs to the chat the turn was filed under');
    // The raw transcript is unchanged in shape: the ask is the learner's own words.
    assert.equal(turn.ask, 'help me with this.. just minor hints.. what am i doing incorrect here?');

    const listed = await history(f.base);
    assert.equal(listed.threads[0].title, 'Hints on the two-pointer bug');
    assert.equal(listed.threads[0].titleSource, 'coach');
    assert.equal(listed.threads[0].turns[0].actions[0].display.effect, 'meta');
  });
}

test('the history lists unnamed chats by their cleaned first question, and the learner can rename', async t => {
  const f = await fixture(t, { env: { FAKE_CLAUDE_MODE: 'ok' } });
  await appendTurn({ root: f.root, slug: 'two-sum', turn: { sessionId: 'old-chat', ask: 'help me with this.. just minor hints..', answer: 'Look at line 3.', at: '2026-10-18T21:17:00Z' } });
  let listed = await history(f.base);
  assert.equal(listed.threads[0].title, 'Help me with this. Just minor hints');
  assert.equal(listed.threads[0].titleSource, 'message');

  const put = (id, title) => fetch(`${f.base}/api/problems/two-sum/chats/${id}/title`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title }) });
  const renamed = await put('old-chat', 'Line 3 off-by-one');
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), { ok: true, sessionId: 'old-chat', title: 'Line 3 off-by-one', titleSource: 'learner' });
  listed = await history(f.base);
  assert.equal(listed.threads[0].title, 'Line 3 off-by-one');
  assert.equal(listed.threads[0].titleSource, 'learner');
  assert.equal((await put('old-chat', '*no*')).status, 400);
  assert.equal((await put('missing-chat', 'A fine title')).status, 404);
  // The transcript still holds what was said.
  assert.equal((await readTurns({ root: f.root, slug: 'two-sum' }))[0].ask, 'help me with this.. just minor hints..');
});
