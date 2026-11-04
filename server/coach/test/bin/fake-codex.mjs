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
let turnId = 'fixture-turn', durable = null;
const stateFile = process.env.FAKE_CODEX_STATE_FILE;
const logFile = process.env.FAKE_CODEX_REQUESTS_FILE;

function callTool(call) {
  const id = `srv-${++serverSeq}`;
  emit({ id, method: 'item/tool/call', params: { threadId: 'fixture-thread', turnId, callId: `call-${serverSeq}`,
    namespace: null, tool: call.tool, arguments: call.arguments ?? {}, ...(call.threadId ? { threadId: call.threadId } : {}), ...(call.turnId ? { turnId: call.turnId } : {}) } });
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
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(request) + '\n');
  if (request.method === 'thread/resume') {
    if ((stateFile && !fs.existsSync(stateFile)) || request.params.threadId !== 'fixture-thread') {
      emit({ id: request.id, error: { code: -32000, message: 'Session not found' } }); return;
    }
    durable = stateFile ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { prompts: [], dynamicTools: [] };
    if ('dynamicTools' in request.params) throw new Error('Resume does not accept dynamicTools');
  }
  if (request.method === 'thread/start' && request.params.ephemeral === false) {
    durable = { prompts: [], dynamicTools: request.params.dynamicTools ?? [] };
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(durable));
  }
  if (request.method === 'turn/start' && durable) {
    durable.prompts.push(request.params.input[0].text);
    turnId = 'fixture-turn-' + durable.prompts.length;
    if (stateFile) fs.writeFileSync(stateFile, JSON.stringify(durable));
  }
  if (request.method === 'thread/start' && process.env.FAKE_CODEX_THREAD_FILE) {
    fs.writeFileSync(process.env.FAKE_CODEX_THREAD_FILE, JSON.stringify(request.params));
  }
  const result = request.method === 'account/read' ? { account: { type: 'chatgpt' } }
    : request.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', displayName: 'Astra' }] }
    : request.method === 'mcpServerStatus/list' ? { data: mcpNames.map(name => ({ name })), nextCursor: null }
    : ['thread/start', 'thread/resume'].includes(request.method) ? { thread: { id: 'fixture-thread' } }
    : request.method === 'turn/start' ? { turn: { id: turnId } } : {};
  emit({ id: request.id, result });
  if (request.method === 'turn/start') {
    if (process.env.FAKE_CODEX_PROMPT_FILE) fs.writeFileSync(process.env.FAKE_CODEX_PROMPT_FILE, request.params.input[0].text);
    if (process.env.FAKE_CODEX_IMAGE === '1') {
      const item = { type: 'imageGeneration', id: 'ig_fixture', status: 'in_progress', result: '' };
      emit({ method: 'item/started', params: { threadId: 'fixture-thread', turnId, item } });
      emit({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId,
        item: { ...item, status: 'completed', result: TINY_PNG, revisedPrompt: 'A fixture picture.', savedPath: null, failure: null } } });
    }
    if (durable) {
      const prior = (durable.prompts.length - 1) * 150;
      for (const [total, last] of [[prior + 100, 100], [prior + 150, 50], [prior + 150, 50]]) {
        emit({ method: 'thread/tokenUsage/updated', params: { threadId: 'fixture-thread', turnId,
          tokenUsage: { total: { inputTokens: total, outputTokens: total / 10 }, last: { inputTokens: last, outputTokens: last / 10 } } } });
      }
      emit({ method: 'item/completed', params: { threadId: 'fixture-thread', turnId, item: { id: 'compact', type: 'contextCompaction' } } });
    }
    toolCalls().then(async texts => {
      if (durable) {
        emit({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', turnId, delta: 'Early token. ' } });
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      const said = texts.length ? ` Tools said: ${texts.join(' | ')}` : '';
      emit({ method: 'item/agentMessage/delta', params: { threadId: 'fixture-thread', turnId, delta: `Codex fixture reply.${said}` } });
      emit({ method: 'turn/completed', params: { threadId: 'fixture-thread', turn: { id: turnId, status: 'completed' } } });
    });
  }
});
