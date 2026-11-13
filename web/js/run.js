import { icon } from './ui/icon.js';
import { paneHeader } from './ui/headers.js';
import { button } from './ui/button.js';
import { createBadge } from './ui/badge.js';
import { firstDifferingValue } from './submission-presentation.js';
// The run panel: turning a POST /api/run response into something true.
//
// Everything above the render functions is pure and covered by tests.js. The one
// rule this file exists to enforce is that the panel never says something the
// response did not say — no invented case lists behind a compile error, no
// "unsupported" dressed up as a failure, no pass we cannot justify.

import { el, clear, replace, dataText } from './dom.js';
import { runCode, cancelRun } from './api.js';
import { createCaseEditor } from './cases.js';

/* ============================== shaping (pure) ============================== */

/** `12` → `12 ms`; anything unusable → ''. */
export function formatMs(ms) {
  if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
  if (ms < 1) return '<1 ms';
  if (ms < 10000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function text(value) {
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
}

/**
 * One case, normalised. `kind` is the single source of truth for how the row
 * reads; `passed` is only ever true when the server said `passed === true` and
 * attached no error to the case. `status` folds the kinds into the four things a
 * learner is told: passed, wrong answer, error, or needs a look.
 */
function shapeCase(raw, fallbackIndex) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const error = source.error && typeof source.error === 'object' ? source.error : null;
  const base = {
    index: Number.isInteger(source.index) ? source.index : fallbackIndex,
    input: text(source.input),
    expected: text(source.expected),
    actual: text(source.actual),
    stdout: text(source.stdout),
    ms: typeof source.ms === 'number' ? source.ms : null,
    message: text(error?.message),
    traceback: text(error?.traceback) || null,
    line: Number.isInteger(error?.line) && error.line > 0 ? error.line : null,
    note: '',
  };

  let shaped;
  if (error && error.kind === 'timeout') {
    shaped = { ...base, kind: 'timeout', status: 'error', passed: false, label: 'Timed out',
      message: base.message || 'This case was still running when the time limit was reached.' };
  } else if (error) {
    shaped = { ...base, kind: 'runtime', status: 'error', passed: false, label: 'Error',
      message: base.message || 'This case raised an exception.' };
  } else if (source.passed === true) {
    shaped = { ...base, kind: 'pass', status: 'pass', passed: true, label: 'Passed',
      note: source.orderInsensitive === true ? 'Same values in a different order — accepted' : text(source.note) };
  } else if (source.passed === false) {
    shaped = { ...base, kind: 'fail', status: 'wrong', passed: false, label: 'Wrong answer', note: text(source.note) };
  } else {
    // The server did not commit to a verdict. Neither do we.
    shaped = { ...base, kind: 'unknown', status: 'look', passed: false, label: 'Needs a look',
      note: text(source.note) || 'The result could not be compared with confidence — both values are shown.' };
  }
  return { ...shaped, reason: caseReason(shaped) };
}

const NODE_ITEM = /^(TreeNode|ListNode)\((.*)\)$/;

/** `[TreeNode(1), TreeNode(3)]` → { type: 'TreeNode', values: ['1', '3'] }; anything else → null. */
export function returnedNodes(actual) {
  const value = String(actual ?? '').trim();
  if (!value.startsWith('[') || !value.endsWith(']')) return null;
  const inner = value.slice(1, -1).trim();
  if (!inner) return null;
  const items = inner.split(/,\s*(?=(?:TreeNode|ListNode)\()/);
  const values = [];
  let type = null;
  for (const item of items) {
    const hit = NODE_ITEM.exec(item.trim());
    if (!hit || (type && hit[1] !== type) || /[()]/.test(hit[2])) return null;
    type = hit[1];
    values.push(hit[2]);
  }
  return { type, values };
}

/** What a list of primitives holds, in words, or null when it is not one. */
function primitiveListKind(expected) {
  let parsed;
  try { parsed = JSON.parse(expected); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.length) return null;
  if (parsed.every(v => Number.isInteger(v))) return 'integers';
  if (parsed.every(v => typeof v === 'number')) return 'numbers';
  if (parsed.every(v => typeof v === 'string')) return 'strings';
  return null;
}

/**
 * Where a wrong answer parts from the expected value, in words, when that is certain:
 * both values are JSON arrays. Anything else gets no location rather than a guess.
 */
export function describeDifference(expected, actual) {
  let a, b;
  try { a = JSON.parse(expected); b = JSON.parse(actual); } catch { return ''; }
  if (!Array.isArray(a) || !Array.isArray(b)) return '';
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  let at = 0;
  while (at < a.length && at < b.length && same(a[at], b[at])) at += 1;
  const items = n => `${n} item${n === 1 ? '' : 's'}`;
  const parts = [];
  if (a.length !== b.length) parts.push(`The output has ${items(b.length)}; ${a.length} ${a.length === 1 ? 'was' : 'were'} expected.`);
  if (at < Math.max(a.length, b.length)) parts.push(`The first difference is at index ${at}.`);
  return parts.join(' ');
}

/** Exception type and its message, from the runner's one-line summary (`IndexError: ...`). */
function splitException(message) {
  const hit = /^([A-Za-z_][\w.]*):\s?([\s\S]*)$/.exec(String(message || '').trim());
  return hit ? { type: hit[1], detail: hit[2].trim() } : { type: '', detail: String(message || '').trim() };
}

/** The line in solution.py the error happened on: the runner's own field, else the last frame in the file. */
function errorLine(shaped) {
  if (shaped.line) return shaped.line;
  const frames = [...String(shaped.traceback || '').matchAll(/File "(?:[^"]*\/)?solution\.py", line (\d+)/g)];
  return frames.length ? Number(frames.at(-1)[1]) : null;
}

/**
 * The one-sentence reason a case shows above its values. A likely fix appears only when
 * the values themselves prove it: a list of nodes returned where a list of plain values
 * was expected. Otherwise the reason says what happened and nothing more.
 */
function caseReason(shaped) {
  if (shaped.kind === 'pass') {
    return { title: 'Passed', text: shaped.note || 'Your output matches the expected value.' };
  }
  if (shaped.kind === 'fail') {
    return { title: 'Wrong answer', text: describeDifference(shaped.expected, shaped.actual) || shaped.note || 'Your output differs from the expected value.' };
  }
  if (shaped.kind === 'timeout') return { title: 'Timed out', text: shaped.message };
  if (shaped.kind === 'runtime') {
    const { type, detail } = splitException(shaped.message);
    const line = errorLine(shaped);
    return { title: `${type || 'Error'}${line ? ` on line ${line}` : ''}`, text: detail || shaped.message, line };
  }
  const nodes = returnedNodes(shaped.actual);
  const wanted = nodes && primitiveListKind(shaped.expected);
  if (nodes && wanted) {
    return {
      title: `Returned ${nodes.type} objects, not their values`,
      text: `Expected a list of ${wanted}. If the values are right, append node.val instead of node.`,
      values: nodes.values,
    };
  }
  return { title: 'Needs a look', text: shaped.note };
}

const BLOCKED = {
  unavailable: {
    tone: 'warn',
    headline: 'This server cannot run code yet',
    message: 'The studio server answered, but it has no local runner endpoint. Your code is still here and nothing was lost.',
  },
  offline: {
    tone: 'warn',
    headline: 'The studio server is not answering',
    message: 'Nothing was executed. Start the server and run again — your buffer is untouched.',
  },
  timeout: {
    tone: 'err',
    headline: 'The run never came back',
    message: 'The server accepted the request but did not answer in time. Nothing here is a verdict on your code.',
  },
  cancelled: {
    tone: '',
    headline: 'Run cancelled',
    message: 'You stopped the run before it finished, so there are no results.',
  },
  server: {
    tone: 'err',
    headline: 'The run failed before it started',
    message: 'The server returned an error instead of results.',
  },
};

function blocked(kind, message, extra = {}) {
  const preset = BLOCKED[kind] || BLOCKED.server;
  return {
    status: 'blocked',
    blockedKind: kind,
    tone: preset.tone,
    headline: preset.headline,
    message: message || preset.message,
    traceback: null,
    cases: [],
    summary: { passed: 0, total: 0, failed: 0, unknown: 0, totalMs: null },
    orderInsensitive: false,
    ...extra,
  };
}

/**
 * Normalise anything `runCode` can hand back into one view model.
 *
 * Accepts both the contract payload (`{ ok, cases, summary, error }`) and the
 * transport-level failure shape api.js uses everywhere else
 * (`{ ok:false, kind, message }`).
 */
export function shapeRunResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return blocked('server', 'The run request produced no response at all. Nothing was executed.');
  }

  const error = raw.error && typeof raw.error === 'object' ? raw.error : null;

  // Transport failure — no `error` object, but a top-level `kind`.
  if (raw.ok === false && !error) {
    const kind = typeof raw.kind === 'string' ? raw.kind : 'server';
    const mapped = kind === 'missing' ? 'unavailable' : (BLOCKED[kind] ? kind : 'server');
    return blocked(mapped, text(raw.message) || null, { source: raw.source || null });
  }

  const source = raw.source || null;

  // Unsupported is neither a pass nor a failure, and it never gets a case list.
  if (error && error.kind === 'unsupported') {
    return {
      status: 'unsupported',
      tone: '',
      headline: 'Local run does not handle this problem type yet',
      message: text(error.message)
        || 'The local runner cannot build a driver for this problem shape. Submitting to LeetCode still works.',
      traceback: null,
      cases: [],
      summary: { passed: 0, total: 0, failed: 0, unknown: 0, totalMs: null },
      orderInsensitive: false,
      source,
    };
  }

  // A compile error means nothing ran. Any cases attached would be fiction.
  if (error && error.kind === 'compile') {
    return {
      status: 'compile',
      tone: 'err',
      headline: 'Your code did not compile',
      message: text(error.message) || 'Python refused the file before any case ran.',
      traceback: text(error.traceback) || null,
      cases: [],
      summary: { passed: 0, total: 0, failed: 0, unknown: 0, totalMs: null },
      orderInsensitive: false,
      source,
    };
  }

  // A run-level error of some other kind: report it, still show whatever ran.
  const cases = Array.isArray(raw.cases) ? raw.cases.map(shapeCase) : [];

  if (error && cases.length === 0) {
    return blocked('server', text(error.message) || null, { traceback: text(error.traceback) || null, source });
  }

  const passed = cases.filter(c => c.kind === 'pass').length;
  const unknown = cases.filter(c => c.kind === 'unknown').length;
  const failed = cases.length - passed - unknown;
  const orderInsensitive = cases.some(c => c.kind === 'pass' && c.note);

  const serverTotalMs = raw.summary && typeof raw.summary.totalMs === 'number' ? raw.summary.totalMs : null;
  const derivedMs = cases.reduce((sum, c) => sum + (typeof c.ms === 'number' ? c.ms : 0), 0);
  const summary = {
    passed,
    total: cases.length,
    failed,
    unknown,
    totalMs: serverTotalMs !== null ? serverTotalMs : (derivedMs || null),
  };

  if (cases.length === 0) {
    return {
      status: 'empty', tone: 'warn',
      headline: 'The run came back with no cases',
      message: 'The server reported success but sent no test cases, so there is nothing to check against.',
      traceback: null, cases: [], summary, orderInsensitive: false, source,
    };
  }

  let status = 'pass';
  let tone = '';
  let verdict = 'pass';
  let headline = cases.length === 1 ? 'The case passed' : `All ${cases.length} cases passed`;
  const count = s => cases.filter(c => c.status === s).length;
  const errors = cases.filter(c => c.status === 'error');
  const wrong = count('wrong');
  const look = count('look');
  const n = cases.length;

  // The headline names the most serious thing that happened; the line under it counts the
  // rest. Both use the same four words as the case tabs, so the two can never disagree.
  if (errors.length) {
    status = 'fail'; tone = 'err'; verdict = 'error';
    const what = errors.every(c => c.kind === 'timeout') ? 'Timed out' : 'Error';
    headline = errors.length === 1 ? `${what} on Case ${cases.indexOf(errors[0]) + 1}` : `${what} on ${errors.length} of ${n}`;
  } else if (wrong) {
    status = 'fail'; tone = 'err'; verdict = 'wrong';
    headline = `Wrong answer on ${wrong} of ${n}`;
  } else if (look) {
    status = 'unclear'; tone = 'warn'; verdict = 'look';
    headline = `${look} of ${n} need${look === 1 ? 's' : ''} a look`;
  }
  const objects = cases.filter(c => c.status === 'look').every(c => returnedNodes(c.actual) || /<[\w.]+ object at 0x[0-9a-f]+>/.test(c.actual));
  const rest = [
    verdict !== 'wrong' && wrong ? `${wrong} wrong answer${wrong === 1 ? '' : 's'}` : null,
    verdict !== 'look' && look ? `${look} need${look === 1 ? 's' : ''} a look` : null,
    passed ? `${passed} passed` : null,
    verdict === 'look' ? `${look} ${objects ? 'returned objects that' : ''} could not be compared`.replace(/\s+/g, ' ') : null,
  ].filter(Boolean);
  const detail = verdict === 'pass' ? '' : rest.join(' · ');
  const firstOpen = Math.max(0, cases.findIndex(c => c.status !== 'pass'));

  return {
    status, tone, headline, verdict, detail, firstOpen,
    message: error ? text(error.message) : '',
    traceback: error ? (text(error.traceback) || null) : null,
    cases, summary, orderInsensitive, source,
  };
}

/** The one-line status the toolbar shows next to the Run button. */
export function summaryLine(shaped) {
  if (!shaped) return '';
  if (shaped.status === 'blocked' || shaped.status === 'unsupported' || shaped.status === 'compile') {
    return shaped.headline;
  }
  const bits = [`${shaped.summary.passed}/${shaped.summary.total} passed`];
  const ms = formatMs(shaped.summary.totalMs);
  if (ms) bits.push(ms);
  return bits.join(' · ');
}

/* ================================ rendering ================================ */

/** A value with the part where it first differs marked; a gap mark where one value simply stops. */
function marked(value, range, className) {
  if (!range) return dataText(value);
  const [start, end] = range;
  return [
    ...dataText(value.slice(0, start)),
    end > start
      ? el('mark', { class: className, text: value.slice(start, end) })
      : el('mark', { class: className + ' is-gap', 'aria-label': 'missing here', text: ' ' }),
    ...dataText(value.slice(end)),
  ];
}

/** One labelled row, mirroring the statement's examples: the name on the left, the value beside it. */
function row(label, value, className = '') {
  return el('div', { class: 'rr-row ' + className }, [
    el('span', { class: 'rr-label', text: label }),
    el('div', { class: 'rr-value' }, value),
  ]);
}

/** An absent value is said to be absent, in words, so it never reads as a printed value. */
const absent = words => el('span', { class: 'rr-absent', text: words });

/** The input, one line per parameter, named when the parameter names line up with its lines. */
function inputValue(input, params) {
  if (!input) return absent('None');
  const lines = input.split('\n');
  if (!params.length || params.length !== lines.length) return dataText(input);
  return lines.map((line, i) => el('div', {}, [el('span', { class: 'rr-param', text: `${params[i]} = ` }), ...dataText(line)]));
}

/**
 * The frames from the learner's own file, plus the exception line. Null when that would
 * leave nothing, or would be the whole traceback anyway.
 */
export function ownFrames(traceback) {
  const lines = String(traceback || '').replace(/\s+$/, '').split('\n');
  const kept = [];
  let keep = false;
  for (const line of lines) {
    const frame = /^\s*File "([^"]*)", line \d+/.exec(line);
    if (frame) { keep = /(^|\/)solution\.py$/.test(frame[1]); if (keep) kept.push(line); continue; }
    if (/^\S/.test(line)) { keep = false; if (!/^Traceback \(most recent call last\)/.test(line)) kept.push(line); continue; }
    if (keep && line.trim()) kept.push(line);
  }
  if (!kept.some(line => /solution\.py/.test(line))) return null;
  const text = kept.join('\n');
  const whole = lines.filter(line => !/^Traceback \(most recent call last\)/.test(line)).join('\n');
  return text === whole ? null : text;
}

/** Text with its frames' shared indentation removed, so a traceback starts at the left edge. */
function dedent(value) {
  const lines = String(value).replace(/^Traceback \(most recent call last\):\n/, '').split('\n');
  const indents = lines.filter(line => line.trim() && /^\s/.test(line)).map(line => /^\s*/.exec(line)[0].length);
  const cut = Math.min(2, ...(indents.length ? indents : [0]));
  return lines.map(line => (line.slice(0, cut).trim() === '' ? line.slice(cut) : line)).join('\n');
}

function traceBlock(traceback) {
  const own = ownFrames(traceback);
  const shown = el('pre', { class: 'rr-trace-text', text: dedent(own || traceback) });
  const parts = [shown];
  if (own) {
    const full = el('pre', { class: 'rr-trace-text is-full', text: traceback, hidden: true });
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

/** The selected case: why, then its values as labelled rows, then a quiet footer. */
function caseDetail(c, params, slug) {
  const reason = c.reason;
  const wrongRange = c.kind === 'fail' && c.expected && c.actual ? firstDifferingValue(c.expected, c.actual) : null;
  const errored = c.status === 'error';
  const rows = [
    row('Input', inputValue(c.input, params)),
    row('Expected', c.expected
      ? marked(c.expected, wrongRange && [wrongRange.start, wrongRange.endExpected], 'rr-mark is-expected')
      : absent('Not given')),
    // An error or a timeout returned nothing; saying "Your output: nothing" under the error says it twice.
    errored && !c.actual ? null : row('Your output', c.actual
      ? [...marked(c.actual, wrongRange && [wrongRange.start, wrongRange.endActual], 'rr-mark'),
        reason.values ? el('span', { class: 'rr-aside', text: `values ${reason.values.join(', ')}` }) : null]
      : absent('Nothing returned'), c.status === 'wrong' ? 'is-bad' : ''),
    c.stdout ? row('Printed', el('pre', { class: 'rr-printed' }, dataText(c.stdout))) : null,
  ];
  const ms = formatMs(c.ms);
  const goTo = reason.line && slug
    ? button({ label: `Go to line ${reason.line}`, variant: 'quiet', className: 'rr-goto',
      onClick: async () => (await import('./editor.js')).submissionEditor(slug)?.jumpToLine(reason.line) })
    : null;
  return el('div', { class: `rr-case k-${c.kind} s-${c.status}` }, [
    el('div', { class: `rr-why s-${c.status}` }, [
      el('strong', { text: reason.title }),
      reason.text ? el('span', { text: reason.text }) : null,
    ]),
    el('div', { class: 'rr-rows' }, rows),
    c.traceback ? traceBlock(c.traceback) : null,
    el('div', { class: 'rr-foot' }, [
      ms ? el('span', {}, ['Time ', el('b', { class: 'tnum', text: ms })]) : null,
      c.stdout ? null : el('span', { text: 'Nothing printed' }),
      goTo,
    ]),
  ]);
}

function block({ tone = '', head, lines = [], traceback = null, actions = [] }) {
  return el('div', { class: 'state ui-inset ui-inset--roomy ' + tone }, [
    el('h3', { text: head }),
    ...lines.filter(Boolean).map(line => el('p', { text: line })),
    traceback ? el('pre', { class: 'rr-trace', text: traceback }) : null,
    actions.length
      ? el('div', { class: 'acts' }, actions.map(a => el('button', { class: 'btn btn--quiet act', type: 'button', text: a.label, onclick: a.onClick })))
      : null,
  ]);
}

/**
 * Render a shaped result into `target`. `handlers.onRerun` is optional and only
 * used by the states where trying again is the sensible next move. `handlers.params`
 * names each input line; `handlers.slug` lets an error offer Go to line.
 */
export function renderRunResult(target, shaped, handlers = {}) {
  clear(target);
  if (!shaped) return target;

  if (shaped.status === 'blocked') {
    target.append(block({
      tone: shaped.tone,
      head: shaped.headline,
      lines: [shaped.message],
      traceback: shaped.traceback,
      actions: shaped.blockedKind === 'cancelled' || !handlers.onRerun ? [] : [{ label: 'Try again', onClick: handlers.onRerun }],
    }));
    return target;
  }

  if (shaped.status === 'unsupported') {
    target.append(block({
      tone: '',
      head: shaped.headline,
      lines: [
        shaped.message,
        'This is not a failure and not a pass — nothing about your solution was checked. Submitting it on LeetCode is unaffected.',
      ],
    }));
    return target;
  }

  if (shaped.status === 'compile') {
    target.append(block({
      tone: 'err',
      head: shaped.headline,
      lines: [shaped.message, 'No test case ran, so there is nothing to show below.'],
      traceback: shaped.traceback,
      actions: handlers.onRerun ? [{ label: 'Run again', onClick: handlers.onRerun }] : [],
    }));
    return target;
  }

  if (shaped.status === 'empty') {
    target.append(block({ tone: 'warn', head: shaped.headline, lines: [shaped.message] }));
    return target;
  }

  const verdict = el('div', { class: 'rr-summary s-' + shaped.verdict }, [
    el('span', { class: 'rr-headline' }, [el('span', { class: 'rr-dot', 'aria-hidden': 'true' }), el('span', { text: shaped.headline })]),
    shaped.detail ? el('span', { class: 'rr-detail', text: shaped.detail }) : null,
    el('span', { class: 'spacer' }),
    shaped.orderInsensitive ? createBadge('order ignored', 'neutral') : null,
    el('span', { class: 'rr-total tnum', text: formatMs(shaped.summary.totalMs) }),
  ]);
  target.append(verdict);

  if (shaped.message) target.append(el('p', { class: 'rr-msg', text: shaped.message }));

  // One case at a time, chosen from tabs like the Testcase tab's: the first case that is not
  // a pass is the one on screen after a run, or Case 1 when everything passed.
  const params = handlers.params || [];
  const pane = el('div', { class: 'rr-casepane' });
  const tabs = shaped.cases.map((c, i) => el('button', {
    class: `btn btn--quiet tc-tab rr-casetab s-${c.status}`, type: 'button',
    'aria-label': `Case ${i + 1}, ${c.label.toLowerCase()}`,
    onclick: () => select(i),
  }, [el('span', { class: 'rr-dot', 'aria-hidden': 'true' }), el('span', { text: `Case ${i + 1}` })]));
  function select(index) {
    tabs.forEach((tab, i) => {
      tab.classList.toggle('is-on', i === index);
      tab.setAttribute('aria-pressed', String(i === index));
    });
    replace(pane, caseDetail(shaped.cases[index], params, handlers.slug));
  }
  target.append(el('div', { class: 'rr-cases' }, [el('div', { class: 'tc-tabs rr-casetabs' }, tabs), pane]));
  select(shaped.firstOpen || 0);
  return target;
}

/* ============================== the live panel ============================== */

const HARD_CAP_MS = 30000;

/**
 * Owns one results panel: the running state, the cap, cancellation, and the
 * rendered outcome. `getCode` is called at run time so the panel always sends
 * what is on screen right now.
 */
export function createRunPanel({ slug, getCode, onCollapse, onEvent = () => {} }) {
  // Until the first run the Result tab says what will appear there, not nothing.
  const body = el('div', { class: 'rr-body' }, el('p', { class: 'rr-empty', text: 'Run your code to see each case\u2019s output here. Runs stay on this machine.' }));

  // Two tabs, the way LeetCode has them: the cases you are going to run, and what
  // happened when you ran them. The editor stays alive behind the results, so fixing a
  // case after a failure is one click rather than a fresh load.
  const editor = createCaseEditor({ slug, onRun: () => run() });
  const cases = el('div', { class: 'rr-pane' }, editor.root);
  const results = el('div', { class: 'rr-pane', hidden: true }, body);

  const tabCases = el('button', { class: 'btn btn--quiet ui-tab rr-tab', type: 'button', 'aria-pressed': 'true', text: 'Testcase' });
  const tabResult = el('button', { class: 'btn btn--quiet ui-tab rr-tab', type: 'button', 'aria-pressed': 'false', text: 'Result' });
  // "Local run" rides on the tab row: it is what stops these results being read as
  // LeetCode's verdict, and a band of its own only pushed the cases further down.
  const bar = paneHeader({ tabs: el('div', { class: 'ui-tabs' }, [tabCases, tabResult]),
    subtitle: el('span', { class: 'rr-tabmark', text: 'Local run' }),
    tools: onCollapse ? [{ variant: 'icon', icon: 'chevron', ariaLabel: 'Collapse results', onClick: onCollapse }] : [],
  });
  bar.classList.add('rr-tabs');

  function showTab(which) {
    const onResult = which === 'result';
    cases.hidden = onResult;
    results.hidden = !onResult;
    tabCases.setAttribute('aria-pressed', String(!onResult));
    tabResult.setAttribute('aria-pressed', String(onResult));
  }
  // An example in the statement asks for its case: bring the cases forward and select it.
  const onShowCase = event => {
    if (event.detail?.slug !== slug) return;
    showTab('cases');
    editor.show(event.detail.number);
  };
  window.addEventListener('studio:show-case', onShowCase);
  tabCases.addEventListener('click', () => showTab('cases'));
  tabResult.addEventListener('click', () => showTab('result'));

  const root = el('div', { class: 'rr' }, [bar, cases, results]);

  let running = false;
  let ticker = null;
  let controller = null;
  let last = null;

  function showRunning() {
    const started = Date.now();
    const clock = el('span', { class: 'mono dim tnum', text: '0.0s' });
    replace(body, el('div', { class: 'rr-running' }, [
      el('div', { class: 'rr-bar' }, el('i')),
      el('div', { class: 'rr-runrow' }, [
        el('span', { class: 'mono', text: 'Running' }),
        clock,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn btn--quiet act', type: 'button', text: 'Stop', onclick: () => stop('cancelled') }),
      ]),
    ]));
    ticker = setInterval(() => {
      const elapsed = (Date.now() - started) / 1000;
      clock.textContent = elapsed.toFixed(1) + 's';
      if (elapsed * 1000 >= HARD_CAP_MS) stop('timeout');
    }, 100);
  }

  function stop(reason) {
    if (!running) return;
    if (controller) { try { controller.abort(); } catch { /* already gone */ } }
    cancelRun(slug);
    finish(shapeRunResult({
      ok: false,
      kind: reason,
      message: reason === 'timeout'
        ? 'The run passed 30 seconds with no answer, so it was stopped here. Nothing below is a verdict on your code.'
        : null,
    }));
  }

  function finish(shaped) {
    running = false;
    controller = null;
    if (ticker) { clearInterval(ticker); ticker = null; }
    last = shaped;
    renderRunResult(body, shaped, { onRerun: run, params: editor.params(), slug });
    onEvent({ type: 'result', shaped });
    // The verdict and the selected case are at the top of the result; start the pane there.
    root.closest('.ws-results')?.scrollTo({ top: 0 });
  }

  async function run() {
    if (running) return;
    running = true;
    controller = new AbortController();
    onEvent({ type: 'start' });
    showTab('result');
    showRunning();
    // Whatever is in the editor right now — examples plus yours, in tab order.
    const { testcases, expected } = editor.payload();
    const raw = await runCode(slug, getCode(), controller.signal, { testcases, expected });
    if (!running) return;             // stopped while we waited
    finish(shapeRunResult(raw));
  }

  return {
    root,
    run,
    stop: () => stop('cancelled'),
    isRunning: () => running,
    lastResult: () => last,
    showTab,
    /** The cases changed on the server (the tutor, or an undo). Reload and show them. */
    async reloadCases({ select = null } = {}) {
      showTab('cases');
      await editor.reload({ select });
    },
    /**
     * A run the tutor asked for, shown in the Result tab under its own label.
     *
     * It never becomes `last`: the toolbar line and the collapsed lane describe HIS last
     * run, and a tutor run passing must not read as his code having been checked by him.
     * While his own run is in flight it is not shown at all — his result is the one he is
     * waiting for — and the receipt in the chat still says what the tutor's run found.
     */
    showTutorRun(raw) {
      if (running) return false;
      const shaped = shapeRunResult(raw);
      const out = el('div', { class: 'rr-tutorbody' });
      renderRunResult(out, shaped, { params: editor.params(), slug });
      replace(body, [
        el('div', { class: 'rr-tutor ui-inset ui-cluster' }, [
          el('div', { class: 'rr-tutor-copy ui-cluster-content ui-stack' }, [
            el('span', { class: 'rr-tutor-mark', text: 'Run by your tutor' }),
            el('span', { class: 'rr-tutor-what', text: 'Your saved solution.py · not counted as your run' }),
          ]),
          last
            ? el('button', {
              class: 'btn btn--secondary', type: 'button', text: 'Show your last run',
              onclick: () => renderRunResult(body, last, { onRerun: run, params: editor.params(), slug }),
            })
            : null,
        ]),
        out,
      ]);
      showTab('result');
      return true;
    },
    /** A submission came back wrong: keep the input it died on, ready to run. */
    addFailingCase(detail) {
      editor.addFailingCase(detail);
      showTab('cases');
    },
    dispose() {
      window.removeEventListener('studio:show-case', onShowCase);
      if (ticker) clearInterval(ticker);
      if (controller) { try { controller.abort(); } catch { /* noop */ } }
      editor.dispose();
      running = false;
    },
  };
}

/**
 * Contract-shaped entry point. The panel is normally mounted by problem.js,
 * which owns the problem screen; this exists so main.js can mount it directly.
 */
export function init(mountEl, apiState) {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  const slug = match ? decodeURIComponent(match[1]) : '';
  const panel = createRunPanel({ slug, getCode: () => '' });
  replace(mountEl, panel.root);
  return panel;
}
