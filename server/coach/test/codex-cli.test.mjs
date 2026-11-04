import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { buildArgs, runCoachTurn, listCodexModels, normalizeUsage, MCP_UNCONFIRMED, MCP_STARTED } from '../codex-cli.mjs';

test('usage normalization keeps cumulative maxima and unknown counters null', () => {
  let u = normalizeUsage({ usage: { input_tokens: 10, output_tokens: 2 } });
  assert.deepEqual(u, { inputTokens: 10, cacheReadInputTokens: null, cacheCreationInputTokens: null, outputTokens: 2, reasoningOutputTokens:null });
  u = normalizeUsage({ tokenUsage: { input_tokens: 10, output_tokens: 5 } }, u);
  assert.equal(u.inputTokens, 10); assert.equal(u.outputTokens, 5);
  u = normalizeUsage({ usage: { input_tokens: 8, output_tokens: 3 } }, u);
  assert.equal(u.inputTokens, 10); assert.equal(u.outputTokens, 5);
});

function fake({ finalOnly = false, failure = false, hang = false, approval = false, mcpPages = null, mcpError = false, mcpStarts = false, usageEvents=[] } = {}) {
  const requests = []; let child, opts, args;
  const emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  const spawnFn = (_binary, argv, options) => {
    opts = options; args = argv;
    child = new EventEmitter(); child.exitCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); };
    child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const m = JSON.parse(line); requests.push(m);
        if (!m.method || !m.id || hang) continue;
        setImmediate(() => {
          if (child.exitCode !== null) return;
          if (m.method === 'mcpServerStatus/list') {
            if (mcpError) return emit({ id: m.id, error: { code: -32601, message: 'Method not found' } });
            if (mcpPages) return emit({ id: m.id, result: mcpPages[m.params?.cursor ?? 'first'] });
          }
          if (m.method === 'thread/start' && mcpStarts) emit({ method: 'mcpServer/startupStatus/updated', params: { name: 'playwright', status: 'starting' } });
          const result = m.method === 'account/read' ? { account: { type: 'chatgpt' } }
            : m.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', displayName: 'Astra', private: 'excluded' }, { model: '--invalid' }] }
            : m.method === 'thread/start' ? { thread: { id: 'thread' } }
            : m.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
          emit({ id: m.id, result });
          if (m.method === 'turn/start') {
            for(const params of usageEvents)emit({method:'thread/tokenUsage/updated',params});
            if (approval) emit({ id: 90, method: 'item/commandExecution/requestApproval', params: {} });
            emit({ method: 'item/agentMessage/delta', params: { threadId: 'other-thread', delta: 'wrong' } });
            if (!finalOnly && !failure) emit({ method: 'item/agentMessage/delta', params: { threadId: 'thread', delta: 'reply' } });
            emit({ method: 'turn/completed', params: { threadId: 'thread', turn: failure
              ? { status: 'failed', error: { message: 'session limit reached' } }
              : { status: 'completed', items: [{ type: 'agentMessage', text: 'reply' }] } } });
          }
        });
      }
    });
    return child;
  };
  return { spawnFn, requests, get options() { return opts; }, get args() { return args; }, get child() { return child; } };
}

test('actual nested Codex usage totals include tool continuations once and ignore foreign threads',async()=>{
  const event=(threadId,inputTokens,outputTokens)=>({threadId,turnId:'turn',tokenUsage:{total:{inputTokens,cachedInputTokens:20,cacheWriteInputTokens:30,outputTokens,reasoningOutputTokens:4},last:{inputTokens:9,outputTokens:1}}});
  for(const failure of [false,true]){
    const f=fake({failure,usageEvents:[event('thread',100,5),event('thread',150,10),event('thread',150,10),event('other-thread',999999,8888)]});
    let usage;
    const turn=runCoachTurn({prompt:'q',spawnFn:f.spawnFn,onUsage:value=>{usage=value;}});await turn.exited;
    assert.deepEqual(usage,{inputTokens:150,cacheReadInputTokens:20,cacheCreationInputTokens:30,outputTokens:10,reasoningOutputTokens:4});
  }
});

test('streaming and final-only replies complete once, reuse local grouping, and release process/temp files', async () => {
  for (const finalOnly of [false, true]) {
    const f = fake({ finalOnly, approval: true }), tokens = [], done = [], errors = [];
    const turn = runCoachTurn({ prompt: 'question', resumeSessionId: 'local-group', spawnFn: f.spawnFn, env: { OPENAI_API_KEY: 'must-not-pass', STUDYCRAFT_RECALL_TOKEN: 'secret' },
      onToken: t => tokens.push(t), onDone: id => done.push(id), onError: e => errors.push(e) });
    await turn.exited;
    assert.deepEqual(tokens, ['reply']); assert.deepEqual(done, ['local-group']); assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(f.options.cwd), false);
    assert.equal(f.options.env.OPENAI_API_KEY, undefined);
    assert.equal(f.options.env.STUDYCRAFT_RECALL_TOKEN, undefined);
    assert.ok(f.requests.find(r => r.id === 90 && r.error));
    const thread = f.requests.find(r => r.method === 'thread/start').params;
    assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.model, 'gpt-6-astra');
    assert.ok(!f.requests.some(r => r.method === 'thread/resume'));
  }
});
test('runtime limit errors surface and release the child', async () => {
  const f = fake({ failure: true }); let error;
  const h = runCoachTurn({ prompt: 'q', spawnFn: f.spawnFn, onError: e => { error = e; } });
  await h.exited; assert.match(error, /session limit/); assert.equal(f.child.exitCode, 0);
});
test('timeout releases a stuck initializer, while manual stop emits no failure or reply', async () => {
  const f = fake({ hang: true }); let errors = 0;
  const h = runCoachTurn({ prompt: 'q', spawnFn: f.spawnFn, timeoutMs: 30, onError: () => errors++ });
  await h.exited; assert.equal(errors, 1);
  const stopped = fake({ hang: true }); let callbacks = 0;
  const s = runCoachTurn({ prompt: 'q', spawnFn: stopped.spawnFn, onDone: () => callbacks++, onError: () => callbacks++, onToken: () => callbacks++ });
  s.kill(); await s.exited; assert.equal(callbacks, 0); assert.equal(fs.existsSync(stopped.options.cwd), false);
});
test('missing executable fails without crashing the server, including catalog requests', async () => {
  let error;
  const h = runCoachTurn({ prompt: 'q', binary: '/no/such/studio-codex', onError: e => { error = e; } });
  await h.exited; assert.match(error, /not found/);
  await assert.rejects(listCodexModels({ binary: '/no/such/studio-codex' }), /not found/);
});
test('catalog exposes only model identifiers/labels and closes its process', async () => {
  const f = fake();
  assert.deepEqual(await listCodexModels({ spawnFn: f.spawnFn }), [{ id: 'gpt-6-astra', label: 'Astra' }]);
  assert.equal(f.child.exitCode, 0); assert.equal(fs.existsSync(f.options.cwd), false);
});
test('CLI flags restrict tools and use ChatGPT sign-in', () => {
  const args = buildArgs().join(' ');
  assert.match(args, /forced_login_method="chatgpt"/); assert.match(args, /web_search="disabled"/);
  for (const name of ['shell_tool', 'apps', 'plugins', 'multi_agent', 'hooks']) assert.ok(args.includes(`--disable ${name}`));
});

test('coach research enables live web at both boundaries while shell, images and MCP stay disabled', async () => {
  const f=fake({mcpPages:{first:{data:[{name:'unsafe-user-server'}],nextCursor:null}}}),errors=[];
  const h=runCoachTurn({prompt:'Check public documentation',webResearch:true,spawnFn:f.spawnFn,onError:e=>errors.push(e)});
  await h.exited;assert.deepEqual(errors,[]);
  assert.match(f.args.join(' '),/web_search="live"/);
  assert.ok(f.args.join(' ').includes('--disable shell_tool'));assert.ok(f.args.join(' ').includes('--disable image_generation'));
  const thread=f.requests.find(r=>r.method==='thread/start').params;
  assert.equal(thread.config.web_search,'live');assert.equal(thread.config.mcp_servers['unsafe-user-server'].enabled,false);
  assert.match(thread.baseInstructions,/Native web research is available/);assert.equal(thread.sandbox,'read-only');
});

test('chat never makes pictures, and only the visuals job may', () => {
  assert.ok(buildArgs().join(' ').includes('--disable image_generation'));
  const image = buildArgs({ imageGeneration: true }).join(' ');
  assert.ok(image.includes('--enable image_generation') && !image.includes('--disable image_generation'));
  assert.ok(image.includes('--disable shell_tool'));
});
test('every MCP server from the user config is disabled by name on the thread, across pages', async () => {
  const f = fake({ mcpPages: { first: { data: [{ name: 'playwright', status: 'x' }], nextCursor: 'p2' }, p2: { data: [{ name: 'node_repl' }], nextCursor: null } } });
  const done = [], errors = [];
  const h = runCoachTurn({ prompt: 'q', spawnFn: f.spawnFn, onDone: id => done.push(id), onError: e => errors.push(e) });
  await h.exited;
  assert.deepEqual(errors, []); assert.equal(done.length, 1);
  assert.ok(f.args.join(' ').includes('--disable image_generation'));
  const lists = f.requests.filter(r => r.method === 'mcpServerStatus/list');
  assert.deepEqual(lists.map(r => r.params), [{}, { cursor: 'p2' }]);
  const thread = f.requests.find(r => r.method === 'thread/start');
  assert.ok(f.requests.indexOf(lists[1]) < f.requests.indexOf(thread), 'listed before the thread starts');
  assert.deepEqual(thread.params.config.mcp_servers, { playwright: { enabled: false }, node_repl: { enabled: false } });
});
test('a tool server that cannot be listed fails closed before any thread exists', async () => {
  const f = fake({ mcpError: true }); let error;
  const h = runCoachTurn({ prompt: 'q', spawnFn: f.spawnFn, onError: e => { error = e; } });
  await h.exited;
  assert.equal(error, MCP_UNCONFIRMED);
  assert.ok(!f.requests.some(r => r.method === 'thread/start'));
  assert.equal(f.child.exitCode, 0);
});
test('a tool server that starts anyway stops the turn and the process', async () => {
  const f = fake({ mcpStarts: true }); let error; const tokens = [];
  const h = runCoachTurn({ prompt: 'q', spawnFn: f.spawnFn, onError: e => { error = e; }, onToken: t => tokens.push(t) });
  await h.exited;
  assert.equal(error, MCP_STARTED); assert.deepEqual(tokens, []);
  assert.equal(f.child.exitCode, 0);
});

test('persistent clients resume native state, rebind tools, reject stale calls, and report current usage', async () => {
  const os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-native-test-'));
  try {
    const requestsFile = path.join(dir, 'requests');
    const stateFile = path.join(dir, 'state');
    const resultsFile = path.join(dir, 'results');
    const toolSpecs = [{ name: 'get_state', description: 'Current workspace', inputSchema: { type: 'object' } }];
    let nativeId;
    for (let i = 0; i < 2; i++) {
      const calls = [], sessions = [], turns = [], compactions = [], usage = [], tokens = [], errors = [], done = [];
      let persisted = false, doneYet = false;
      const h = runCoachTurn({
        binary: new URL('./bin/fake-codex.mjs', import.meta.url).pathname,
        persistentSession: true, resumeSessionId: nativeId, prompt: 'prompt-' + i,
        env: { ...process.env, FAKE_CODEX_STATE_FILE: stateFile, FAKE_CODEX_REQUESTS_FILE: requestsFile,
          FAKE_CODEX_MCP_NAMES: 'unsafe-browser,unsafe-shell', FAKE_CODEX_TOOL_RESULTS_FILE: resultsFile,
          FAKE_CODEX_TOOL_CALLS: JSON.stringify([
            { tool: 'get_state', threadId: 'other-thread' }, { tool: 'get_state', turnId: 'old-turn' }, { tool: 'get_state' },
          ]) },
        toolSpecs, toolSession: { async call(name) { calls.push(name); return { ok: true, text: 'callback-' + i }; } },
        async onSessionId(id) {
          sessions.push(id);
          await new Promise(resolve => setTimeout(resolve, 10));
          const log = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse);
          assert.equal(log.filter(r => r.method === 'turn/start').length, i);
          persisted = true;
        },
        onTurnId: id => turns.push(id), onCompaction: meta => compactions.push(meta),
        onUsage: u => usage.push(u), onToken: t => { assert.ok(persisted); assert.equal(doneYet, false); tokens.push(t); },
        onDone: id => { doneYet = true; done.push(id); }, onError: e => errors.push(e),
      });
      await h.exited;
      assert.deepEqual(errors, []); assert.deepEqual(sessions, ['fixture-thread']);
      assert.deepEqual(done, sessions); nativeId = done[0];
      assert.deepEqual(turns, ['fixture-turn-' + (i + 1)]);
      assert.deepEqual(calls, ['get_state']); assert.equal(compactions.length, 1);
      assert.equal(usage.at(-1).inputTokens, 150); assert.equal(usage.at(-1).outputTokens, 15);
      assert.match(tokens.join(''), new RegExp('callback-' + i)); assert.equal(tokens[0], 'Early token. ');
    }
    const state = JSON.parse(fs.readFileSync(stateFile));
    assert.deepEqual(state.prompts, ['prompt-0', 'prompt-1']);
    assert.equal(state.dynamicTools[0].name, 'get_state');
    const log = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse);
    const threads = log.filter(r => /^thread\/(start|resume)$/.test(r.method));
    assert.deepEqual(threads.map(r => r.method), ['thread/start', 'thread/resume']);
    assert.equal(threads[0].params.ephemeral, false);
    for (const { params } of threads) {
      assert.equal(params.approvalPolicy, 'never'); assert.equal(params.sandbox, 'read-only');
      assert.deepEqual(params.config.tools, {});
      assert.deepEqual(params.config.mcp_servers, { 'unsafe-browser': { enabled: false }, 'unsafe-shell': { enabled: false } });
      assert.equal(params.config.web_search, 'disabled');
    }
    const results = fs.readFileSync(resultsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(results.filter(r => r.error).length, 4);
    let error;
    const failed = runCoachTurn({ binary: new URL('./bin/fake-codex.mjs', import.meta.url).pathname,
      persistentSession: true, resumeSessionId: 'missing', prompt: 'never sent',
      env: { ...process.env, FAKE_CODEX_STATE_FILE: stateFile, FAKE_CODEX_REQUESTS_FILE: requestsFile },
      onError: e => { error = e; } });
    await failed.exited; assert.match(error, /Session not found/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile)).prompts.length, 2);
    const after = fs.readFileSync(requestsFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(after.filter(r => r.method === 'thread/start').length, 1);
    assert.equal(after.filter(r => r.method === 'turn/start').length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('session persistence failure prevents starting a Codex turn', async () => {
  const f = fake(); let error;
  const h = runCoachTurn({ prompt: 'q', persistentSession: true, spawnFn: f.spawnFn,
    onSessionId: async () => { throw new Error('storage failed'); }, onError: e => { error = e; } });
  await h.exited;
  assert.match(error, /storage failed/);
  assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
});
