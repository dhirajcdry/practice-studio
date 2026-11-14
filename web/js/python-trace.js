// Reading a Python run: milliseconds, the learner's own traceback frames, the line an
// error happened on, and the traceback block both result panels draw. Everything except
// `traceBlock` is pure and covered by server/test/python-trace.test.mjs.
import { el } from './dom.js';
import { button } from './ui/button.js';

/** `12` → `12 ms`; anything unusable → ''. */
export function formatMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 10000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

const escape = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The frames from the learner's own file, plus the exception line. Null when that would
 * leave nothing, or would be the whole traceback anyway.
 */
export function ownFrames(traceback, file = 'solution.py') {
  const own = new RegExp(`(^|/)${escape(file)}$`);
  const lines = String(traceback || '').replace(/\s+$/, '').split('\n');
  const kept = [];
  let keep = false;
  for (const line of lines) {
    const frame = /^\s*File "([^"]*)", line \d+/.exec(line);
    if (frame) { keep = own.test(frame[1]); if (keep) kept.push(line); continue; }
    if (/^\S/.test(line)) { keep = false; if (!/^Traceback \(most recent call last\)/.test(line)) kept.push(line); continue; }
    if (keep && line.trim()) kept.push(line);
  }
  if (!kept.some(line => line.includes(file))) return null;
  const text = kept.join('\n');
  const whole = lines.filter(line => !/^Traceback \(most recent call last\)/.test(line)).join('\n');
  return text === whole ? null : text;
}

/** The line of the last frame in the learner's file, or null. */
export function tracebackLine(traceback, file = 'solution.py') {
  const frames = [...String(traceback || '').matchAll(new RegExp(`File "(?:[^"]*/)?${escape(file)}", line (\\d+)`, 'g'))];
  return frames.length ? Number(frames.at(-1)[1]) : null;
}

/** Exception type and its message, from a one-line summary (`IndexError: ...`). */
export function splitException(message) {
  const hit = /^([A-Za-z_][\w.]*):\s?([\s\S]*)$/.exec(String(message || '').trim());
  return hit ? { type: hit[1], detail: hit[2].trim() } : { type: '', detail: String(message || '').trim() };
}

/** Text with its frames' shared indentation removed, so a traceback starts at the left edge. */
export function dedent(value) {
  const lines = String(value).replace(/^Traceback \(most recent call last\):\n/, '').split('\n');
  const indents = lines.filter(line => line.trim() && /^\s/.test(line)).map(line => /^\s*/.exec(line)[0].length);
  const cut = Math.min(2, ...(indents.length ? indents : [0]));
  return lines.map(line => (line.slice(0, cut).trim() === '' ? line.slice(cut) : line)).join('\n');
}

/** The runner's file named the way the editor tab names it (`"solution.py"` → `"design.py"`). */
export function renameFile(text, from, to) {
  if (!to || to === from) return String(text ?? '');
  return String(text ?? '').replace(new RegExp(`(["/])${escape(from)}"`, 'g'), `$1${to}"`);
}

/**
 * The traceback, trimmed to the learner's own frames with the full text one click away.
 * `file` is the name the runner gave the learner's file; `fileName` is how it is shown.
 */
export function traceBlock(traceback, { file = 'solution.py', fileName = file } = {}) {
  const own = ownFrames(traceback, file);
  const shown = el('pre', { class: 'rr-trace-text', text: renameFile(dedent(own || traceback), file, fileName) });
  const parts = [shown];
  if (own) {
    const full = el('pre', { class: 'rr-trace-text is-full', text: renameFile(traceback, file, fileName), hidden: true });
    const toggle = button({
      label: 'Show full traceback', variant: 'quiet', className: 'rr-trace-toggle',
      onClick: () => {
        full.hidden = !full.hidden;
        shown.hidden = !full.hidden;
        toggle.setAttribute('aria-expanded', String(!full.hidden));
        toggle.querySelector('span').textContent = full.hidden ? 'Show full traceback' : 'Show only your code';
      },
    });
    toggle.setAttribute('aria-expanded', 'false');
    parts.push(full, toggle);
  }
  return el('div', { class: 'rr-field trace' }, parts);
}

/**
 * A script run (`runPythonScript`'s `{ status, exitCode, stdout, stderr, timedOut,
 * truncated, ms }`) as what the panel says about it. Nothing here is invented: a run with
 * no traceback is never called an exception, and an exit code is only shown when given.
 */
export function shapeScriptRun(raw, { file = 'solution.py' } = {}) {
  const result = raw && typeof raw === 'object' ? raw : {};
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result.stderr === 'string' ? result.stderr : '';
  const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
  const ms = formatMs(result.ms);
  const at = stderr.search(/^Traceback \(most recent call last\):/m);
  const traceback = at >= 0 ? stderr.slice(at).replace(/\s+$/, '') : null;
  const errors = (at >= 0 ? stderr.slice(0, at) : stderr).replace(/\s+$/, '');
  const base = { stdout, errors, traceback, ms, exitCode, truncated: result.truncated === true, line: null, exception: null };

  if (result.timedOut === true || result.status === 'timeout') {
    return { ...base, kind: 'timeout', tone: 'error', headline: 'Time limit exceeded',
      reason: 'The script was still running when the time limit was reached, so it was stopped.' };
  }
  if (result.status === 'output-limit') {
    // The truncation note says why; a reason as well would say it twice.
    return { ...base, kind: 'output-limit', tone: 'look', truncated: true, headline: 'Output limit reached', reason: '' };
  }
  if (result.status === 'spawn-failed') {
    return { ...base, kind: 'spawn', tone: 'error', headline: 'Python did not start', reason: errors || 'The runner could not start Python.', errors: '' };
  }
  if (traceback) {
    const last = traceback.split('\n').filter(line => /^\S/.test(line) && !/^(Traceback \(|During handling|The above exception)/.test(line)).at(-1) || '';
    const split = splitException(last);
    // A bare name (`KeyboardInterrupt`) is the type itself, with no message.
    const exception = !split.type && /^[A-Za-z_][\w.]*$/.test(split.detail) ? { type: split.detail, detail: '' } : split;
    const line = tracebackLine(traceback, file);
    return { ...base, kind: 'exception', tone: 'error', exception, line,
      headline: `Error · ${exception.type || 'exception'}`,
      reason: exception.detail };
  }
  if (exitCode === 0) {
    return { ...base, kind: 'ran', tone: 'pass', headline: ['Ran', ms, 'exit 0'].filter(Boolean).join(' · ') };
  }
  return { ...base, kind: 'exit', tone: 'error',
    headline: ['Exited', ms, exitCode === null ? 'no exit code' : `exit ${exitCode}`].filter(Boolean).join(' · ') };
}
