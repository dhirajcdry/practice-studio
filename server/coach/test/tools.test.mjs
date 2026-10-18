// The tutor's Studio tools: validation, case changes and undo, run_code through the real
// local runner, the browser round trip, both provider transports, and the prompt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { ActionStore, TOOL_SPECS, TOOL_NAMES, createToolSession, validateArgs, expectedToText } from '../tools.mjs';
import { CoachRuns } from '../runs.mjs';
import { SessionLog } from '../sessions.mjs';
import { readCases, writeCases } from '../../runner/cases.mjs';
import { buildArgs } from '../claude-cli.mjs';
import { runCoachTurn } from '../codex-cli.mjs';
import { gatherContext, buildPrompt } from '../context.mjs';
import { statementText } from '../problem-cache.mjs';
import { workspace } from './tools-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CODEX = path.join(HERE, 'bin', 'fake-codex.mjs');
const STUDIO_MCP = path.join(HERE, '..', 'studio-mcp.mjs');

function session(root, extra = {}) {
  const store = extra.store ?? new ActionStore();
  const runs = extra.runs ?? new CoachRuns();
  const run = extra.run ?? runs.start({ slug: 'two-sum' });
  const sessionLog = new SessionLog({ root });
  const tools = createToolSession({ root, slug: 'two-sum', store, runs, run, sessionLog, log: { warn() {} }, ...extra });
  return { tools, store, runs, run, sessionLog };
}

/** A viewer that records every SSE event the run sends it. */
function viewer() {
  const events = [];
  return {
    events,
    send: (event, data) => events.push({ event, data }),
    token() {}, tool() {}, done() {}, end() {}, error() {},
    action(payload) { events.push({ event: 'action', data: payload }); },
  };
}

// ------------------------------------------------------------------- validation

test('every spec is a closed object schema with a description', () => {
  assert.equal(TOOL_SPECS.length, 13);
  for (const spec of TOOL_SPECS) {
    assert.equal(spec.inputSchema.type, 'object');
    assert.equal(spec.inputSchema.additionalProperties, false);
    assert.ok(spec.description.length > 40, spec.name);
  }
});

test('arguments are checked for names, types, sizes and ranges', () => {
  assert.match(validateArgs('nope', {}).message, /no Studio tool/);
  assert.match(validateArgs('add_case', { input: [1, 2] }).message, /"why" is required/);
  assert.match(validateArgs('add_case', { input: 'x', why: 'w' }).message, /must be an object or an array/);
  assert.match(validateArgs('add_case', { input: [1], why: 'w', extra: 1 }).message, /not an argument/);
  assert.match(validateArgs('add_case', { input: [new Array(5000).fill(12345)], why: 'w' }).message, /20 KB/);
  assert.match(validateArgs('remove_case', { case: 0 }).message, /at least 1/);
  assert.match(validateArgs('remove_case', { case: 1.5 }).message, /whole number/);
  assert.match(validateArgs('mark_lines', { from: 5, to: 3, note: 'n' }).message, /before/);
  assert.match(validateArgs('mark_lines', { from: 1, note: 'n', tone: 'loud' }).message, /one of: hint, bug, good/);
  assert.match(validateArgs('save_note', { text: 'x'.repeat(4001) }).message, /limit is 4000/);
  assert.match(validateArgs('edit_code', { find: 'a'.repeat(20_001), replace: '', why: 'w' }).message, /limit is 20000/);
  assert.equal(validateArgs('run_code', {}).ok, true);
  assert.equal(validateArgs('get_state', undefined).ok, true);
});

test('expected values are stored as JSON text', () => {
  assert.equal(expectedToText([0, 1]).text, '[0,1]');
  assert.equal(expectedToText('[0, 1]').text, '[0, 1]');
  assert.equal(expectedToText('bab').text, '"bab"');
  assert.equal(expectedToText(true).text, 'true');
  assert.equal(expectedToText(null).text, null);
  assert.equal(expectedToText(undefined).text, undefined);
});

// ------------------------------------------------------------------- cases

test('add, update and remove a case; examples stay read-only; each change is announced', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools, runs, run } = session(w.root);
  const seen = viewer();
  runs.attach(run, seen);

  const added = await tools.call('add_case', { input: { nums: [], target: 0 }, why: 'Empty input: what does it return?' });
  assert.equal(added.ok, true, added.text);
  assert.match(added.text, /Added Case 3: nums = \[\]; target = 0/);
  let stored = await readCases({ root: w.root, slug: 'two-sum' });
  assert.deepEqual(stored.map((c) => [c.input, c.expected, c.source, c.note]), [['[]\n0', null, 'coach', 'Empty input: what does it return?']]);

  const action = seen.events.find((e) => e.event === 'action').data;
  assert.equal(action.tool, 'add_case');
  assert.equal(action.needsAck, false);
  assert.equal(action.refresh, 'cases');
  assert.equal(action.select, 3);
  assert.equal(action.undo, 'server');
  assert.equal(action.status, 'done');
  assert.equal(action.slug, 'two-sum');
  assert.match(action.id, /^act-/);

  assert.match((await tools.call('add_case', { input: [[], 0], why: 'again' })).text, /Case 3 already has exactly that input/);
  assert.match((await tools.call('add_case', { input: [[1]], why: 'w' })).text, /takes 2 values/);
  assert.match((await tools.call('add_case', { input: { nums: [1] }, why: 'w' })).text, /exactly these parameters: nums, target/);

  assert.match((await tools.call('update_case', { case: 1, expected: [9] })).text, /LeetCode example, and examples are read-only/);
  assert.match((await tools.call('remove_case', { case: 2 })).text, /read-only/);
  assert.match((await tools.call('remove_case', { case: 9 })).text, /There is no Case 9/);

  const updated = await tools.call('update_case', { case: 3, expected: [], why: 'Empty: no pair exists' });
  assert.equal(updated.ok, true, updated.text);
  stored = await readCases({ root: w.root, slug: 'two-sum' });
  assert.equal(stored[0].expected, '[]');
  assert.equal(stored[0].note, 'Empty: no pair exists');

  const removed = await tools.call('remove_case', { case: 3 });
  assert.equal(removed.ok, true);
  assert.deepEqual(await readCases({ root: w.root, slug: 'two-sum' }), []);
  assert.deepEqual(tools.actions.map((a) => [a.tool, a.ok]), [['add_case', true], ['update_case', true], ['remove_case', true]]);
});

test('undo of an older add preserves later cases', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeCases({ root: w.root, slug: 'two-sum', cases: [{ input: '[1,2]\n3', expected: '[0,1]', source: 'custom' }] });
  const { tools, store } = session(w.root);

  await tools.call('add_case', { input: [[5, 5], 10], expected: [0, 1], why: 'duplicates' });
  await tools.call('add_case', { input: [[1, 1, 1], 2], why: 'many duplicates' });
  const [first, second] = tools.actions;

  // An older add can be undone without discarding a later independent add.
  const older = await store.undo(first.id);
  assert.equal(older.status, 200);
  assert.deepEqual((await readCases({ root: w.root, slug: 'two-sum' })).map(c => c.input), ['[1,2]\n3', '[1,1,1]\n2']);

  const ok = await store.undo(second.id);
  assert.deepEqual(ok, { status: 200, body: { ok: true, refresh: 'cases' } });
  assert.equal((await store.undo(second.id)).status, 409);
  assert.deepEqual((await readCases({ root: w.root, slug: 'two-sum' })).map((c) => c.input), ['[1,2]\n3']);

  assert.equal((await store.undo('act-nope')).status, 404);
});

test('case undo restores updates and removals only when their target is unchanged', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeCases({ root: w.root, slug: 'two-sum', cases: [
    { input: '[1,2]\n3', expected: '[0,1]', source: 'custom', note: 'first' },
    { input: '[3,3]\n6', expected: '[0,1]', source: 'custom', note: 'second' },
  ] });
  const { tools, store } = session(w.root);

  const removed = await tools.call('remove_case', { case: 3 });
  assert.equal(removed.ok, true);
  const removeAction = tools.actions.at(-1);
  await tools.call('add_case', { input: [[9, 9], 18], why: 'later' });
  assert.equal((await store.undo(removeAction.id)).status, 200);
  assert.deepEqual((await readCases({ root: w.root, slug: 'two-sum' })).map((c) => c.input), ['[1,2]\n3', '[3,3]\n6', '[9,9]\n18']);

  const updated = await tools.call('update_case', { case: 3, why: 'changed' });
  const updateAction = tools.actions.at(-1);
  await tools.call('add_case', { input: [[7, 7], 14], why: 'independent' });
  assert.equal((await store.undo(updateAction.id)).status, 200);
  const afterUpdate = await readCases({ root: w.root, slug: 'two-sum' });
  assert.equal(updated.ok, true);
  assert.equal(afterUpdate[0].note, 'first');
  assert.equal(afterUpdate[2].note, 'later');

  const edited = await tools.call('update_case', { case: 3, why: 'edit me' });
  const editedAction = tools.actions.at(-1);
  await tools.call('update_case', { case: 3, why: 'learner edit' });
  const conflict = await store.undo(editedAction.id);
  assert.equal(conflict.status, 409);
  assert.match(conflict.body.message, /edited since/);
});

test('case undo rejects changed or duplicate targets and double undo has exact message', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools, store } = session(w.root);
  await tools.call('add_case', { input: [[4, 4], 8], why: 'duplicate target' });
  const action = tools.actions.at(-1);
  const cases = await readCases({ root: w.root, slug: 'two-sum' });
  await writeCases({ root: w.root, slug: 'two-sum', cases: [{ ...cases[0], note: 'learner edited' }] });
  assert.deepEqual(await store.undo(action.id), { status: 409, body: { ok: false, message: 'That case was already changed or removed, so there is nothing to undo.' } });

  const added = await tools.call('add_case', { input: [[5, 5], 10], why: 'remove me' });
  const addAction = tools.actions.at(-1);
  await tools.call('remove_case', { case: 4 });
  assert.equal((await store.undo(addAction.id)).status, 409);

  await tools.call('add_case', { input: [[6, 6], 12], why: 'twice' });
  const twice = tools.actions.at(-1);
  assert.equal((await store.undo(twice.id)).status, 200);
  const second = await store.undo(twice.id);
  assert.equal(second.status, 409);
  assert.equal(second.body.message, 'That change was already undone.');
});

test('case undo chooses the last identical add and guards duplicate remove restoration', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const options = { root: w.root, slug: 'two-sum' };
  const { tools, store } = session(w.root);
  await tools.call('add_case', { input: [[4, 4], 8], why: 'same' });
  const action = tools.actions.at(-1);
  const [original] = await readCases(options);
  const duplicate = { ...original, at: 'different timestamp' };
  await writeCases({ ...options, cases: [original, duplicate] });
  assert.equal((await store.undo(action.id)).status, 200);
  assert.deepEqual(await readCases(options), [original]);

  await tools.call('remove_case', { case: 3 });
  const removal = tools.actions.at(-1);
  await writeCases({ ...options, cases: [duplicate] });
  assert.equal((await store.undo(removal.id)).status, 409);
  assert.deepEqual(await readCases(options), [duplicate]);
});

test('remove undo clamps the old index after other cases are deleted', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const options = { root: w.root, slug: 'two-sum' };
  const { tools, store } = session(w.root);
  await tools.call('add_case', { input: [[4, 4], 8], why: 'first' });
  await tools.call('add_case', { input: [[5, 5], 10], why: 'second' });
  const [, second] = await readCases(options);
  await tools.call('remove_case', { case: 4 });
  const removal = tools.actions.at(-1);
  await writeCases({ ...options, cases: [] });
  assert.equal((await store.undo(removal.id)).status, 200);
  assert.deepEqual(await readCases(options), [second]);
});

test('remove undo refuses a full list without dropping a later case', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const options = { root: w.root, slug: 'two-sum' };
  const { tools, store } = session(w.root);
  await tools.call('add_case', { input: [[4, 4], 8], why: 'removed' });
  await tools.call('remove_case', { case: 3 });
  const removal = tools.actions.at(-1);
  const full = await writeCases({ ...options, cases: Array.from({ length: 25 }, (_, i) => ({ input: `[${i}]\n0` })) });
  assert.equal((await store.undo(removal.id)).status, 409);
  assert.deepEqual(await readCases(options), full);
});

test('without a cached problem the case tools say why instead of guessing', async (t) => {
  const w = await workspace({ cached: false });
  t.after(w.cleanup);
  const { tools } = session(w.root);
  const r = await tools.call('add_case', { input: [[1], 1], why: 'w' });
  assert.equal(r.ok, false);
  assert.match(r.text, /no cached copy/);
});

test('get_state numbers the cases the way the learner sees them, with parameter names', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  await writeCases({ root: w.root, slug: 'two-sum', cases: [{ input: '[1,2]\n3', source: 'leetcode', note: 'from a WA' }] });
  const { tools } = session(w.root);
  const state = await tools.call('get_state', {});
  assert.equal(state.ok, true);
  assert.match(state.text, /Parameters, in order: nums, target/);
  assert.match(state.text, /Case 1 — example\n {2}nums = \[2,7,11,15\]; target = 9\n {2}expected: \[0,1\]/);
  assert.match(state.text, /Case 3 — failed submission: "from a WA"/);
  assert.match(state.text, /solution.py: last saved/);
  assert.match(state.text, /Your line marks: none/);
});

// ------------------------------------------------------------------- run_code

test('run_code runs the saved solution through the real runner and is logged as a tutor run', async (t) => {
  const w = await workspace({ solution: 'class Solution:\n    def twoSum(self, nums, target):\n        print("looking")\n        return [0, 1]\n' });
  t.after(w.cleanup);
  const { tools, runs, run, sessionLog } = session(w.root);
  const seen = viewer();
  runs.attach(run, seen);

  const r = await tools.call('run_code', {});
  assert.equal(r.ok, true, r.text);
  assert.match(r.text, /Ran the saved solution.py on 2 cases: 1 passed, 1 failed/);
  assert.match(r.text, /Case 2 — FAILED/);
  assert.match(r.text, /input: {4}nums = \[3,2,4\]; target = 6/);
  assert.match(r.text, /expected: \[1,2\]/);
  assert.match(r.text, /output: {3}\[0,1\]/);
  assert.match(r.text, /stdout: {3}looking/);

  const only = await tools.call('run_code', { cases: [2] });
  assert.match(only.text, /on 1 case: 0 passed, 1 failed/);
  assert.match(only.text, /Case 2 — FAILED/);
  assert.match((await tools.call('run_code', { cases: [7] })).text, /There is no Case 7/);

  const action = seen.events.filter((e) => e.event === 'action').at(-1).data;
  assert.equal(action.refresh, 'run');
  assert.deepEqual(action.caseNumbers, [2]);
  assert.equal(action.run.summary.total, 1);
  assert.equal(action.run.runId, action.id);

  // Never the learner's: no ran_locally, and the prompt counts them apart.
  const events = (await sessionLog.currentSessionEvents('two-sum')).events;
  assert.deepEqual(events.map((e) => e.type), ['coach_ran_code', 'coach_ran_code']);
  assert.deepEqual(events[1].data.cases, [2]);
  const context = await gatherContext({ root: w.root, slug: 'two-sum', sessionLog });
  assert.equal(context.runCount, 0);
  assert.equal(context.coachRunCount, 2);
  const { prompt } = buildPrompt({ context, message: 'hi' });
  assert.match(prompt, /Local runs this sitting: 0\nYour own run_code runs this sitting \(not his\): 2/);
  assert.match(prompt, /Last local run: none recorded/);
});

test('run_code with nothing saved says so', async (t) => {
  const w = await workspace({ solution: null });
  t.after(w.cleanup);
  const r = await session(w.root).tools.call('run_code', {});
  assert.equal(r.ok, false);
  assert.match(r.text, /no saved solution.py/);
});

// ------------------------------------------------------------------- browser round trip

test('a browser action waits for the page: answered ok, answered with a failure, or not open', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools, store, runs, run, sessionLog } = session(w.root, { ackTimeoutMs: 80 });

  // Nobody watching: refused at once, never a 15-second hang.
  const alone = await tools.call('mark_lines', { from: 3, note: 'look here' });
  assert.deepEqual(alone, { ok: false, text: 'Studio is not open on this problem, so the lines were not marked.' });

  const seen = viewer();
  runs.attach(run, seen);
  const answerNext = (body) => {
    const timer = setInterval(() => {
      const pending = seen.events.filter((e) => e.event === 'action' && e.data.status === 'pending').at(-1);
      if (pending && store.answer(pending.data.id, body) === 'accepted') clearInterval(timer);
    }, 2);
  };

  answerNext({ ok: true, message: '' });
  const marked = await tools.call('mark_lines', { from: 3, to: 4, note: 'the bug', tone: 'bug' });
  assert.equal(marked.ok, true);
  assert.match(marked.text, /Marked lines 3–4/);
  // On attach the earlier refusal replays as a failed receipt; this one goes pending → done.
  const all = seen.events.filter((e) => e.event === 'action' && e.data.tool === 'mark_lines');
  assert.equal(all[0].data.status, 'failed');
  const sent = all.filter((e) => e.data.id === all.at(-1).data.id);
  assert.deepEqual(sent.map((e) => e.data.status), ['pending', 'done']);
  assert.equal(sent[0].data.needsAck, true);
  assert.deepEqual(sent[0].data.args, { from: 3, to: 4, note: 'the bug', tone: 'bug' });
  assert.equal(store.answer(sent[0].data.id, { ok: true }), 'settled');
  assert.match((await tools.call('get_state', {})).text, /lines 3–4 \(bug\) "the bug"/);

  answerNext({ ok: false, message: 'That text does not occur in the editor.' });
  const failed = await tools.call('edit_code', { find: 'x = 1', replace: 'x = 2', why: 'fix' });
  assert.deepEqual(failed, { ok: false, text: 'Studio could not do that: That text does not occur in the editor.' });

  answerNext({ ok: true, message: 'Saved.' });
  const edited = await tools.call('edit_code', { find: 'seen = {}', replace: 'seen = {}\n        # tutor', why: 'add a comment' });
  assert.equal(edited.ok, true);
  const logged = (await sessionLog.currentSessionEvents('two-sum')).events.find((e) => e.type === 'coach_edited_code');
  assert.deepEqual(logged.data, { why: 'add a comment', added: 2, removed: 1 });

  // Attached but silent: the answer window closes and the tool says Studio is not open.
  const silent = await tools.call('open_panel', { panel: 'solution' });
  assert.deepEqual(silent, { ok: false, text: 'Studio is not open on this problem, so the panel was not opened.' });

  // A page attaching later replays receipts with their final status, never as pending.
  const late = viewer();
  runs.attach(run, late);
  const replayed = late.events.filter((e) => e.event === 'action');
  assert.ok(replayed.length >= 4);
  assert.ok(replayed.every((e) => e.data.status !== 'pending'));
  assert.deepEqual(tools.actions.map((a) => [a.tool, a.ok]),
    [['mark_lines', false], ['mark_lines', true], ['edit_code', false], ['edit_code', true], ['open_panel', false]]);
});

test('ending the turn fails a pending action and refuses further calls', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools, runs, run } = session(w.root, { ackTimeoutMs: 10_000 });
  runs.attach(run, viewer());
  const waiting = tools.call('clear_marks', {});
  await new Promise((r) => setTimeout(r, 10));
  tools.dispose();
  assert.equal(run.actions[0].status, 'failed');
  assert.match((await waiting).text, /reply ended/);
  assert.match((await tools.call('get_state', {})).text, /reply has ended/);
});

test('more than 40 calls in one turn are refused', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools } = session(w.root);
  for (let i = 0; i < 40; i += 1) await tools.call('nope', {});
  assert.match((await tools.call('get_state', {})).text, /more than 40 Studio actions/);
});

test('save_note appends a dated entry to NOTES.md', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const { tools } = session(w.root);
  await tools.call('save_note', { text: 'Reaches for sorting first.' });
  await tools.call('save_note', { text: 'Second note.' });
  const notes = await fsp.readFile(path.join(w.root, 'problems', 'two-sum', 'NOTES.md'), 'utf8');
  assert.match(notes, /^# two-sum\n\n### \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(tutor note\)\nReaches for sorting first.\n\n### .*\nSecond note.\n$/);
});

// ------------------------------------------------------------------- Codex transport

test('Codex: dynamic tools on thread/start, item/tool/call answered through the session', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const threadFile = path.join(w.root, 'thread.json');
  const resultsFile = path.join(w.root, 'results.jsonl');
  const calls = [];
  const toolSession = { call: async (tool, args) => { calls.push([tool, args]); return { ok: ['get_state', 'get_submissions'].includes(tool), text: `${tool} result` }; } };
  const tools = [];
  let reply = '';
  const turn = runCoachTurn({
    prompt: 'q', binary: FAKE_CODEX, toolSession, toolSpecs: TOOL_SPECS,
    env: { ...process.env, FAKE_CODEX_THREAD_FILE: threadFile, FAKE_CODEX_TOOL_RESULTS_FILE: resultsFile,
      FAKE_CODEX_TOOL_CALLS: JSON.stringify([{ tool: 'get_state', arguments: {} }, { tool: 'get_submissions', arguments: { submission_id: '12' } }, { tool: 'add_case', arguments: { input: [[1], 1], why: 'tiny' } }]) },
    onToken: (text) => { reply += text; }, onTool: (name, summary) => tools.push([name, summary]),
  });
  await turn.exited;
  const thread = JSON.parse(await fsp.readFile(threadFile, 'utf8'));
  assert.deepEqual(thread.dynamicTools.map((d) => d.name), TOOL_NAMES);
  assert.equal(thread.dynamicTools[0].type, 'function');
  assert.ok(thread.dynamicTools.find(t => t.name === 'add_case').inputSchema.properties.input);
  assert.match(thread.baseInstructions, /only tools you may use are the Studio tools/);
  assert.ok(thread.config.mcp_servers, 'the MCP lockdown is still applied');

  const responses = (await fsp.readFile(resultsFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(responses[0].result, { success: true, contentItems: [{ type: 'inputText', text: 'get_state result' }] });
  assert.equal(responses[1].result.success, true);
  assert.equal(responses[2].result.success, false);
  assert.deepEqual(calls, [['get_state', {}], ['get_submissions', { submission_id: '12' }], ['add_case', { input: [[1], 1], why: 'tiny' }]]);
  assert.deepEqual(tools, [['get_state', ''], ['get_submissions', '12'], ['add_case', 'tiny']]);
  assert.match(reply, /Tools said: get_state result \| get_submissions result \| add_case result/);
});

test('Codex without a tool session still rejects tool calls and sends no dynamic tools', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const threadFile = path.join(w.root, 'thread.json');
  const resultsFile = path.join(w.root, 'results.jsonl');
  const turn = runCoachTurn({
    prompt: 'q', binary: FAKE_CODEX,
    env: { ...process.env, FAKE_CODEX_THREAD_FILE: threadFile, FAKE_CODEX_TOOL_RESULTS_FILE: resultsFile,
      FAKE_CODEX_TOOL_CALLS: JSON.stringify([{ tool: 'get_state', arguments: {} }]) },
  });
  await turn.exited;
  const thread = JSON.parse(await fsp.readFile(threadFile, 'utf8'));
  assert.equal(thread.dynamicTools, undefined);
  const [response] = (await fsp.readFile(resultsFile, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(response.error.code, -32601);
});

// ------------------------------------------------------------------- Claude transport

test('Claude: --mcp-config and one mcp__studio__ allow per tool, all other rules intact', () => {
  const plain = buildArgs({ root: '/tmp/ws', resumeSessionId: null, newSessionId: 'id', tools: 'Read,Glob' });
  const args = buildArgs({ root: '/tmp/ws', resumeSessionId: null, newSessionId: 'id', tools: 'Read,Glob', mcpConfigPath: '/tmp/x/mcp.json', studioTools: TOOL_NAMES });
  assert.ok(!plain.includes('--mcp-config'));
  assert.ok(!plain.some((a) => a.startsWith('mcp__')));
  assert.equal(args[args.indexOf('--mcp-config') + 1], '/tmp/x/mcp.json');
  assert.ok(args.includes('--strict-mcp-config'));
  const allowAt = args.indexOf('--allowedTools');
  const denyAt = args.indexOf('--disallowedTools');
  const allowed = args.slice(allowAt + 1, denyAt);
  for (const name of TOOL_NAMES) assert.ok(allowed.includes(`mcp__studio__${name}`), name);
  assert.deepEqual(args.slice(denyAt), plain.slice(plain.indexOf('--disallowedTools')));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
});

test('studio-mcp speaks MCP over stdio and forwards calls with its token', async (t) => {
  const seen = [];
  const stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ url: req.url, ...parsed });
      if (parsed.token !== 'tok') { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"message":"no"}}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: parsed.tool === 'get_state', text: `did ${parsed.tool}` }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => stub.close(r)));
  const url = `http://127.0.0.1:${stub.address().port}/api/coach/tools/call`;

  async function converse(token, messages) {
    const child = spawn(process.execPath, [STUDIO_MCP], { env: { ...process.env, STUDIO_TOOLS_URL: url, STUDIO_TOOLS_TOKEN: token }, stdio: ['pipe', 'pipe', 'inherit'] });
    const replies = [];
    let buf = '';
    const wanted = messages.filter((m) => m.id !== undefined).length;
    const done = new Promise((resolve) => {
      child.stdout.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) !== -1) {
          replies.push(JSON.parse(buf.slice(0, nl)));
          buf = buf.slice(nl + 1);
          if (replies.length === wanted) resolve();
        }
      });
    });
    for (const m of messages) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    await done;
    child.kill();
    return Object.fromEntries(replies.map((r) => [r.id, r]));
  }

  const r = await converse('tok', [
    { id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } } },
    { method: 'notifications/initialized' },
    { id: 2, method: 'tools/list', params: {} },
    { id: 3, method: 'tools/call', params: { name: 'get_state', arguments: {} } },
    { id: 4, method: 'tools/call', params: { name: 'add_case', arguments: { input: [[1], 1], why: 'w' } } },
    { id: 5, method: 'ping' },
    { id: 6, method: 'resources/list' },
  ]);
  assert.equal(r[1].result.protocolVersion, '2025-03-26');
  assert.deepEqual(r[1].result.capabilities, { tools: {} });
  assert.equal(r[1].result.serverInfo.name, 'studio');
  assert.deepEqual(r[2].result.tools.map((x) => x.name), TOOL_NAMES);
  assert.equal(r[2].result.tools[1].inputSchema.additionalProperties, false);
  assert.deepEqual(r[3].result, { content: [{ type: 'text', text: 'did get_state' }], isError: false });
  assert.deepEqual(r[4].result, { content: [{ type: 'text', text: 'did add_case' }], isError: true });
  assert.deepEqual(r[5].result, {});
  assert.equal(r[6].error.code, -32601);
  assert.deepEqual(seen[1], { url: '/api/coach/tools/call', token: 'tok', tool: 'add_case', arguments: { input: [[1], 1], why: 'w' } });

  const revoked = await converse('stale', [{ id: 1, method: 'tools/call', params: { name: 'get_state', arguments: {} } }]);
  assert.equal(revoked[1].result.isError, true);
  assert.match(revoked[1].result.content[0].text, /turn has ended/);
});

// ------------------------------------------------------------------- prompt

test('the prompt carries the cached statement and parameters, and the abilities only with tools', async (t) => {
  const w = await workspace();
  t.after(w.cleanup);
  const sessionLog = new SessionLog({ root: w.root });
  const context = await gatherContext({ root: w.root, slug: 'two-sum', sessionLog });
  assert.deepEqual(context.problem.params, ['nums', 'target']);

  const plain = buildPrompt({ context, message: 'hi' }).prompt;
  assert.match(plain, /UNTRUSTED DATA — the problem statement Studio cached from LeetCode\nParameters, in order: nums, target\n\nGiven an array of integers nums and an integer target, return indices of the two numbers\./);
  assert.match(plain, /Input: nums = \[2,7,11,15\], target = 9\nOutput: \[0,1\]/);
  assert.match(plain, /- 2 <= nums\.length <= 10\^4/);
  assert.ok(!plain.includes('YOUR ABILITIES IN STUDIO'));

  for (const review of [false, true]) {
    const p = buildPrompt({ context, message: 'hi', review, tools: true }).prompt;
    const abilities = p.indexOf('## YOUR ABILITIES IN STUDIO');
    assert.ok(abilities > 0, `review=${review}`);
    assert.ok(abilities < p.indexOf('## VISUALS'), 'abilities come right before the visuals guide');
    assert.match(p, /edit_code tool is the one sanctioned way/);
  }

  const bare = await workspace({ cached: false });
  t.after(bare.cleanup);
  const none = await gatherContext({ root: bare.root, slug: 'two-sum', sessionLog: new SessionLog({ root: bare.root }) });
  assert.match(buildPrompt({ context: none, message: 'hi' }).prompt, /Problem statement: Studio has no cached copy of it/);
});

test('statement text keeps example blocks and caps its length', () => {
  assert.equal(statementText('<p>a&nbsp;&lt;b&gt;</p><pre>x\n  y</pre>'), 'a <b>\nx\ny');
  assert.match(statementText(`<p>${'z'.repeat(7000)}</p>`), /truncated at 6000 characters/);
  assert.equal(statementText(null), '');
});

test('recall tools require evidence and produce a durable pending receipt', async t => {
  const w = await workspace(); t.after(w.cleanup);
  const previous = process.env.STUDYCRAFT_RECALL_TOKEN;
  process.env.STUDYCRAFT_RECALL_TOKEN = '';
  t.after(() => { if (previous === undefined) delete process.env.STUDYCRAFT_RECALL_TOKEN; else process.env.STUDYCRAFT_RECALL_TOKEN = previous; });
  const { tools } = session(w.root);
  const note = { patternId: 'hashing-complement', title: 'Complement lookup', body: 'Look up before insertion.',
    intuition: 'Keep previous values.', recall: 'Why look up first?', trap: 'No trap recorded.', failingCase: 'No failing case recorded.' };
  assert.equal((await tools.call('save_recall_note', note)).ok, false);
  assert.equal((await tools.call('get_recall_evidence', { patternId: note.patternId })).ok, true);
  assert.equal((await tools.call('save_recall_note', note)).ok, true);
  assert.equal(tools.actions.at(-1).summary, 'Pending sync');
  assert.match(tools.actions.at(-1).revisionId, /^[a-f0-9]{64}$/);
});
