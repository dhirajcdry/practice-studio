import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import { buildArgs, runCoachTurn, listCodexModels } from '../codex-cli.mjs';

function fake({ finalOnly = false, failure = false, hang = false, approval = false } = {}) {
  const requests = []; let child, opts;
  const emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  const spawnFn = (_binary, args, options) => {
    opts = options;
    child = new EventEmitter(); child.exitCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); };
    child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const m = JSON.parse(line); requests.push(m);
        if (!m.method || !m.id || hang) continue;
        setImmediate(() => {
          if (child.exitCode !== null) return;
          const result = m.method === 'account/read' ? { account: { type: 'chatgpt' } }
            : m.method === 'model/list' ? { data: [{ model: 'gpt-6-astra', displayName: 'Astra', private: 'excluded' }, { model: '--invalid' }] }
            : m.method === 'thread/start' ? { thread: { id: 'thread' } }
            : m.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
          emit({ id: m.id, result });
          if (m.method === 'turn/start') {
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
  return { spawnFn, requests, get options() { return opts; }, get child() { return child; } };
}

test('streaming and final-only replies complete once, reuse local grouping, and release process/temp files', async () => {
  for (const finalOnly of [false, true]) {
    const f = fake({ finalOnly, approval: true }), tokens = [], done = [], errors = [];
    const turn = runCoachTurn({ prompt: 'question', resumeSessionId: 'local-group', spawnFn: f.spawnFn, env: { OPENAI_API_KEY: 'must-not-pass' },
      onToken: t => tokens.push(t), onDone: id => done.push(id), onError: e => errors.push(e) });
    await turn.exited;
    assert.deepEqual(tokens, ['reply']); assert.deepEqual(done, ['local-group']); assert.deepEqual(errors, []);
    assert.equal(fs.existsSync(f.options.cwd), false);
    assert.equal(f.options.env.OPENAI_API_KEY, undefined);
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
