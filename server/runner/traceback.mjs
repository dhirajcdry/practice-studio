// Making a traceback point at the user's code.
//
// A traceback whose top frames name `_studio_driver.py` — a file the user never wrote,
// at a line number that means nothing to them — is worse than no traceback at all. So the
// driver's own frames are dropped, the temp-dir path is erased, and what is left is
// exactly the frames inside `solution.py`, with the line numbers Python reported (which
// are already the user's, because the user's code is a real file, not a string we spliced
// into a template).

import path from 'node:path';

const DRIVER_BASENAME = '_studio_driver.py';
const USER_BASENAME = 'solution.py';

const FILE_LINE = /^\s*File "(?<file>.*)", line (?<line>\d+)(?:, in (?<fn>.*))?\s*$/;

/** Frames we never show: our driver, and CPython's import machinery. */
function isHiddenFile(file) {
  const base = path.basename(file);
  if (base === DRIVER_BASENAME) return true;
  if (file.startsWith('<frozen importlib')) return true;
  if (file.startsWith('<frozen ') && file.includes('importlib')) return true;
  return false;
}

/**
 * @param {string} text raw `traceback.format_exc()` output
 * @param {object} opts
 * @param {string} [opts.dir] the temp workspace, erased from any path
 * @returns {{text:string, line:number|null, blamesUserCode:boolean}}
 */
export function rewriteTraceback(text, { dir } = {}) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { text: '', line: null, blamesUserCode: false };
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');

  // Split into: header lines, frame blocks, trailer (the `SomeError: message` lines).
  const blocks = [];
  let header = [];
  let trailer = [];
  let current = null;

  for (const raw of lines) {
    const m = FILE_LINE.exec(raw);
    if (m) {
      if (current) blocks.push(current);
      current = { file: m.groups.file, line: Number(m.groups.line), fn: m.groups.fn ?? null, body: [raw] };
      continue;
    }
    if (current) {
      // Frame bodies are indented (source line, caret markers). A non-indented line ends
      // the frame list and starts the exception text.
      if (raw.trim() === '' || /^\s/.test(raw)) {
        current.body.push(raw);
        continue;
      }
      blocks.push(current);
      current = null;
      trailer.push(raw);
      continue;
    }
    if (trailer.length > 0) trailer.push(raw);
    else header.push(raw);
  }
  if (current) blocks.push(current);

  const kept = blocks.filter((b) => !isHiddenFile(b.file));
  const userFrames = kept.filter((b) => path.basename(b.file) === USER_BASENAME);
  const blamesUserCode = userFrames.length > 0;

  const scrub = (s) => {
    let out = s;
    // `File "/private/var/folders/.../solution.py"` -> `File "solution.py"`. Done by
    // basename because macOS hands Python the /private-prefixed realpath of the temp dir,
    // so string-erasing our own path is not enough on its own.
    out = out.replace(/File "([^"]*)"/g, (whole, file) =>
      path.basename(file) === USER_BASENAME ? `File "${USER_BASENAME}"` : whole,
    );
    if (dir) {
      out = out.split(dir + path.sep).join('').split(dir).join('');
    }
    return out;
  };

  const renderedFrames = kept.map((b) => b.body.map(scrub).join('\n'));

  // Header is kept only when there is something under it.
  const headerText = kept.length > 0 ? header.filter((l) => l.trim() !== '').join('\n') : '';
  const trailerText = trailer.filter((l, i) => !(l.trim() === '' && i === trailer.length - 1)).join('\n');

  const pieces = [];
  if (headerText) pieces.push(headerText);
  if (renderedFrames.length > 0) pieces.push(renderedFrames.join('\n'));
  if (trailerText.trim() !== '') pieces.push(scrub(trailerText).trimEnd());

  const out = pieces.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();

  const lastUser = userFrames.length > 0 ? userFrames[userFrames.length - 1] : null;
  // SyntaxError has no user frame at all — the line number lives in the trailer instead.
  const syntaxLine = lastUser === null ? syntaxErrorLine(text) : null;

  return {
    text: out,
    line: lastUser ? lastUser.line : syntaxLine,
    blamesUserCode: blamesUserCode || syntaxLine !== null,
  };
}

/** `File "…/solution.py", line 3` inside a SyntaxError report, which has no live frame. */
function syntaxErrorLine(text) {
  const re = /File "([^"]*)", line (\d+)/g;
  let m;
  let found = null;
  while ((m = re.exec(text)) !== null) {
    if (path.basename(m[1]) === USER_BASENAME) found = Number(m[2]);
  }
  return found;
}

/** First line of the exception text, e.g. `ZeroDivisionError: division by zero`. */
export function summarize(text) {
  if (typeof text !== 'string') return '';
  const lines = text.trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const l = lines[i];
    if (l.trim() !== '' && !/^\s/.test(l)) return l.trim();
  }
  return lines[lines.length - 1]?.trim() ?? '';
}
