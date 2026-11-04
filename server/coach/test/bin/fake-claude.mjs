#!/usr/bin/env node
// A stand-in for the `claude` CLI, so the streaming tests exercise real spawning, real
// pipes and real process groups without spending a single API call.
//
// Behaviour is chosen with FAKE_CLAUDE_MODE:
//   ok           stream two text deltas, a tool_use, then a successful result
//   multiline    stream text containing newlines and a blank line (SSE framing)
//   crash        stream one delta, then exit(3) mid-stream with something on stderr
//   noresume     exit(1) complaining that the session id is unknown
//   apierror     emit a result with is_error
//   noresume-result  exit(0) with the unknown session reported in the result's `errors`
//   hang         stream one delta and then never exit (disconnect / orphan tests)
//   slow         stream one delta, pause FAKE_CLAUDE_DELAY_MS, then finish normally —
//                long enough to disconnect in the middle and see whether it survives
//   spawnchild   fork a long-lived grandchild, then hang (process-group kill test)
//   tools        start the "studio" MCP server named by --mcp-config, the way Claude Code
//                does, list its tools, call each of FAKE_CLAUDE_TOOL_CALLS (JSON
//                [{tool, arguments}]) and write what came back to
//                FAKE_CLAUDE_TOOL_RESULTS_FILE, then answer with the results
//
// FAKE_CLAUDE_ARGS_FILE / FAKE_CLAUDE_PROMPT_FILE capture what we were invoked with.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
let mode = process.env.FAKE_CLAUDE_MODE || 'ok';

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2));
}

const resumeIdx = args.indexOf('--resume');
const sessionIdx = args.indexOf('--session-id');
const fork = args.includes('--fork-session');
const sessionId = fork ? 'fake-upkeep-fork' :
  resumeIdx !== -1 ? args[resumeIdx + 1] : sessionIdx !== -1 ? args[sessionIdx + 1] : 'unknown';

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function delta(text) {
  emit({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    session_id: sessionId,
  });
}

let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  prompt += c;
});
process.stdin.on('end', () => {
  if (fork) {
    emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, result: 'done' });
    process.exit(0);
  }
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, prompt);
  }
  run();
});

function run() {
  if (process.env.FAKE_CLAUDE_STATE_FILE) {
    const file = process.env.FAKE_CLAUDE_STATE_FILE;
    const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    if (resumeIdx !== -1 && !state[sessionId]) {
      emit({ type: 'result', is_error: true, errors: ['No conversation found'] }); process.exit(0);
    }
    (state[sessionId] ??= []).push(prompt);
    fs.writeFileSync(file, JSON.stringify(state));
    emit({ type: 'system', subtype: 'compact_boundary', session_id: sessionId, compact_metadata: { trigger: 'auto', pre_tokens: 100 } });
  }
  if (process.env.FAKE_CLAUDE_TOOLS_WHEN && prompt.includes(process.env.FAKE_CLAUDE_TOOLS_WHEN)) mode = 'tools';
  if (process.env.FAKE_CLAUDE_ECHO_WHEN && prompt.includes(process.env.FAKE_CLAUDE_ECHO_WHEN)) mode = 'tool-echo';
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });

  if (mode === 'tool-echo') {
    const text = 'Yes, size matters. Each package is small, medium or large.';
    const event = event => emit({ type: 'stream_event', event, session_id: sessionId });
    event({ type: 'message_start', message: { id: 'before-tool' } }); delta(text);
    event({ type: 'content_block_stop', index: 0 });
    emit({ type: 'assistant', message: { id: 'before-tool', content: [{ type: 'text', text }, { type: 'tool_use', name: 'mcp__studio__record_session', input: { key: 'req_package_size' } }] } });
    event({ type: 'message_stop' });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', content: 'Recorded session requirement.' }] } });
    event({ type: 'message_start', message: { id: 'after-tool' } });
    for (const c of text) delta(c);
    event({ type: 'content_block_stop', index: 0 });
    emit({ type: 'assistant', message: { id: 'after-tool', content: [{ type: 'text', text }] } });
    event({ type: 'message_stop' });
    emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false, result: text });
    process.exit(0);
  }

  if (mode === 'noresume') {
    process.stderr.write('Error: No conversation found with session ID: ' + sessionId + '\n');
    process.exit(1);
  }

  if (mode === 'noresume-result') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      errors: ['No conversation found with session ID: ' + sessionId],
    });
    process.exit(0);
  }

  if (mode === 'apierror') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: 'Invalid API key · Please run /login',
    });
    process.exit(0);
  }

  if (mode === 'multiline') {
    delta('line one\nline two\n\nline four with a lone \r carriage return');
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      stop_reason: 'end_turn',
      result: 'ok',
    });
    process.exit(0);
  }

  if (mode === 'tools') {
    studioTools().then((said) => {
      delta(`Tools said: ${said.join(' | ')}`);
      emit({ type: 'result', subtype: 'success', is_error: false, session_id: sessionId, stop_reason: 'end_turn', result: 'ok' });
      process.exit(0);
    }, (err) => {
      process.stderr.write(`fake-claude tools: ${err.message}\n`);
      process.exit(4);
    });
    return;
  }

  delta('Hello, ');

  if (mode === 'crash') {
    process.stderr.write('fake-claude: something went badly wrong\n');
    process.exit(3);
  }

  if (mode === 'slow') {
    delta('first half. ');
    setTimeout(() => {
      delta('second half.');
      emit({ type: 'result', subtype: 'success', session_id: sessionId, is_error: false });
      process.exit(0);
    }, Number(process.env.FAKE_CLAUDE_DELAY_MS || 400));
    return;
  }

  if (mode === 'hang' || mode === 'spawnchild') {
    if (mode === 'spawnchild') {
      const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        stdio: 'ignore',
      });
      if (process.env.FAKE_CLAUDE_PIDS_FILE) {
        fs.writeFileSync(
          process.env.FAKE_CLAUDE_PIDS_FILE,
          JSON.stringify({ child: process.pid, grandchild: grandchild.pid }),
        );
      }
    } else if (process.env.FAKE_CLAUDE_PIDS_FILE) {
      fs.writeFileSync(process.env.FAKE_CLAUDE_PIDS_FILE, JSON.stringify({ child: process.pid }));
    }
    setInterval(() => {}, 1000);
    return;
  }

  emit({
    type: 'assistant',
    session_id: sessionId,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'Read',
          input: { file_path: `${process.cwd()}/problems/two-sum/NOTES.md` },
        },
      ],
    },
  });

  delta('coach here.');

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    stop_reason: 'end_turn',
    result: 'Hello, coach here.',
    ...(process.env.FAKE_CLAUDE_USAGE ? {usage:JSON.parse(process.env.FAKE_CLAUDE_USAGE)} : {}),
  });
  process.exit(0);
}

/** Speak MCP to the configured studio server over stdio, as the real CLI would. */
async function studioTools() {
  const at = args.indexOf('--mcp-config');
  if (at === -1) throw new Error('no --mcp-config');
  const config = JSON.parse(fs.readFileSync(args[at + 1], 'utf8')).mcpServers.studio;
  const server = spawn(config.command, config.args, { env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pending = new Map();
  let buf = '';
  let seq = 0;
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      pending.get(msg.id)?.(msg);
      pending.delete(msg.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve) => {
    const id = ++seq;
    pending.set(id, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const record = (value) => {
    if (process.env.FAKE_CLAUDE_TOOL_RESULTS_FILE) fs.appendFileSync(process.env.FAKE_CLAUDE_TOOL_RESULTS_FILE, `${JSON.stringify(value)}\n`);
  };
  record({ token: config.env.STUDIO_TOOLS_TOKEN, url: config.env.STUDIO_TOOLS_URL, configPath: args[at + 1] });
  record({ initialize: (await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake' } })).result });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  record({ tools: (await rpc('tools/list', {})).result.tools.map((t) => t.name) });
  const said = [];
  for (const call of JSON.parse(process.env.FAKE_CLAUDE_TOOL_CALLS || '[]')) {
    emit({ type: 'assistant', session_id: sessionId, message: { role: 'assistant', content: [
      { type: 'tool_use', id: `tu_${seq}`, name: `mcp__studio__${call.tool}`, input: call.arguments ?? {} },
    ] } });
    const response = await rpc('tools/call', { name: call.tool, arguments: call.arguments ?? {} });
    record({ call: call.tool, result: response.result });
    said.push(response.result?.content?.[0]?.text ?? '');
  }
  server.kill();
  return said;
}
