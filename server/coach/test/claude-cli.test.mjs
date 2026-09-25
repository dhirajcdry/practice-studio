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

test('a stored session id becomes --resume; no stored id becomes a fresh --session-id uuid', () => {
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
    resumeSessionId: 'long-gone',
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
    resumeSessionId: 'long-gone',
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
