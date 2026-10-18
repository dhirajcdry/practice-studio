import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runConversationTurn } from '../codex-conversation.mjs';
const binary = new URL('./bin/fake-codex.mjs', import.meta.url).pathname;
test('interview Codex reuses locked native thread without Studio tools', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-codex-'));
  const file = path.join(dir, 'thread.json');
  const previous = { file: process.env.FAKE_CODEX_THREAD_FILE, names: process.env.FAKE_CODEX_MCP_NAMES };
  process.env.FAKE_CODEX_THREAD_FILE = file; process.env.FAKE_CODEX_MCP_NAMES = 'browser,filesystem';
  const conversation = {};
  t.after(async () => { conversation.close?.(); if (previous.file === undefined) delete process.env.FAKE_CODEX_THREAD_FILE; else process.env.FAKE_CODEX_THREAD_FILE = previous.file; if (previous.names === undefined) delete process.env.FAKE_CODEX_MCP_NAMES; else process.env.FAKE_CODEX_MCP_NAMES = previous.names; await fs.rm(dir, { recursive: true, force: true }); });
  const turn = prompt => new Promise((resolve, reject) => {
    let output = '';
    runConversationTurn({ conversation, binary, model: 'gpt-6-astra', prompt, systemPrompt: 'Interviewer.',
      onToken: text => { output += text; }, onDone: () => resolve(output), onError: reject });
  });
  assert.match(await turn('First answer'), /Codex fixture reply/);
  const client = conversation.client, threadId = conversation.threadId;
  const config = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(config.config.mcp_servers, { browser: { enabled: false }, filesystem: { enabled: false } });
  assert.equal(config.dynamicTools, undefined); assert.equal(config.sandbox, 'read-only'); assert.equal(config.approvalPolicy, 'never');
  await fs.rm(file);
  assert.match(await turn('A diff only'), /Codex fixture reply/);
  assert.equal(conversation.client, client); assert.equal(conversation.threadId, threadId);
  await assert.rejects(fs.access(file)); // No second thread/start.
});
