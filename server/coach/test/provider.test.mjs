import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCoachChoice, saveCoachChoice, validChoice } from '../provider.mjs';
import { readCoachMemory, withConversation } from '../provider-context.mjs';
import { buildArgs } from '../claude-cli.mjs';
import { CoachSessionStore } from '../sessions.mjs';
import { appendTurn, readTurns } from '../transcript.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-provider-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
test('Astra defaults explicitly; provider/model persist across reads and switching', async t => {
  const root = await workspace(t);
  assert.deepEqual(await readCoachChoice(root), { provider: 'codex', model: 'gpt-6-astra' });
  await saveCoachChoice(root, { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(await readCoachChoice(root), { provider: 'claude', model: 'sonnet' });
  const astra = { provider: 'codex', model: 'gpt-6-astra' };
  await saveCoachChoice(root, astra, { models: async () => [{ id: 'gpt-6-astra' }] });
  assert.deepEqual(await readCoachChoice(root), astra);
});
test('invalid or unavailable selection leaves saved model intact', async t => {
  const root = await workspace(t);
  await saveCoachChoice(root, { provider: 'claude', model: 'opus' });
  for (const value of [{ provider: 'x', model: 'a' }, { provider: 'codex', model: '--dangerous' }, { provider: 'claude', model: 'unknown' }]) {
    assert.equal(Boolean(validChoice(value)), false);
    await assert.rejects(saveCoachChoice(root, value));
  }
  await assert.rejects(saveCoachChoice(root, { provider: 'codex', model: 'not-in-catalog' }, { models: async () => [] }));
  assert.equal((await readCoachChoice(root)).model, 'opus');
});
test('Claude model flag preserves permission restrictions', () => {
  const args = buildArgs({ root: '/tmp/fixture', model: 'sonnet' });
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
  assert.ok(!args.includes('--dangerously-skip-permissions'));
});
test('provider metadata is additive and legacy chat/session records remain readable', async t => {
  const root = await workspace(t), store = new CoachSessionStore({ root });
  await store.remember('two-sum', 'old-claude');
  assert.equal((await store.read('two-sum')).sessionId, 'old-claude');
  await store.remember('two-sum', 'new-local-id', { provider: 'codex', model: 'gpt-6-astra' });
  assert.equal((await store.read('two-sum')).provider, 'codex');
  await appendTurn({ root, slug: 'two-sum', turn: { sessionId: 'new-local-id', provider: 'codex', model: 'gpt-6-astra', ask: 'My question', answer: 'A reply' } });
  const [turn] = await readTurns({ root, slug: 'two-sum' });
  assert.equal(turn.provider, 'codex'); assert.equal(turn.ask, 'My question');
});
test('read-only memory is bounded and does not follow symlinks outside workspace', async t => {
  const root = await workspace(t), outside = await workspace(t);
  await fs.writeFile(path.join(outside, 'private.txt'), 'not coach context');
  await fs.symlink(path.join(outside, 'private.txt'), path.join(root, 'TUTOR.md'));
  await fs.mkdir(path.join(root, 'problems/two-sum'), { recursive: true });
  await fs.writeFile(path.join(root, 'problems/two-sum/NOTES.md'), 'x'.repeat(32000));
  const memory = await readCoachMemory(root, 'two-sum');
  assert.equal(memory.length, 1); assert.equal(memory[0].text.length, 16000);
  const prompt = withConversation('Latest question', [{ ask: 'Earlier learner words', answer: 'Earlier inference', stopped: true }], memory, { readOnly: true });
  assert.match(prompt, /Earlier learner words/); assert.match(prompt, /"interrupted":true/);
  assert.match(prompt, /no tools or file access/); assert.ok(!prompt.includes('not coach context'));
});
