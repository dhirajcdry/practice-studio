import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export const TURN_TIMEOUT_MS = 10 * 60 * 1000;
const DISABLED = ['shell_tool', 'apps', 'plugins', 'browser_use', 'browser_use_external', 'computer_use', 'multi_agent', 'hooks', 'skill_search'];
// Image generation is off for chat: a picture made inside a chat thread has nowhere to go
// and would only spend the user's image quota. The visuals job turns it on, and only it.
export function buildArgs({ imageGeneration = false, webResearch = false } = {}) {
  const args = ['app-server', '--stdio', '-c', 'forced_login_method="chatgpt"', '-c', `web_search="${webResearch ? 'live' : 'disabled'}"`, '-c', 'project_doc_max_bytes=0'];
  for (const flag of DISABLED) args.push('--disable', flag);
  args.push(imageGeneration ? '--enable' : '--disable', 'image_generation');
  return args;
}

/** An error whose message is already written for the user and must reach them as-is. */
export function plainError(message) {
  const error = new Error(message);
  error.plain = true;
  return error;
}
export function safeError(error) {
  if (error?.plain) return error.message;
  if (error?.code === 'ENOENT') return 'Codex CLI was not found. Install Codex CLI and run `codex login`.';
  const text = String(error?.message ?? error ?? '').replace(/(sk-[A-Za-z0-9_-]{10,}|Bearer\s+\S+)/gi, '[redacted]');
  if (/not signed in|unauthorized|authentication|ChatGPT account/i.test(text)) return 'Sign in with ChatGPT using `codex login`, then try again.';
  return `Codex could not complete the reply: ${text.slice(0, 400) || 'the process stopped.'}`;
}

/** One isolated app-server; no CLI session files are used as the Studio chat record. */
/**
 * `onRequest(message)` may answer one server→client request by returning a promise of its
 * result; returning nothing rejects it. Without it, every request is rejected.
 */
export function connection({ binary = 'codex', env = process.env, spawnFn = spawn, timeoutMs = 30000, imageGeneration = false, webResearch = false, onNotification = () => {}, onRequest = () => null } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-studio-codex-'));
  const childEnv = { ...env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.STUDYCRAFT_RECALL_TOKEN;
  let child;
  try { child = spawnFn(binary, buildArgs({ imageGeneration, webResearch }), { cwd, env: childEnv, detached: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
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
      // No permission, account-token, or user-input request is ever approved. The one
      // thing a caller may answer is a call to a tool Studio itself defined (onRequest).
      const answer = onRequest(message);
      if (answer && typeof answer.then === 'function') {
        answer.then(
          (result) => { if (!closed && !stopping) try { send({ id: message.id, result }); } catch { close(); } },
          () => { if (!closed && !stopping) try { send({ id: message.id, error: { code: -32603, message: 'Studio could not run that tool.' } }); } catch { close(); } },
        );
        return;
      }
      try { send({ id: message.id, error: { code: -32601, message: 'Tools and interactive requests are disabled in Practice Studio.' } }); } catch { close(); }
    } else if (message.id !== undefined) {
      const p = pending.get(message.id);
      if (!p) return;
      pending.delete(message.id); clearTimeout(p.timer);
      message.error ? p.reject(new Error(message.error.message || 'Codex request failed.')) : p.resolve(message.result);
    } else onNotification(message);
  });
  // experimentalApi is what makes `dynamicTools` on thread/start available; only a turn
  // that hands Studio's own tools to the model asks for it.
  async function initialize({ experimentalApi = false } = {}) {
    await rpc('initialize', { clientInfo: { name: 'practice-studio', title: 'Practice Studio', version: '0.1.0' }, capabilities: { experimentalApi } });
    send({ method: 'initialized', params: {} });
    const account = await rpc('account/read');
    if (account?.account?.type !== 'chatgpt') throw new Error('ChatGPT account required.');
  }
  return { cwd, rpc, initialize, close, exited };
}

export const MCP_UNCONFIRMED = 'Codex could not confirm its tool servers are off; update Codex CLI.';
export const MCP_STARTED = 'Codex started a tool server from your own Codex settings, so Studio stopped this reply. Nothing was run on its behalf.';
const MAX_MCP_PAGES = 50;

/**
 * Thread config that turns off every MCP server in the user's ~/.codex/config.toml.
 *
 * `mcp_servers: {}` (and `-c mcp_servers={}`) is merged into that config, not put in
 * place of it, so the user's own servers — a browser with unsafe code execution
 * auto-approved, a Node REPL — still started inside Studio's threads. Naming each one
 * with `enabled: false` is what actually stops them. Listing does not start them.
 * If the list cannot be read, nothing is started: we cannot prove the servers are off.
 */
export async function lockedThreadConfig(client) {
  const names = new Set();
  try {
    let cursor, pages = 0;
    do {
      const result = await client.rpc('mcpServerStatus/list', cursor ? { cursor } : {});
      for (const server of result?.data || []) {
        if (typeof server?.name === 'string' && server.name) names.add(server.name);
      }
      cursor = result?.nextCursor;
    } while (cursor && ++pages < MAX_MCP_PAGES);
    if (cursor) throw new Error('Incomplete MCP inventory');
  } catch {
    throw plainError(MCP_UNCONFIRMED);
  }
  return { tools: {}, mcp_servers: Object.fromEntries([...names].map(name => [name, { enabled: false }])) };
}

/**
 * Belt and braces for the lockdown above: any MCP server coming up in our process is a
 * failure. The process is ours alone, so a startup notice without a thread id still counts.
 */
export function mcpServerStarting(message, threadId = null) {
  if (message?.method !== 'mcpServer/startupStatus/updated') return false;
  const p = message.params || {};
  if (p.threadId && threadId && p.threadId !== threadId) return false;
  const status = String(p.status?.type ?? p.status ?? p.state ?? '').toLowerCase();
  return status === 'starting' || status === 'ready';
}

/**
 * Start or resume a read-only, never-approving thread with every MCP server off, then
 * its one turn. `alive()` lets the caller stop between steps if it gave up meanwhile.
 * Returns the thread id, or null when the caller stopped.
 */
export async function startLockedTurn(client, { model, reasoningEffort, baseInstructions, text, dynamicTools = null, webResearch = false, onThread = () => {}, onTurn = () => {}, persistentSession = false, resumeSessionId = null, alive = () => true }) {
  const config = await lockedThreadConfig(client);
  if (!alive()) return null;
  const resuming = persistentSession && resumeSessionId;
  const started = await client.rpc(resuming ? 'thread/resume' : 'thread/start', {
    model, cwd: client.cwd, approvalPolicy: 'never', sandbox: 'read-only', ...(resuming ? { threadId: resumeSessionId, excludeTurns: true } : { ephemeral: !persistentSession }), baseInstructions,
    config: { ...config, web_search: webResearch ? 'live' : 'disabled', ...(reasoningEffort ? { model_reasoning_effort: reasoningEffort } : {}) },
    ...(!resuming && dynamicTools?.length ? { dynamicTools } : {}),
  });
  if (!alive()) return null;
  const threadId = started?.thread?.id;
  if (!threadId) throw new Error('Codex did not create a thread.');
  if (resuming && threadId !== resumeSessionId) throw new Error('Codex resumed a different thread.');
  await onThread(threadId);
  if (!alive()) return null;
  const result = await client.rpc('turn/start', { threadId, ...(reasoningEffort ? { effort: reasoningEffort } : {}), input: [{ type: 'text', text, text_elements: [] }] });
  onTurn(result?.turn?.id);
  return threadId;
}

/** Studio's tools in the shape app-server's `dynamicTools` takes. */
export function dynamicToolsFrom(specs) {
  return specs.map(({ name, description, inputSchema }) => ({ type: 'function', name, description, inputSchema }));
}

export function normalizeUsage(value, previous = null) {
  const envelope = value?.usage || value?.tokenUsage || value || {};
  // Verified against app-server generate-ts: thread/tokenUsage/updated carries
  // tokenUsage.total and .last. A fresh ephemeral thread's total includes every
  // model call/tool continuation in this Studio turn; never sum notifications.
  const source = envelope.total || envelope;
  const fields = { inputTokens: ['input_tokens', 'inputTokens'], cacheReadInputTokens: ['cache_read_input_tokens', 'cacheReadInputTokens','cachedInputTokens'], cacheCreationInputTokens: ['cache_creation_input_tokens', 'cacheCreationInputTokens','cacheWriteInputTokens'], outputTokens: ['output_tokens', 'outputTokens'], reasoningOutputTokens:['reasoningOutputTokens'] };
  return Object.fromEntries(Object.entries(fields).map(([key, names]) => {
    const n = names.map(name => source[name]).find(v => Number.isFinite(v));
    return [key, n == null ? (previous?.[key] ?? null) : Math.max(Number(n), previous?.[key] ?? 0)];
  }));
}

/** A one-line summary of a tool call's arguments for the chat's tool lines: the first
 *  string argument, the same rule claude-cli.mjs's summariseToolUse applies. */
function argSummary(args) {
  const first = args && typeof args === 'object'
    ? Object.values(args).find((v) => typeof v === 'string')
    : null;
  return first === null || first === undefined ? '' : String(first).replace(/\s+/g, ' ').slice(0, 120);
}

export function coachInstructions(systemPrompt, { hasTools = false, webResearch = false } = {}) {
  return `${systemPrompt}\nYou are the Practice Studio interview coach. ${hasTools ? 'Use Studio tools for workspace actions; each action is shown to the learner. Do not claim an action happened unless its tool result says it did.' : 'Do not claim to change files or memory.'} ${webResearch ? 'Native web research is available for public sources when useful or requested.' : 'Answer from supplied context and enabled Studio tools only.'} You have no file or shell access.`;
}

export function runCoachTurn({ prompt, systemPrompt = '', systemPromptComplete = false, model = 'gpt-6-astra', reasoningEffort = null, resumeSessionId = null, persistentSession = false,
  binary = 'codex', env = process.env, spawnFn = spawn, timeoutMs = TURN_TIMEOUT_MS,
  toolSession = null, toolSpecs = [],
  onToken = () => {}, onTool = () => {}, onDone = () => {}, onError = () => {}, onSessionId = () => {}, onUsage = () => {},
  webResearch = false, onTurnId = () => {}, onCompaction = () => {},
} = {}) {
  let sessionId = persistentSession ? null : resumeSessionId || crypto.randomUUID();
  let turnId, usageBaseline = null;
  const queued = [];
  let releaseTurn;
  const turnReady = new Promise(resolve => { releaseTurn = resolve; });
  let client, timer, settled = false, threadId, streamed = '', finalText = '', usage = null;
  function fail(error) {
    if (settled) return;
    settled = true; releaseTurn?.(); clearTimeout(timer);
    try { onError(safeError(error)); } finally { client?.close(); }
  }
  function kill() { settled = true; releaseTurn?.(); clearTimeout(timer); client?.close(); }
  function notification(message) {
    if (settled) return;
    if (mcpServerStarting(message, threadId)) return fail(plainError(MCP_STARTED));
    const p = message.params || {};
    if (!threadId || p.threadId !== threadId) return;
    if (!turnId) { queued.push(message); return; }
    if ((p.turnId || p.turn?.id) && (p.turnId || p.turn?.id) !== turnId) return;
    if (message.method === 'thread/tokenUsage/updated') {
      if (persistentSession && resumeSessionId) {
        // .last is the most recent model call, not the entire multi-call Studio turn.
        // The first active-turn total minus last establishes the historical baseline.
        const total = normalizeUsage(p.tokenUsage?.total);
        const last = normalizeUsage(p.tokenUsage?.last);
        usageBaseline ??= Object.fromEntries(Object.keys(total).map(k => [k,
          total[k] != null && last[k] != null ? Math.max(0, total[k] - last[k]) : null]));
        usage = Object.fromEntries(Object.keys(total).map(k => [k,
          total[k] != null && usageBaseline[k] != null ? Math.max(usage?.[k] ?? 0, total[k] - usageBaseline[k]) : null]));
      } else usage = normalizeUsage(p.tokenUsage, usage);
      onUsage(usage); return;
    }
    if (message.method === 'item/completed' && p.item?.type === 'contextCompaction')
      onCompaction({ threadId, turnId, itemId: p.item.id });

    if (message.method === 'item/started' && p.item?.type === 'webSearch') onTool('web_search', p.item.query || p.item.action?.query || 'Researching public sources');
    if (message.method === 'item/agentMessage/delta' && typeof p.delta === 'string') { streamed += p.delta; onToken(p.delta); }
    if (message.method === 'item/completed' && p.item?.type === 'agentMessage') finalText = p.item.text || finalText;
    if (message.method !== 'turn/completed') return;
    const turn = p.turn || {};
    if (turn.status !== 'completed') return fail(turn.error?.message || turn.status || 'Turn failed.');
    finalText ||= turn.items?.filter(i => i.type === 'agentMessage').at(-1)?.text || '';
    if (!streamed && finalText) onToken(finalText);
    if (!streamed && !finalText) return fail('No reply was returned. Please retry.');
    settled = true; releaseTurn?.(); clearTimeout(timer);
    try { onDone(sessionId, 'completed'); } finally { client.close(); }
  }
  // Only a call to one of Studio's own tools, on this turn's thread, is ever answered.
  function request(message) {
    if (!toolSession || message.method !== 'item/tool/call' || settled) return null;
    return (async () => {
      const p = message.params || {};
      await turnReady;
      if (settled || !threadId || p.threadId !== threadId || p.turnId !== turnId || !toolSpecs.some(spec => spec.name === p.tool)) throw new Error('Stale or unavailable Studio tool.');
      let args = p.arguments;
      if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
      onTool(p.tool, argSummary(args));
      return toolSession.call(p.tool, args ?? {}).then(({ ok, text }) => ({
        success: ok === true, contentItems: [{ type: 'inputText', text: String(text ?? '') }],
      }));
    })();
  }
  try { client = connection({ binary, env, spawnFn, timeoutMs: Math.min(timeoutMs, 30000), webResearch, onNotification: notification, onRequest: request }); }
  catch (error) { queueMicrotask(() => fail(error)); return { kill, exited: Promise.resolve(), resumeFailed: false }; }
  if (!persistentSession) onSessionId(sessionId);
  timer = setTimeout(() => fail('The coach took too long and was stopped. Your work is untouched.'), timeoutMs);
  client.exited.then(error => { if (!settled) fail(error); });
  (async () => {
    try {
      const tools = toolSession && toolSpecs.length ? dynamicToolsFrom(toolSpecs) : null;
      await client.initialize({ experimentalApi: Boolean(tools) });
      if (settled) return;
      await startLockedTurn(client, {
        model, reasoningEffort, text: prompt, dynamicTools: tools,
        webResearch, persistentSession, resumeSessionId,
        baseInstructions: systemPromptComplete ? systemPrompt : coachInstructions(systemPrompt, { hasTools: !!tools, webResearch }),
        onThread: async id => { threadId = id; if (persistentSession) { sessionId = id; await onSessionId(id); } },
        onTurn: id => {
          if (!id) throw new Error('Codex did not return a turn ID.');
          turnId = id; onTurnId(id); releaseTurn();
          for (const message of queued.splice(0)) notification(message);
        },
        alive: () => !settled,
      });
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
          const efforts = Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts
            .map(e => typeof e === 'string' ? e : e?.reasoningEffort).filter(e => typeof e === 'string') : [];
          models.push({ id: m.model, label: typeof m.displayName === 'string' ? m.displayName.slice(0, 100) : m.model, ...(efforts.length ? { reasoningEfforts: efforts } : {}) });
        }
      }
      cursor = result?.nextCursor;
    } while (cursor);
    return models;
  } catch (error) { throw new Error(safeError(error)); }
  finally { client?.close(); if (client) await client.exited; }
}
