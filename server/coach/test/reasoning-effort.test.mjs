import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCoachChoice, saveCoachChoice } from '../provider.mjs';

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-effort-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const model = (reasoningEfforts) => ({ id: 'gpt-6-astra', reasoningEfforts });

test('highest resolves to the strongest advertised effort regardless of catalog order and persists on read', async t => {
  const root = await workspace(t);
  const saved = await saveCoachChoice(root, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'highest' }, {
    models: async () => [model(['low', 'ultra', 'medium', 'xhigh'])],
  });
  assert.deepEqual(saved, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' });
  assert.deepEqual(await readCoachChoice(root), saved);
});

test('unsupported explicit effort rejects without overwriting the previous choice', async t => {
  const root = await workspace(t);
  const previous = { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium' };
  await saveCoachChoice(root, previous, { models: async () => [model(['low', 'medium', 'high'])] });
  await assert.rejects(
    saveCoachChoice(root, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' }, {
      models: async () => [model(['low', 'medium', 'high'])],
    }),
    error => error.code === 'BAD_REQUEST',
  );
  assert.deepEqual(await readCoachChoice(root), previous);
});

test('highest rejects when the selected model advertises no supported efforts', async t => {
  const root = await workspace(t);
  await assert.rejects(
    saveCoachChoice(root, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'highest' }, {
      models: async () => [model([])],
    }),
    error => error.code === 'EFFORT_UNAVAILABLE',
  );
  assert.deepEqual(await readCoachChoice(root), { provider: 'codex', model: 'gpt-6-astra' });
});

test('explicit effort rejects when the selected model advertises no supported efforts', async t => {
  const root = await workspace(t);
  await assert.rejects(
    saveCoachChoice(root, { provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'ultra' }, {
      models: async () => [model([])],
    }),
    error => error.code === 'BAD_REQUEST',
  );
});

test('Claude selections do not persist a Codex reasoning effort', async t => {
  const root = await workspace(t);
  const saved = await saveCoachChoice(root, { provider: 'claude', model: 'sonnet', reasoningEffort: 'ultra' });
  assert.deepEqual(saved, { provider: 'claude', model: 'sonnet' });
  assert.deepEqual(await readCoachChoice(root), saved);
});
