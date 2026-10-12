import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DISABLED = ['shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'hooks', 'skill_search'];
export function buildArgs() {
  const args = ['app-server', '--stdio', '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0'];
  for (const flag of DISABLED) args.push('--disable', flag);
  return args;
}
function safeError(error) {
  if (error?.code === 'ENOENT') return 'Codex CLI was not found. Install Codex CLI and run `codex login`.';
  const text = String(error?.message ?? error ?? '').replace(/(sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/gi, '[redacted]');
  if (/not signed in|unauthorized|authentication|ChatGPT account/i.test(text)) return 'Sign in with ChatGPT using `codex login`, then try again.';
  return `Codex could not complete the reply: ${text.slice(0, 400) || 'the process stopped.'}`;
}

/** One isolated app-server; no CLI session files are used as the Studio chat record. */
function connection({ binary = 'codex', env = process.env, spawnFn = spawn, timeoutMs = 30000, onNotification = () => {} } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-studio-codex-'));
  const childEnv = { ...env };
  delete childEnv.OPENAI_API_KEY;
  let child;
  try { child = spawnFn(binary, buildArgs(), { cwd, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (error) { fs.rmSync(cwd, { recursive: true, force: true }); throw error; }
  let nextId = 0, closed = false, stopping = false, hardTimer;
  const pending = new Map();
  let resolveExit;
  const exited = new Promise(resolve => { resolveExit = resolve; });
  function rejectPending(error) {
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); }
    pending.clear();
  }
  function send(message) {
    if (closed || stopping) throw new Error('Codex connection closed.');
    child.stdin.write(JSON.stringify(message) + '\n');
  }
  function rpc(method, params = {}) {
    if (closed || stopping) return Promise.reject(new Error('Codex connection closed.'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { send({ id, method, params }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  function signal(name) {
    try {
      if (child.pid && child.pid !== process.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch { try { child.kill(name); } catch { /* already exited */ } }
  }
  function close() {
    if (stopping || closed) return;
    stopping = true;
    rejectPending(new Error('Codex connection closed.'));
    signal('SIGTERM');
    if (!closed) { hardTimer = setTimeout(() => signal('SIGKILL'), 2000); hardTimer.unref?.(); }
  }
  function ended(error) {
    if (closed) return;
    closed = true;
    clearTimeout(hardTimer);
    rejectPending(error || new Error('Codex stopped.'));
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* temporary cleanup only */ }
    resolveExit(error);
  }
  child.on('error', ended);
  child.on('close', (code, signal) => ended(new Error(`Codex stopped (exit ${code ?? signal}).`)));
  child.stdin.on('error', error => { rejectPending(error); close(); });
  child.stderr.resume(); // Never forward diagnostic payloads containing private context.
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (closed || stopping) return;
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id !== undefined && message.method) {
      // No tool, permission, account-token, or user-input requests are ever approved.
      try { send({ id: message.id, error: { code: -32601, message: 'Tools and interactive requests are disabled in Practice Studio.' } }); } catch { close(); }
    } else if (message.id !== undefined) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message || 'Codex request failed.')) : p.resolve(message.result);
    } else onNotification(message);
  });
  async function initialize() {
    await rpc('initialize', { clientInfo: { name: 'practice-studio', title: 'Practice Studio', version: '0.1.0' }, capabilities: { experimentalApi: false } });
    send({ method: 'initialized', params: {} });
    const account = await rpc('account/read');
    if (account?.account?.type !== 'chatgpt') throw new Error('ChatGPT account required.');
  }
  return { cwd, rpc, initialize, close, exited };
}

export function runCoachTurn({ prompt, systemPrompt = '', model = 'gpt-6-astra', resumeSessionId = null,
  binary = 'codex', env = process.env, spawnFn = spawn, timeoutMs = TURN_TIMEOUT_MS,
  onToken = () => {}, onDone = () => {}, onError = () => {}, onSessionId = () => {},
} = {}) {
  const sessionId = resumeSessionId || crypto.randomUUID();
  let client, timer, settled = false, threadId, streamed = '', finalText = '';
  function fail(error) {
    if (settled) return;
    settled = true; clearTimeout(timer);
    try { onError(safeError(error)); } finally { client?.close(); }
  }
  function kill() { settled = true; clearTimeout(timer); client?.close(); }
  function notification(message) {
    if (settled) return;
    const p = message.params || {};
    if (!threadId || p.threadId !== threadId) return;
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') { streamed += p.delta; onToken(p.delta); }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') finalText = p.item.text || finalText;
    if (message.method !== 'turn/completed') return;
    const turn = p.turn || {};
    if (turn.status !== 'completed') return fail(turn.error?.message || turn.status || 'Turn failed.');
    finalText ||= turn.items?.filter(i => i.type === 'agentMessage').at(-1)?.text || '';
    if (!streamed && finalText) onToken(finalText);
    if (!streamed && !finalText) return fail('No reply was returned. Please retry.');
    settled = true; clearTimeout(timer);
    try { onDone(sessionId, 'completed'); } finally { client.close(); }
  }
  try { client = connection({ binary, env, spawnFn, timeoutMs: Math.min(timeoutMs, 30000), onNotification: notification }); }
  catch (error) { queueMicrotask(() => fail(error)); return { kill, exited: Promise.resolve(), resumeFailed: false }; }
  onSessionId(sessionId);
  timer = setTimeout(() => fail('The coach took too long and was stopped. Your work is untouched.'), timeoutMs);
  client.exited.then(error => { if (!settled) fail(error); });
  (async () => {
    try {
      await client.initialize();
      if (settled) return;
      const started = await client.rpc('thread/start', {
        model, cwd: client.cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
        baseInstructions: `${systemPrompt}\nYou are the Practice Studio interview coach. Do not use tools. Answer only from supplied context. Do not claim to change files or memory.`,
        config: { tools: {}, mcp_servers: {} },
      });
      if (settled) return;
      threadId = started?.thread?.id;
      if (!threadId) throw new Error('Codex did not create a thread.');
      await client.rpc('turn/start', { threadId, input: [{ type: 'text', text: prompt, text_elements: [] }] });
    } catch (error) { fail(error); }
  })();
  return { kill, exited: client.exited, resumeFailed: false };
}

export async function listCodexModels(options = {}) {
  let client;
  try {
    client = connection(options);
    await client.initialize();
    const models = [];
    let cursor;
    do {
      const result = await client.rpc('model/list', cursor ? { cursor } : {});
      for (const m of result?.data || []) {
        if (typeof m?.model === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(m.model)) {
          models.push({ id: m.model, label: typeof m.displayName === 'string' ? m.displayName.slice(0, 100) : m.model });
        }
      }
      cursor = result?.nextCursor;
    } while (cursor);
    return models;
  } catch (error) { throw new Error(safeError(error)); }
  finally { client?.close(); if (client) await client.exited; }
}
