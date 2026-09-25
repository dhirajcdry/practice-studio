// The run panel: turning a POST /api/run response into something true.
//
// Everything above the render functions is pure and covered by tests.js. The one
// rule this file exists to enforce is that the panel never says something the
// response did not say — no invented case lists behind a compile error, no
// "unsupported" dressed up as a failure, no pass we cannot justify.

import { el, clear, replace } from './dom.js';
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
 * attached no error to the case.
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
    note: '',
  };

  if (error && error.kind === 'timeout') {
    return { ...base, kind: 'timeout', passed: false, label: 'Timed out',
      message: base.message || 'This case was still running when the time limit was reached.' };
  }
  if (error) {
    return { ...base, kind: 'runtime', passed: false, label: 'Error',
      message: base.message || 'This case raised an exception.' };
  }
  if (source.passed === true) {
    return { ...base, kind: 'pass', passed: true, label: 'Passed',
      note: source.orderInsensitive === true ? 'Same values in a different order — accepted' : text(source.note) };
  }
  if (source.passed === false) {
    return { ...base, kind: 'fail', passed: false, label: 'Failed', note: text(source.note) };
  }
  // The server did not commit to a verdict. Neither do we.
  return { ...base, kind: 'unknown', passed: false, label: 'Differs from expected',
    note: text(source.note) || 'The result could not be compared with confidence — both values are shown.' };
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
  let headline = cases.length === 1 ? 'The case passed' : `All ${cases.length} cases passed`;

  if (failed > 0) {
    status = 'fail'; tone = 'err';
    headline = `${passed} of ${cases.length} cases passed`;
  } else if (unknown > 0) {
    status = 'unclear'; tone = 'warn';
    headline = `${passed} of ${cases.length} matched — ${unknown} could not be verified`;
  }

  return {
    status, tone, headline,
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

function labelled(label, value, className = '') {
  return el('div', { class: 'rr-field ' + className }, [
    el('div', { class: 'mono dim', text: label }),
    el('pre', { text: value === '' ? '—' : value }),
  ]);
}

function caseRow(shapedCase, index, forceOpen) {
  const open = forceOpen;
  const body = el('div', { class: 'rr-casebody', hidden: !open });

  if (shapedCase.kind === 'timeout' || shapedCase.kind === 'runtime') {
    body.append(el('p', { class: 'rr-msg', text: shapedCase.message }));
  } else if (shapedCase.note) {
    body.append(el('p', { class: 'rr-note', text: shapedCase.note }));
  }

  body.append(el('div', { class: 'rr-grid' }, [
    labelled('Input', shapedCase.input),
    labelled('Expected', shapedCase.expected),
    labelled('Actual', shapedCase.actual, shapedCase.kind === 'fail' || shapedCase.kind === 'unknown' ? 'bad' : ''),
  ]));

  if (shapedCase.stdout) body.append(labelled('Printed output', shapedCase.stdout, 'wide'));
  if (shapedCase.traceback) {
    body.append(el('div', { class: 'rr-field wide trace' }, [
      el('div', { class: 'mono dim', text: 'Traceback — line numbers point at your code' }),
      el('pre', { text: shapedCase.traceback }),
    ]));
  }

  const head = el('button', {
    class: 'rr-casehead', type: 'button', 'aria-expanded': String(open),
    onclick: (event) => {
      const next = body.hidden;
      body.hidden = !next;
      event.currentTarget.setAttribute('aria-expanded', String(next));
    },
  }, [
    el('span', { class: 'rr-caret', text: '›' }),
    el('span', { class: 'mono dim rr-caseno', text: `Case ${index + 1}` }),
    el('span', { class: 'rr-preview', text: shapedCase.input.replace(/\s+/g, ' ').trim() }),
    shapedCase.note && shapedCase.kind === 'pass' ? el('span', { class: 'tag quiet', text: 'any order' }) : null,
    el('span', { class: `tag rr-verdict k-${shapedCase.kind}`, text: shapedCase.label }),
    el('span', { class: 'mono dim rr-ms tnum', text: formatMs(shapedCase.ms) }),
  ]);

  return el('div', { class: 'rr-case k-' + shapedCase.kind }, [head, body]);
}

function block({ tone = '', head, lines = [], traceback = null, actions = [] }) {
  return el('div', { class: 'state ' + tone }, [
    el('h3', { text: head }),
    ...lines.filter(Boolean).map(line => el('p', { text: line })),
    traceback ? el('pre', { class: 'rr-trace', text: traceback }) : null,
    actions.length
      ? el('div', { class: 'acts' }, actions.map(a => el('button', { class: 'act', type: 'button', text: a.label, onclick: a.onClick })))
      : null,
  ]);
}

/**
 * Render a shaped result into `target`. `handlers.onRerun` is optional and only
 * used by the states where trying again is the sensible next move.
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

  const verdict = el('div', { class: 'rr-summary s-' + shaped.status }, [
    el('span', { class: 'rr-dot' }),
    el('span', { class: 'rr-headline', text: shaped.headline }),
    el('span', { class: 'spacer' }),
    shaped.orderInsensitive ? el('span', { class: 'tag quiet', text: 'order ignored' }) : null,
    el('span', { class: 'mono dim tnum', text: formatMs(shaped.summary.totalMs) }),
  ]);
  target.append(verdict);

  if (shaped.message) target.append(el('p', { class: 'rr-msg', text: shaped.message }));

  const list = el('div', { class: 'rr-cases' });
  // Passing cases collapse; anything you need to look at is already open.
  for (const [i, c] of shaped.cases.entries()) list.append(caseRow(c, i, c.kind !== 'pass'));
  target.append(list);
  return target;
}

/* ============================== the live panel ============================== */

const HARD_CAP_MS = 30000;

/**
 * Owns one results panel: the running state, the cap, cancellation, and the
 * rendered outcome. `getCode` is called at run time so the panel always sends
 * what is on screen right now.
 */
export function createRunPanel({ slug, getCode, onEvent = () => {} }) {
  const body = el('div', { class: 'rr-body' });

  // Two tabs, the way LeetCode has them: the cases you are going to run, and what
  // happened when you ran them. The editor stays alive behind the results, so fixing a
  // case after a failure is one click rather than a fresh load.
  const editor = createCaseEditor({ slug, onRun: () => run() });
  const cases = el('div', { class: 'rr-pane' }, editor.root);
  const results = el('div', { class: 'rr-pane', hidden: true }, body);

  const tabCases = el('button', { class: 'rr-tab mono', type: 'button', 'aria-pressed': 'true', text: 'Testcase' });
  const tabResult = el('button', { class: 'rr-tab mono', type: 'button', 'aria-pressed': 'false', text: 'Result' });
  const bar = el('div', { class: 'rr-tabs' }, [tabCases, tabResult]);

  function showTab(which) {
    const onResult = which === 'result';
    cases.hidden = onResult;
    results.hidden = !onResult;
    tabCases.setAttribute('aria-pressed', String(!onResult));
    tabResult.setAttribute('aria-pressed', String(onResult));
  }
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
        el('button', { class: 'act', type: 'button', text: 'Stop', onclick: () => stop('cancelled') }),
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
    renderRunResult(body, shaped, { onRerun: run });
    onEvent({ type: 'result', shaped });
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
    /** A submission came back wrong: keep the input it died on, ready to run. */
    addFailingCase(detail) {
      editor.addFailingCase(detail);
      showTab('cases');
    },
    dispose() {
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
