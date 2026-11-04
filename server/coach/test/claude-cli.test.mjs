import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import {
  runCoachTurn,
  buildArgs,
  permissionArgs,
  interpretLine,
  summariseToolUse,
} from '../claude-cli.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'bin', 'fake-claude.mjs');

test('native web research is opt-in without expanding file, shell or MCP access', () => {
  for (const enabled of [false,true]) {
    const args=buildArgs({root:'/r',tools:'',webResearch:enabled,studioContext:true});
    const allowed=args.slice(args.indexOf('--allowedTools')+1,args.indexOf('--disallowedTools'));
    const denied=args.slice(args.indexOf('--disallowedTools')+1,args.indexOf('--setting-sources'));
    assert.equal(args[args.indexOf('--tools')+1],enabled?'WebSearch,WebFetch':'');
    for(const name of ['WebSearch','WebFetch']){assert.equal(allowed.includes(name),enabled);assert.equal(denied.includes(name),!enabled);}
    assert.ok(denied.includes('Bash'));assert.ok(args.includes('--strict-mcp-config'));
    assert.ok(!allowed.some(rule=>/^(Read|Write|Edit|Glob)/.test(rule)));
  }
});

async function tempRoot() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'studio-cli-'));
}

function collect(overrides) {
  const seen = { tokens: [], tools: [], done: null, error: null };
  const handle = runCoachTurn({
    onToken: (t) => seen.tokens.push(t),
    onTool: (name, summary) => seen.tools.push({ name, summary }),
    onDone: (sessionId, stoppedReason) => {
      seen.done = { sessionId, stoppedReason };
    },
    onError: (message) => {
      seen.error = message;
    },
    ...overrides,
  });
  return { seen, handle };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// ---------------------------------------------------------------------------- arguments

test('the invocation never bypasses permissions, in any form', () => {
  const args = buildArgs({ root: '/Users/x/LeetCodeTutor', resumeSessionId: null });
  const joined = args.join(' ');
  assert.ok(!joined.includes('bypassPermissions'));
  assert.ok(!joined.includes('--dangerously-skip-permissions'));
  assert.ok(!joined.includes('--allow-dangerously-skip-permissions'));
  assert.ok(joined.includes('--permission-mode manual'));
});

test('the invocation asks for streaming JSON with partial messages', () => {
  const args = buildArgs({ root: '/r', resumeSessionId: null });
  assert.ok(args.includes('-p'));
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--include-partial-messages'));
  assert.ok(args.includes('--verbose')); // stream-json under -p requires it
  assert.ok(args.includes('--strict-mcp-config')); // no MCP servers for the coach
});

test('the built-in tool set is Read/Glob/Write/Edit and nothing else', () => {
  const args = buildArgs({ root: '/r', resumeSessionId: null });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Glob,Write,Edit');
});

test('permissions are scoped to the workspace, and the server-owned files are denied', () => {
  const root = '/Users/x/LeetCodeTutor';
  const abs = root.replace(/^\/+/, ''); // `//abs/path` is the absolute-rule spelling
  const { allow, deny } = permissionArgs(root);

  for (const rule of allow) {
    assert.ok(rule.includes(`(//${abs}/`), `allow rule not scoped to the workspace: ${rule}`);
    assert.ok(!rule.includes('///'), `malformed absolute rule: ${rule}`);
  }
  assert.ok(allow.includes(`Read(//${abs}/**)`));
  assert.ok(allow.includes(`Glob(//${abs}/**)`));

  // Writable: exactly the coach's own memory.
  assert.ok(allow.includes(`Write(//${abs}/problems/*/NOTES.md)`));
  assert.ok(allow.includes(`Write(//${abs}/problems/*/debriefs/**)`));

  // Not writable, anywhere in the allow list.
  const allowJoined = allow.join(' ');
  for (const forbidden of ['meta.json', 'index.json', 'solution.py', 'sessions/']) {
    assert.ok(!allowJoined.includes(forbidden), `${forbidden} must not be writable`);
  }
  // And denied by name, because deny beats allow.
  for (const rule of [
    `Write(//${abs}/problems/*/meta.json)`,
    `Write(//${abs}/problems/*/solution.py)`,
    `Write(//${abs}/problems/*/sessions/**)`,
    `Write(//${abs}/index.json)`,
  ]) {
    assert.ok(deny.includes(rule), `missing deny rule: ${rule}`);
  }
  assert.ok(deny.includes('Bash'));
  assert.ok(deny.includes('WebFetch'));
});

test('the low-level CLI wrapper accepts explicit native session options', () => {
  const resumed = buildArgs({ root: '/r', resumeSessionId: 'abc-123' });
  assert.equal(resumed[resumed.indexOf('--resume') + 1], 'abc-123');
  assert.ok(!resumed.includes('--session-id'));
  const fresh = buildArgs({ root: '/r', resumeSessionId: null });
  assert.ok(!fresh.includes('--resume'));
  assert.match(
    fresh[fresh.indexOf('--session-id') + 1],
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

// ------------------------------------------------------------------------ line handling

test('interpretLine turns text deltas into tokens and completed tool_use into tool events', () => {
  const state = { root: '/r' };
  assert.deepEqual(
    interpretLine(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } },
      },
      state,
    ),
    [{ kind: 'token', text: 'hi' }],
  );

  // A partial tool input must NOT produce a tool event — half a filename is worse than none.
  assert.deepEqual(
    interpretLine(
      {
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"fi' } },
      },
      state,
    ),
    [],
  );

  assert.deepEqual(
    interpretLine(
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/r/problems/two-sum/NOTES.md' } }],
        },
      },
      state,
    ),
    [{ kind: 'tool', name: 'Read', summary: 'problems/two-sum/NOTES.md' }],
  );
});

test('Claude post-tool assistant echo is suppressed only at a message boundary', () => {
  const s = { root: '/r' };
  const start = () => interpretLine({ type: 'stream_event', event: { type: 'message_start' } }, s);
  start();
  assert.deepEqual(interpretLine({ type:'stream_event', event:{ type:'content_block_delta', index:0, delta:{type:'text_delta',text:'Yes'}}},s), [{kind:'token',text:'Yes'}]);
  assert.deepEqual(interpretLine({ type:'assistant', message:{content:[{type:'tool_use',name:'record_session',input:{}}]}},s).map(x=>x.kind), ['tool']);
  start();
  // Chunked exact echo stays buffered, including the separator.
  assert.deepEqual(interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Y'}}},s),[]);
  assert.deepEqual(interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'es'}}},s),[]);
  assert.deepEqual(interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:' indeed'}}},s), [{kind:'token',text:' indeed'}]);
});

test('echo filter flushes divergent/shorter text and does not dedup same-message repetition', () => {
  const s = {};
  const start = () => interpretLine({type:'stream_event',event:{type:'message_start'}},s);
  start(); interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'Yes'}}},s);
  interpretLine({type:'assistant',message:{content:[{type:'tool_use',name:'record_session',input:{}}]}},s); start();
  assert.deepEqual(interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'No'}}},s), [{kind:'token',text:'\n\n'},{kind:'token',text:'No'}]);
  assert.deepEqual(interpretLine({type:'stream_event',event:{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'No'}}},s), [{kind:'token',text:'No'}]);
});

test('a result with is_error becomes one plain-English error, not a done', () => {
  const [item] = interpretLine(
    { type: 'result', is_error: true, result: 'Invalid API key · Please run /login', session_id: 's' },
    {},
  );
  assert.equal(item.kind, 'error');
  assert.match(item.message, /not signed in/i);
});

test('tool summaries are workspace-relative and never leak an absolute home path', () => {
  assert.equal(
    summariseToolUse({ name: 'Write', input: { file_path: '/root/problems/x/NOTES.md' } }, '/root'),
    'problems/x/NOTES.md',
  );
  assert.equal(summariseToolUse({ name: 'Glob', input: { pattern: '**/NOTES.md' } }, '/root'), '**/NOTES.md');
});

// ---------------------------------------------------------------------------- streaming

test('a normal turn streams tokens, a tool event, then done', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({ root, prompt: 'hello', binary: FAKE, env: { ...process.env, FAKE_CLAUDE_MODE: 'ok' } });
  await handle.exited;
  assert.equal(seen.error, null);
  assert.equal(seen.tokens.join(''), 'Hello, coach here.');
  assert.deepEqual(seen.tools, [{ name: 'Read', summary: 'problems/two-sum/NOTES.md' }]);
  assert.equal(seen.done.stoppedReason, 'end_turn');
});

test('stream diagnostics distinguish provider arrival and delivery before completion without content', async t => {
  const root = await tempRoot(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let stats, published = false;
  const { seen, handle } = collect({ root, prompt: 'PRIVATE QUESTION', binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '100' },
    onStreamStats: value => { stats = value; published = true; },
    onDone: () => assert.equal(published, true),
  });
  await handle.exited;
  assert.equal(seen.error, null); assert.equal(stats.rawTextDeltaCount, 3);
  assert.equal(stats.forwardedChunkCount, 3); assert.ok(stats.stdoutDataBatchesWithText >= 2);
  assert.ok(stats.lastRawTextDeltaMs - stats.firstRawTextDeltaMs >= 70);
  assert.ok(stats.firstForwardedTokenMs < stats.lastRawTextDeltaMs);
  assert.ok(stats.firstForwardedTokenMs >= stats.firstRawTextDeltaMs);
  assert.ok(stats.largestRawTextDeltaChars > 0);
  assert.doesNotMatch(JSON.stringify(stats), /Hello|PRIVATE|first half/);
});
test('diagnostics include the final stdout batch and cannot break a turn', async t => {
  const root = await tempRoot(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let observed;
  const { seen, handle } = collect({ root, prompt: 'test', binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'tool-echo' },
    onStreamStats: stats => { observed = stats; throw Error('Observer failure'); },
  });
  await handle.exited;
  assert.equal(seen.error, null); assert.ok(seen.done);
  assert.ok(observed.stdoutDataBatchesWithText > 0);
  assert.ok(observed.rawTextDeltaCount > observed.forwardedChunkCount);
  assert.equal(seen.tokens.join(''), 'Yes, size matters. Each package is small, medium or large.');
});

test('the prompt reaches the CLI on stdin, and cwd is the workspace root', async () => {
  const root = await tempRoot();
  const promptFile = path.join(root, 'prompt.txt');
  const argsFile = path.join(root, 'args.json');
  const { handle } = collect({
    root,
    prompt: '## CURRENT CONTEXT\nSlug: two-sum\n',
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'ok', FAKE_CLAUDE_PROMPT_FILE: promptFile, FAKE_CLAUDE_ARGS_FILE: argsFile },
  });
  await handle.exited;
  assert.equal(await fsp.readFile(promptFile, 'utf8'), '## CURRENT CONTEXT\nSlug: two-sum\n');
  const args = JSON.parse(await fsp.readFile(argsFile, 'utf8'));
  assert.ok(args.includes('--include-partial-messages'));
});

test('a missing binary produces exactly one error event and no crash', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({
    root,
    prompt: 'x',
    binary: path.join(root, 'definitely-not-installed-claude'),
  });
  await handle.exited;
  assert.equal(seen.done, null);
  assert.match(seen.error, /not found on this machine/);
  assert.match(seen.error, /Everything else in Studio still works/);
});

test('a child that dies mid-stream produces one error, and the partial tokens already sent stand', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({ root, prompt: 'x', binary: FAKE, env: { ...process.env, FAKE_CLAUDE_MODE: 'crash' } });
  await handle.exited;
  assert.deepEqual(seen.tokens, ['Hello, ']);
  assert.equal(seen.done, null);
  assert.match(seen.error, /stopped unexpectedly \(exit code 3\)/);
  assert.match(seen.error, /something went badly wrong/);
});

test('an unresumable session id is reported as such rather than as a generic crash', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({
    root,
    prompt: 'x',
    resumeSessionId: 'long-gone', persistentSession: true,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'noresume' },
  });
  await handle.exited;
  assert.match(seen.error, /could not resume the earlier conversation/);
  assert.equal(handle.resumeFailed, true);
});

test('an unresumable session reported in the result stream is recognised too', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({
    root,
    prompt: 'x',
    resumeSessionId: 'long-gone', persistentSession: true,
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'noresume-result' },
  });
  await handle.exited;
  assert.match(seen.error, /could not resume the earlier conversation/);
  assert.equal(handle.resumeFailed, true);
});

test('an authentication failure reported in the result stream is said in plain English', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({ root, prompt: 'x', binary: FAKE, env: { ...process.env, FAKE_CLAUDE_MODE: 'apierror' } });
  await handle.exited;
  assert.equal(seen.done, null);
  assert.match(seen.error, /not signed in/i);
});

test('kill() takes down the child and its grandchildren — no orphan is left behind', async () => {
  const root = await tempRoot();
  const pidsFile = path.join(root, 'pids.json');
  const { handle } = collect({
    root,
    prompt: 'x',
    binary: FAKE,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'spawnchild', FAKE_CLAUDE_PIDS_FILE: pidsFile },
  });

  // Wait for the fake to have forked its grandchild.
  let pids;
  for (let i = 0; i < 100 && !pids; i += 1) {
    try {
      pids = JSON.parse(await fsp.readFile(pidsFile, 'utf8'));
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  assert.ok(pids?.grandchild, 'fake-claude never reported its pids');
  assert.ok(pidAlive(pids.child) && pidAlive(pids.grandchild));

  handle.kill();
  await handle.exited;

  // SIGTERM to the group; give the OS a moment to reap.
  for (let i = 0; i < 100 && (pidAlive(pids.child) || pidAlive(pids.grandchild)); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(pidAlive(pids.child), false, 'the CLI process leaked');
  assert.equal(pidAlive(pids.grandchild), false, 'a grandchild process leaked');

  // Cross-check with the OS rather than trusting our own bookkeeping.
  let survivors = '';
  try {
    survivors = execFileSync('/bin/ps', ['-o', 'pid=', '-p', `${pids.child},${pids.grandchild}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    survivors = ''; // ps exits non-zero when it matches nothing, which is the pass case
  }
  assert.equal(survivors, '');
});

test('a hung child is stopped by the turn timeout with one honest error', async () => {
  const root = await tempRoot();
  const { seen, handle } = collect({
    root,
    prompt: 'x',
    binary: FAKE,
    timeoutMs: 300,
    env: { ...process.env, FAKE_CLAUDE_MODE: 'hang' },
  });
  await handle.exited;
  assert.equal(seen.done, null);
  assert.match(seen.error, /longer than ten minutes|was stopped/);
  assert.match(seen.error, /Your work is untouched/);
});

test('answer tools are read-only; upkeep forks the full scoped permission set without persistence', () => {
  const answer = buildArgs({ root: '/tmp/fixture', tools: 'Read,Glob' });
  assert.equal(answer[answer.indexOf('--tools') + 1], 'Read,Glob');
  const allow = answer.slice(answer.indexOf('--allowedTools') + 1, answer.indexOf('--disallowedTools'));
  assert.ok(allow.every(rule => /^(Read|Glob)\(/.test(rule)));
  assert.deepEqual(answer.slice(answer.indexOf('--disallowedTools') + 1, answer.indexOf('--session-id')), permissionArgs('/tmp/fixture').deny);
  const upkeep = buildArgs({ root: '/tmp/fixture', resumeSessionId: 'original', forkSession: true, noSessionPersistence: true });
  assert.equal(upkeep[upkeep.indexOf('--resume') + 1], 'original');
  assert.ok(upkeep.includes('--fork-session'));
  assert.ok(upkeep.includes('--no-session-persistence'));
  assert.equal(upkeep[upkeep.indexOf('--tools') + 1], 'Read,Glob,Write,Edit');
});

test('submission code and sidecars are denied to both Write and Edit', () => {
  const { deny } = permissionArgs('/scratch');
  for (const tool of ['Write', 'Edit']) assert.ok(deny.includes(`${tool}(//scratch/problems/*/submissions/**)`));
});


test('recall outbox and mappings are server-owned, including delivery secrets', () => {
  const { deny } = permissionArgs('/scratch');
  for (const tool of ['Read', 'Glob', 'Write', 'Edit']) {
    assert.ok(deny.includes(`${tool}(//scratch/recall/**)`));
  }
});

test('Studycraft import credentials never reach the Claude subprocess', async t => {
  const root = await tempRoot(); t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let received;
  const { handle } = collect({ root, prompt: 'test', env: { STUDYCRAFT_RECALL_TOKEN: 'secret', TEST: 'kept' },
    spawnFn: (_binary, _args, options) => { received = options.env; throw Object.assign(Error('fake'), { code: 'ENOENT' }); } });
  await handle.exited;
  assert.equal(received.STUDYCRAFT_RECALL_TOKEN, undefined);
  assert.equal(received.TEST, 'kept');
});

test('persistent Claude clients resume native state with fresh MCP config and compaction boundaries', async () => {
  const root = await tempRoot();
  try {
    const stateFile = path.join(root, 'native-state.json'), argsFile = path.join(root, 'args.json');
    let nativeId;
    for (let i = 0; i < 2; i++) {
      const sessions = [], compact = [];
      let persisted = false;
      const streamed = [];
      const config = path.join(root, 'mcp-' + i + '.json');
      const helper = `
        const readline = require('node:readline');
        readline.createInterface({ input: process.stdin }).on('line', line => {
          const r = JSON.parse(line); if (!r.id) return;
          const result = r.method === 'tools/list' ? { tools: [{ name: 'get_state' }] }
            : r.method === 'tools/call' ? { content: [{ type: 'text', text: process.env.STUDIO_TOOLS_TOKEN }] } : {};
          process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: r.id, result }) + '\\n');
        });
      `;
      await fsp.writeFile(config, JSON.stringify({ mcpServers: { studio: {
        command: process.execPath, args: ['-e', helper], env: { STUDIO_TOOLS_TOKEN: 'fresh-token-' + i },
      } } }));
      const { handle, seen } = collect({
        root, binary: FAKE, prompt: 'prompt-' + i, persistentSession: true, resumeSessionId: nativeId,
        mcpConfigPath: config, studioTools: ['get_state'], tools: '', studioContext: true,
        noSessionPersistence: true, forkSession: true, // persistent mode must override these
        env: { ...process.env, FAKE_CLAUDE_STATE_FILE: stateFile, FAKE_CLAUDE_ARGS_FILE: argsFile,
          FAKE_CLAUDE_MODE: 'tools', FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ tool: 'get_state' }]) },
        async onSessionId(id) {
          sessions.push(id);
          await new Promise(resolve => setTimeout(resolve, 10));
          const state = await fsp.readFile(stateFile, 'utf8').then(JSON.parse).catch(() => ({}));
          assert.equal(state[id]?.length ?? 0, i);
          persisted = true;
        },
        onCompaction: meta => compact.push(meta),
        onToken: text => { assert.ok(persisted); streamed.push(text); },
      });
      await handle.exited;
      assert.equal(seen.error, null); assert.equal(sessions.length, 1);
      assert.match(streamed.join(''), new RegExp('fresh-token-' + i));
      assert.equal(seen.done.sessionId, sessions[0]);
      if (nativeId) assert.equal(sessions[0], nativeId);
      nativeId = sessions[0];
      assert.deepEqual(compact, [{ trigger: 'auto', pre_tokens: 100 }]);
      const args = JSON.parse(await fsp.readFile(argsFile));
      assert.equal(args[args.indexOf('--mcp-config') + 1], config);
      assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
      assert.ok(!args.includes('--no-session-persistence')); assert.ok(!args.includes('--fork-session'));
      assert.equal(args.includes('--resume'), i === 1);
      assert.ok(args.includes('mcp__studio__get_state'));
    }
    assert.deepEqual(JSON.parse(await fsp.readFile(stateFile))[nativeId], ['prompt-0', 'prompt-1']);
    const { handle, seen } = collect({ root, binary: FAKE, prompt: 'never',
      persistentSession: true, resumeSessionId: 'missing',
      env: { ...process.env, FAKE_CLAUDE_STATE_FILE: stateFile } });
    await handle.exited;
    assert.match(seen.error, /could not resume/); assert.equal(seen.done, null);
    assert.deepEqual(Object.keys(JSON.parse(await fsp.readFile(stateFile))), [nativeId]);
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});

test('Claude requires explicit persistence for native resume and awaits session storage before prompt', async () => {
  const root = await tempRoot();
  try {
    const argsFile = path.join(root, 'args.json'), promptFile = path.join(root, 'prompt');
    const fresh = collect({ root, binary: FAKE, prompt: 'fresh', resumeSessionId: 'ignored',
      env: { ...process.env, FAKE_CLAUDE_ARGS_FILE: argsFile } });
    await fresh.handle.exited;
    assert.ok(!JSON.parse(await fsp.readFile(argsFile)).includes('--resume'));
    const failed = collect({ root, binary: FAKE, prompt: 'never', persistentSession: true,
      env: { ...process.env, FAKE_CLAUDE_PROMPT_FILE: promptFile },
      onSessionId: async () => { throw new Error('session storage failed'); } });
    await failed.handle.exited;
    assert.match(failed.seen.error, /session storage failed/);
    assert.equal(failed.seen.done, null);
    await assert.rejects(fsp.access(promptFile));
  } finally { await fsp.rm(root, { recursive: true, force: true }); }
});
