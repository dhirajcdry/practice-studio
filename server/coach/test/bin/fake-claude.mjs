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
//
// FAKE_CLAUDE_ARGS_FILE / FAKE_CLAUDE_PROMPT_FILE capture what we were invoked with.

import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const mode = process.env.FAKE_CLAUDE_MODE || 'ok';

if (process.env.FAKE_CLAUDE_ARGS_FILE) {
  fs.writeFileSync(process.env.FAKE_CLAUDE_ARGS_FILE, JSON.stringify(args, null, 2));
}

const resumeIdx = args.indexOf('--resume');
const sessionIdx = args.indexOf('--session-id');
const sessionId =
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
  if (process.env.FAKE_CLAUDE_PROMPT_FILE) {
    fs.writeFileSync(process.env.FAKE_CLAUDE_PROMPT_FILE, prompt);
  }
  run();
});

function run() {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd() });

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
  });
  process.exit(0);
}
