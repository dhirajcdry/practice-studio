#!/usr/bin/env node
// A stand-in `codex app-server`. FAKE_CODEX_IMAGE=1 makes the turn draw a 1×1 PNG
// first, reported the way the real image tool reports it.
// FAKE_CODEX_TOOL_CALLS='[{"tool":"add_case","arguments":{…}}, …]' makes the turn call
// those Studio dynamic tools first, one at a time, as `item/tool/call` server requests,
// and append each answer to FAKE_CODEX_TOOL_RESULTS_FILE (one JSON line per response).
import { createInterface } from 'node:readline';
import fs from 'node:fs';
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
const mcpNames = (process.env.FAKE_CODEX_MCP_NAMES || '').split(',').filter(Boolean);
const waiting = new Map();
let serverSeq = 0;
function callTool(call) {
  const id = `srv-${++serverSeq}`;
  emit({ id, method: 'item/tool/call', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', callId: `call-${serverSeq}`,
    namespace: null, tool: call.tool, arguments: call.arguments ?? {} } });
  return new Promise(resolve => waiting.set(id, resolve));
}
async function toolCalls() {
  const calls = JSON.parse(process.env.FAKE_CODEX_TOOL_CALLS || '[]');
  const texts = [];
  for (const call of calls) {
    const response = await callTool(call);
    if (process.env.FAKE_CODEX_TOOL_RESULTS_FILE) fs.appendFileSync(process.env.FAKE_CODEX_TOOL_RESULTS_FILE, JSON.stringify(response) + '\n');
    texts.push(response.result?.contentItems?.[0]?.text ?? response.error?.message ?? '');
  }
  return texts;
}
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id !== undefined && !request.method && waiting.has(request.id)) {
    const resolve = waiting.get(request.id); waiting.delete(request.id); resolve(request); return;
  }
  if (!request.id) return;
  if (request.method === 'thread/start' && process.env.FAKE_CODEX_THREAD_FILE) {
    fs.writeFileSync(process.env.FAKE_CODEX_THREAD_FILE, JSON.stringify(request.params));
  }
  const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : request.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', displayName: 'Astra' }] }
    : request.method === 'mcpServerStatus/list' ? { data: mcpNames.map(name => ({ name })), nextCursor: null }
    : request.method === 'thread/start' ? { thread: { id: 'fixture-thread' } }
    : request.method === 'turn/start' ? { turn: { id: 'fixture-turn' } } : {};
  emit({ id: request.id, result });
  if (request.method === 'turn/start') {
    if (process.env.FAKE_CODEX_PROMPT_FILE) fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_FILE, request.params.input[0].text);
    if (process.env.FAKE_CODEX_IMAGE === '1') {
      const item = { type: 'imageGeneration', id: 'ig_fixture', status: 'in_progress', result: '' };
      emit({ method: 'item/started', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', item } });
      emit({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId: 'fixture-turn',
        item: { ...item, status: 'completed', result: TINY_PNG, revisedPrompt: 'A fixture picture.', savedPath: null, failure: null } } });
    }
    toolCalls().then(texts => {
      const said = texts.length ? ` Tools said: ${texts.join(' | ')}` : '';
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', turnId: 'fixture-turn', delta: `Codex fixture reply.${said}` } });
      emit({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: 'fixture-turn', status: 'completed' } } });
    });
  }
});
