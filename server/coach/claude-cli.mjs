// The bridge to the `claude` CLI.
//
// Invocation (verified against claude 2.1.220 — `claude --help`, then a real call):
//
//   claude -p --output-format stream-json --include-partial-messages --verbose \
//          --strict-mcp-config --permission-mode manual \
//          --tools Read,Glob,Write,Edit \
//          --allowedTools 'Read(//~/LeetCodeTutor/**)' … \
//          --disallowedTools 'Write(//~/LeetCodeTutor/problems/*/solution.py)' … \
//          (--session-id <uuid> | --resume <id>)
//
// with cwd = ~/LeetCodeTutor and the prompt written to stdin.
//
// Why each flag:
//   -p                          non-interactive; there is no terminal on the other end
//   --output-format stream-json newline-delimited JSON, one object per line
//   --include-partial-messages  the incremental text deltas; without it, text arrives in
//                               one lump at the end of each block and "streaming" is a lie
//   --verbose                   required for stream-json under -p
//   --strict-mcp-config         no --mcp-config given, so this disables every MCP server.
//                               The coach has no business talking to Gmail or Notion.
//   --permission-mode manual    the default. Explicit because the alternative that would
//                               "just make it work" is bypassPermissions, and that is
//                               settled: never. The coach reads LeetCode HTML and
//                               third-party markdown; those are untrusted inputs, and an
//                               untrusted input plus unchecked tool use is the whole risk.
//   --tools                     the built-in tool set, restricted at the source. Bash,
//                               WebFetch, WebSearch and Task are simply absent.
//   --allowedTools/--disallowedTools   path scoping, deny winning over allow.
//
// Under -p there is no one to answer a permission prompt, so anything not allow-listed is
// denied rather than hanging. That is the correct failure direction.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';

function realpathOrNull(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return null;
  }
}

/** Hard ceiling on one turn. A coach that has been thinking for ten minutes is stuck. */
export const TURN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Permission arguments for a workspace root.
 * Write access is granted to exactly what the coach owns and nothing else; the four
 * server-owned files are additionally denied by name, because deny beats allow and a
 * belt-and-braces rule costs nothing.
 */
export function permissionArgs(root) {
  // Claude Code spells an absolute-path rule `Tool(//abs/path/**)` — the leading `//`
  // is the marker, not part of the path, so the root's own leading slash is dropped.
  const abs = String(root).replace(/^\/+/, '');
  const p = (t, rel) => `${t}(//${abs}${rel})`;
  const allow = [
    p('Read', '/**'),
    p('Glob', '/**'),
    // The coach's own memory, per CLAUDE.md: notes, debriefs, journal, profile, skills.
    p('Write', '/problems/*/NOTES.md'),
    p('Edit', '/problems/*/NOTES.md'),
    p('Write', '/problems/*/debriefs/**'),
    p('Edit', '/problems/*/debriefs/**'),
    p('Write', '/journal/**'),
    p('Edit', '/journal/**'),
    p('Write', '/TUTOR.md'),
    p('Edit', '/TUTOR.md'),
    p('Write', '/skills/**'),
    p('Edit', '/skills/**'),
    // System design has the same shape of memory as the coding side: a per-interview
    // note, and one file tracking what keeps going wrong across all of them.
    p('Write', '/design/*/NOTES.md'),
    p('Edit', '/design/*/NOTES.md'),
    p('Write', '/DESIGN.md'),
    p('Edit', '/DESIGN.md'),
  ];
  const deny = [
    // The server owns these. Stated in the prompt and enforced here, because a rule that
    // lives only in a prompt is a request, not a boundary.
    p('Write', '/problems/*/meta.json'),
    p('Edit', '/problems/*/meta.json'),
    p('Write', '/problems/*/solution.py'),
    p('Edit', '/problems/*/solution.py'),
    p('Write', '/problems/*/sessions/**'),
    p('Edit', '/problems/*/sessions/**'),
    p('Write', '/problems/*/attempts/**'),
    p('Edit', '/problems/*/attempts/**'),
    p('Write', '/problems/*/coach-session.json'),
    p('Edit', '/problems/*/coach-session.json'),
    p('Write', '/index.json'),
    p('Edit', '/index.json'),
    // An interview's own record. The transcript, the boards and the state machine are
    // the only evidence of what was actually asked, drawn and answered — a debrief that
    // grades an edited record grades nothing. Reading them is the point; writing them
    // is never the model's job. interview.md is derived and is rewritten from these.
    p('Write', '/design/*/interview.json'),
    p('Edit', '/design/*/interview.json'),
    p('Write', '/design/*/turns.jsonl'),
    p('Edit', '/design/*/turns.jsonl'),
    p('Write', '/design/*/scenes/**'),
    p('Edit', '/design/*/scenes/**'),
    p('Write', '/design/*/interview.md'),
    p('Edit', '/design/*/interview.md'),
    'Bash',
    'WebFetch',
    'WebSearch',
    'Task',
    'NotebookEdit',
  ];
  return { allow, deny };
}

/**
 * @param {object} o
 * @param {string} o.root workspace root, also the cwd
 * @param {string|null} o.resumeSessionId session to resume, or null to start a new one
 * @param {string} [o.newSessionId] uuid to use when starting fresh
 */
export function buildArgs({ root, resumeSessionId, newSessionId }) {
  const { allow, deny } = permissionArgs(root);
  const args = [
    '-p',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--strict-mcp-config',
    '--permission-mode',
    'manual',
    '--tools',
    'Read,Glob,Write,Edit',
    '--allowedTools',
    ...allow,
    '--disallowedTools',
    ...deny,
  ];
  if (resumeSessionId) args.push('--resume', resumeSessionId);
  else args.push('--session-id', newSessionId ?? crypto.randomUUID());
  return args;
}

/** Turn one JSON line from the CLI into zero or more things the browser cares about. */
export function interpretLine(obj, state) {
  const out = [];
  if (!obj || typeof obj !== 'object') return out;

  if (typeof obj.session_id === 'string' && obj.session_id !== '') {
    state.sessionId = obj.session_id;
  }

  if (obj.type === 'stream_event') {
    const ev = obj.event;
    // Text deltas only. Tool events come from the completed assistant message, where the
    // tool input is whole — a partial `input_json_delta` would give us half a filename.
    if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
      // A turn that pauses to call a tool resumes in a NEW text block. Without a break
      // between them the two run together mid-sentence — "…convention named.Your move…"
      // — which reads as a rendering fault. Separate them once, on the first delta of a
      // block that follows earlier text.
      if (state.emittedText && state.blockIndex !== ev.index) {
        out.push({ kind: 'token', text: '\n\n' });
      }
      state.blockIndex = ev.index;
      state.emittedText = true;
      out.push({ kind: 'token', text: ev.delta.text });
    }
    return out;
  }

  if (obj.type === 'assistant') {
    for (const block of obj.message?.content ?? []) {
      if (block?.type === 'tool_use') {
        out.push({ kind: 'tool', name: block.name, summary: summariseToolUse(block, state.root) });
      }
    }
    return out;
  }

  if (obj.type === 'result') {
    state.sawResult = true;
    if (obj.is_error) {
      out.push({
        kind: 'error',
        message: plainResultError(obj),
        detail: resultErrorText(obj),
      });
    } else {
      out.push({
        kind: 'done',
        sessionId: obj.session_id ?? state.sessionId ?? null,
        stoppedReason: obj.stop_reason ?? obj.subtype ?? 'end_turn',
      });
    }
  }

  return out;
}

/**
 * Strip the workspace prefix off a path.
 * `root` may be several strings: on macOS the CLI reports `/private/var/…` for a path we
 * know as `/var/…`, so the resolved realpath is passed alongside the configured root.
 * Without this, a `tool` event shows the user their absolute home path instead of
 * `problems/two-sum/NOTES.md`.
 */
function relativise(value, root) {
  if (typeof value !== 'string') return '';
  const roots = (Array.isArray(root) ? root : [root]).filter(Boolean);
  for (const r of roots) {
    if (value.startsWith(`${r}/`)) return value.slice(r.length + 1);
  }
  return value;
}

/** A short human summary of a tool call, for the `tool` SSE event. */
export function summariseToolUse(block, root) {
  const input = block?.input ?? {};
  switch (block?.name) {
    case 'Read':
      return relativise(input.file_path, root) || 'a file';
    case 'Write':
    case 'Edit':
      return relativise(input.file_path, root) || 'a file';
    case 'Glob':
      return input.pattern ? String(input.pattern) : 'a search';
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string');
      return first ? String(first).slice(0, 120) : '';
    }
  }
}

/**
 * The CLI's own words for a failed result. Newer versions leave `result` empty and put
 * the reason in `errors` — a stale session id arrives that way, exit code 0, stderr silent.
 */
function resultErrorText(obj) {
  if (typeof obj.result === 'string' && obj.result.trim()) return obj.result;
  return Array.isArray(obj.errors) ? obj.errors.filter((e) => typeof e === 'string').join('\n') : '';
}

function plainResultError(obj) {
  const raw = resultErrorText(obj);
  const status = obj.api_error_status;
  if (/credit balance|billing/i.test(raw)) {
    return 'The coach could not run: this Claude account is out of credit.';
  }
  if (/invalid api key|authentication|unauthorized|401/i.test(raw) || status === 401) {
    return 'The coach could not run: `claude` is not signed in. Run `claude` once in a terminal and log in.';
  }
  if (obj.subtype === 'error_max_turns') {
    return 'The coach stopped after hitting its turn limit without finishing an answer.';
  }
  if (raw.trim()) return `The coach stopped with an error: ${raw.trim().slice(0, 400)}`;
  return 'The coach stopped with an error and gave no reason.';
}

const RESUME_FAILED_MESSAGE =
  'The coach could not resume the earlier conversation for this problem — it is no longer on disk. Ask again and a fresh one will start.';

/** Does this stderr/exit look like "that session id no longer exists"? */
export function looksLikeMissingSession(stderr) {
  return /no conversation found|session .*not found|could not find session|no session/i.test(
    String(stderr ?? ''),
  );
}

/**
 * Spawn one coach turn and stream it.
 *
 * Callbacks fire in order; exactly one of onDone/onError fires, and never both.
 *
 * @returns {{ kill: () => void, exited: Promise<void> }}
 */
export function runCoachTurn({
  root,
  prompt,
  resumeSessionId = null,
  binary = 'claude',
  env = process.env,
  spawnFn = spawn,
  timeoutMs = TURN_TIMEOUT_MS,
  onToken = () => {},
  onTool = () => {},
  onDone = () => {},
  onError = () => {},
  onSessionId = () => {},
}) {
  const state = { sessionId: resumeSessionId, sawResult: false, root: [root, realpathOrNull(root)] };
  let settled = false;
  let killed = false;
  let child = null;

  const finishError = (message) => {
    if (settled) return;
    settled = true;
    onError(message);
  };
  const finishDone = (sessionId, stoppedReason) => {
    if (settled) return;
    settled = true;
    onDone(sessionId, stoppedReason);
  };

  const args = buildArgs({ root, resumeSessionId });

  try {
    child = spawnFn(binary, args, {
      cwd: root,
      env,
      // Its own process group, so a disconnect kills the CLI *and* anything it started.
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    finishError(missingBinaryMessage(err, binary));
    return { kill() {}, exited: Promise.resolve() };
  }

  const timer = setTimeout(() => {
    finishError(
      'The coach took longer than ten minutes without finishing, so it was stopped. Your work is untouched.',
    );
    kill();
  }, timeoutMs);
  timer.unref?.();

  function kill() {
    if (killed || !child || child.exitCode !== null) return;
    killed = true;
    try {
      // Negative pid = the whole process group.
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
    const hard = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }, 3000);
    hard.unref?.();
  }

  let stdoutBuf = '';
  let stderrTail = '';

  const emit = (item) => {
    switch (item.kind) {
      case 'token':
        onToken(item.text);
        break;
      case 'tool':
        onTool(item.name, item.summary);
        break;
      case 'done':
        if (item.sessionId) onSessionId(item.sessionId);
        finishDone(item.sessionId, item.stoppedReason);
        break;
      case 'error':
        if (resumeSessionId && looksLikeMissingSession(item.detail)) {
          state.resumeFailed = true;
          finishError(RESUME_FAILED_MESSAGE);
        } else {
          finishError(item.message);
        }
        break;
      default:
        break;
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line === '') continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // Not our protocol. Dropping it beats crashing the turn.
      }
      const before = state.sessionId;
      for (const item of interpretLine(obj, state)) emit(item);
      if (state.sessionId && state.sessionId !== before) onSessionId(state.sessionId);
    }
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  child.stdin.on('error', () => {
    // The child died before reading the prompt; `close` reports the real reason.
  });
  try {
    child.stdin.end(prompt, 'utf8');
  } catch {
    /* handled above */
  }

  const exited = new Promise((resolve) => {
    child.on('error', (err) => {
      clearTimeout(timer);
      finishError(missingBinaryMessage(err, binary));
      resolve();
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (!settled) {
        if (killed) {
          // We killed it, on purpose. Nobody is listening.
          settled = true;
        } else if (looksLikeMissingSession(stderrTail) && resumeSessionId) {
          finishError(RESUME_FAILED_MESSAGE);
          state.resumeFailed = true;
        } else {
          finishError(diedMidStreamMessage({ code, signal, stderrTail }));
        }
      }
      resolve();
    });
  });

  return {
    kill,
    exited,
    get resumeFailed() {
      return state.resumeFailed === true;
    },
  };
}

function missingBinaryMessage(err, binary) {
  if (err?.code === 'ENOENT') {
    return (
      `The coach is not available: the \`${binary}\` command was not found on this machine. ` +
      'Install Claude Code and make sure `claude` is on your PATH. Everything else in Studio still works.'
    );
  }
  if (err?.code === 'EACCES') {
    return `The coach is not available: \`${binary}\` exists but is not executable.`;
  }
  return `The coach could not be started: ${err?.message ?? 'unknown error'}.`;
}

function diedMidStreamMessage({ code, signal, stderrTail }) {
  const tail = String(stderrTail ?? '').trim();
  if (/not logged in|please run .*login|authenticate|invalid api key|oauth/i.test(tail)) {
    return 'The coach is not signed in. Run `claude` once in a terminal, log in, then try again.';
  }
  const detail = tail ? ` It said: ${tail.split('\n').slice(-3).join(' ').slice(0, 300)}` : '';
  if (signal) {
    return `The coach stopped unexpectedly (killed by ${signal}) before finishing its answer.${detail}`;
  }
  return `The coach stopped unexpectedly (exit code ${code}) before finishing its answer.${detail}`;
}
