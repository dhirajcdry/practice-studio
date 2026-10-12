#!/usr/bin/env node
import { createInterface } from 'node:readline';
import fs from 'node:fs';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (!request.id) return;
  const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : request.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', displayName: 'Astra' }] }
    : request.method === 'thread/start' ? { thread: { id: 'fixture-thread' } }
    : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } } : {};
  emit({ id: request.id, result });
  if (request.method === 'turn/start') {
    if (process.env.FAKE_CODEX_PROMPT_FILE) fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_FILE, request.params.input[0].text);
    emit({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', delta: 'Codex fixture reply.' } });
    emit({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
  }
});
