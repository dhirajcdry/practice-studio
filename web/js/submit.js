// The judge panel: turning a POST /api/submit verdict into something true.
//
// Run and Submit are different things and this file exists to keep them
// different. Run is local, instant, and checks the three example cases you can
// already read. Submit sends one copy of your code to LeetCode's own judge,
// which runs every hidden test and returns a verdict that counts. The single
// worst outcome on this screen is someone reading "3 example cases passed" as
// "64 hidden tests passed", so the two never share a headline, a colour, a
// container, or a keyboard shortcut.
//
// Three rules shape the code below.
//
//   1. **One submission per explicit press.** No retry loop, no auto-retry after
//      a rate limit, no shortcut that could fire it by accident, nothing
//      automatic on load. `submit()` is only ever called from a click.
//   2. **The judge's own words.** A non-accepted verdict is printed verbatim —
//      its status string, its last executed input, its expected and actual
//      output, its compile or runtime error. Nothing here paraphrases a verdict
//      and nothing softens one.
//   3. **Never a spinner that can hang.** Judging shows elapsed time against a
//      hard cap. When the cap is reached we stop waiting and say exactly that —
//      the submission itself is still on LeetCode, and we link to it.
//
// Everything above the render functions is pure and covered by tests.js.

import { el, clear, replace } from './dom.js';
import { submitCode } from './api.js';

/* ============================== shaping (pure) ============================== */

function text(value) {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(text).join('\n');
  return typeof value === 'string' ? value : String(value);
}

function firstText(source, keys) {
  for (const key of keys) {
    const value = text(source?.[key]).trim();
    if (value !== '') return value;
  }
  return '';
}

/** `53.86` → `53.86th percentile`. Anything unusable → ''. */
export function formatPercentile(value) {
  if (typeof value !== 'number' || !isFinite(value) || value < 0 || value > 100) return '';
  return `${Number(value.toFixed(2))}th percentile`;
}

/** The public link to one submission, or '' when the judge gave us no id. */
export function submissionUrlOf(raw) {
  const direct = text(raw?.submissionUrl).trim();
  if (/^https:\/\/leetcode\.com\//.test(direct)) return direct;
  const id = raw?.submissionId;
  if (typeof id === 'number' && isFinite(id) && id > 0) return `https://leetcode.com/submissions/detail/${id}/`;
  if (typeof id === 'string' && /^\d+$/.test(id)) return `https://leetcode.com/submissions/detail/${id}/`;
  return '';
}

/** Where to check by hand when we cannot say what happened. */
export function submissionsUrlOf(slug) {
  const clean = text(slug).trim();
  return clean ? `https://leetcode.com/problems/${encodeURIComponent(clean)}/submissions/` : 'https://leetcode.com/submissions/';
}

// The judge names these fields inconsistently across its own responses, so every
// spelling that has been observed is accepted rather than silently dropped. The
// long form wins when both are present — a truncated error is worse than none.
// `wide` blocks take the full width because they are long and unpaired; expected
// and actual sit side by side because the only reason to read them is to compare.
const DETAIL_FIELDS = [
  { label: 'Compile error', wide: true, keys: ['fullCompileError', 'full_compile_error', 'compileError', 'compile_error'] },
  { label: 'Runtime error', wide: true, keys: ['fullRuntimeError', 'full_runtime_error', 'runtimeError', 'runtime_error'] },
  { label: 'Last executed input', wide: true, keys: ['lastTestcase', 'last_testcase', 'input', 'lastInput', 'testcase'] },
  { label: 'Expected output', wide: false, keys: ['expected', 'expectedOutput', 'expected_output'] },
  { label: 'Your output', wide: false, keys: ['actual', 'actualOutput', 'output', 'codeOutput', 'code_output'] },
  { label: 'Printed output', wide: true, keys: ['stdout', 'stdOutput', 'std_output'] },
];

/**
 * Whatever the judge attached to a non-accepted verdict, in reading order.
 * Only fields that actually came back appear — an empty "Expected" box would
 * imply the judge said something it did not.
 */
export function shapeFailure(failure) {
  if (!failure || typeof failure !== 'object') {
    return { note: '', details: [], failingInput: '', failingExpected: '' };
  }
  const details = [];
  for (const field of DETAIL_FIELDS) {
    const value = firstText(failure, field.keys);
    if (value !== '') details.push({ label: field.label, value, wide: field.wide, bad: field.label === 'Your output' });
  }
  return {
    note: firstText(failure, ['message', 'detail', 'reason']),
    details,
    // Kept apart from the display list: this is the pair you can turn into a runnable
    // case, and it only exists when the judge actually returned the input it died on.
    failingInput: firstText(failure, ['lastTestcase', 'last_testcase', 'input', 'lastInput', 'testcase']),
    failingExpected: firstText(failure, ['expected', 'expectedOutput', 'expected_output']),
  };
}

// The `kind` chooses the shape of the panel — headline, retry, links. The words
// are the server's whenever it sent any: every message below is a fallback for a
// server that said nothing, never a replacement for one that did.
const BLOCKED = {
  session_expired: {
    tone: 'err',
    headline: 'Your LeetCode session has expired',
    message: 'Nothing was submitted. The cookies Studio uses to sign in to LeetCode are no longer valid, and no amount of trying again will change that — they have to be copied out of your browser and pasted in again.',
    // Deliberately no retry. Pressing it again cannot help, and offering it would be a lie.
    retry: false,
    credentials: true,
  },
  no_session: {
    tone: 'warn',
    headline: 'LeetCode is not connected yet',
    message: 'Nothing was submitted. This machine has no LeetCode credentials stored, so Studio has no way to sign in to the judge.',
    retry: false,
    credentials: true,
  },
  in_flight: {
    // Not a failure: it is the server refusing to send the same work twice.
    tone: '',
    headline: 'A submission is already on its way',
    message: 'A submission for this problem is still being judged, so this press sent nothing and nothing was duplicated. The verdict goes to whichever panel sent the original — if that was another tab, look there, or open it on LeetCode.',
    retry: false,
    checkFirst: true,
  },
  judge_timeout: {
    tone: 'warn',
    headline: 'LeetCode has not finished judging',
    message: 'The submission reached LeetCode and was accepted for judging, but no verdict came back before the server stopped polling. This is not a verdict on your code — it is still being judged.',
    retry: false,
    checkFirst: true,
  },
  rate_limited: {
    tone: 'warn',
    headline: 'LeetCode is rate limiting submissions',
    message: 'LeetCode refused this submission because too many arrived too quickly. Nothing was judged.',
    // The advice is separate from the message so that the server's own wording can
    // replace the message without taking "what to do next" down with it.
    advice: 'Wait a minute or two, then press Submit again yourself. Studio never resends a submission on its own, so nothing will happen until you do.',
    retry: false,
  },
  judge_unreachable: {
    tone: 'err',
    headline: 'The judge could not be reached',
    message: 'Studio could not get through to LeetCode — the network is down, or Cloudflare challenged the request. No verdict came back.',
    retry: true,
    checkFirst: true,
  },
  unavailable: {
    tone: 'warn',
    headline: 'This server cannot submit yet',
    message: 'The studio server answered, but it has no submit endpoint. Nothing was sent to LeetCode. Local Run is unaffected and your code is untouched.',
    retry: false,
  },
  offline: {
    tone: 'warn',
    headline: 'The studio server is not answering',
    message: 'Nothing left this machine. Start the studio server and submit again.',
    retry: false,
  },
  timeout: {
    tone: 'warn',
    headline: 'The judge has not answered yet',
    message: 'The submission was sent and LeetCode has not returned a verdict in the time allowed here, so Studio stopped waiting. This is not a verdict on your code — the submission may still be judging on LeetCode.',
    retry: false,
    checkFirst: true,
  },
  cancelled: {
    tone: '',
    headline: 'Stopped waiting for the verdict',
    message: 'You stopped watching, not the submission. It was already sent, and LeetCode will judge it whether this panel is open or not.',
    retry: false,
    checkFirst: true,
  },
  server: {
    tone: 'err',
    headline: 'The submission failed before a verdict came back',
    message: 'The studio server returned an error instead of a verdict.',
    retry: true,
    checkFirst: true,
  },
};

function blocked(kind, message, slug, raw = null) {
  const preset = BLOCKED[kind] || BLOCKED.server;
  const url = submissionUrlOf(raw);
  return {
    status: 'blocked',
    blockedKind: kind,
    tone: preset.tone,
    verdict: '',
    headline: preset.headline,
    message: message || preset.message,
    // A submission id in the error means the POST went through. Whatever failed after that
    // failed while READING the verdict, so "Submit again" would send a second copy of work
    // LeetCode already has — the one thing this panel must never make easy.
    retry: preset.retry === true && url === '',
    checkFirst: preset.checkFirst === true || url !== '',
    credentials: preset.credentials === true,
    advice: preset.advice || '',
    note: '',
    passed: null,
    total: null,
    runtime: '',
    memory: '',
    runtimePercentile: '',
    memoryPercentile: '',
    submissionUrl: url,
    submissionsUrl: submissionsUrlOf(slug),
    details: [],
  };
}

/**
 * Normalise anything `submitCode` can hand back into one view model.
 *
 * Acceptance is `statusCode === 10` — that is the judge's own definition, and
 * disagreeing with it is the single most common bug in third-party clients. A
 * response that claims `accepted:true` while carrying any other status code is
 * NOT shown as an acceptance.
 */
export function shapeSubmitResult(raw, slug = '') {
  if (!raw || typeof raw !== 'object') {
    return blocked('server', 'The submit request produced no response at all. Nothing came back from the judge.', slug);
  }

  if (raw.ok === false) {
    // An unrecognised kind or an error code nobody here has heard of still gets
    // the server's own sentence, verbatim — a generic fallback would throw away
    // the only accurate thing in the response.
    const kind = typeof raw.kind === 'string' && BLOCKED[raw.kind] ? raw.kind : 'server';
    return blocked(kind, text(raw.message) || null, slug, raw);
  }

  const statusCode = typeof raw.statusCode === 'number' ? raw.statusCode : null;
  const verdict = text(raw.verdict).trim();
  const claimed = raw.accepted === true;
  const accepted = claimed && (statusCode === null || statusCode === 10);

  const passed = Number.isFinite(raw.passed) ? raw.passed : null;
  const total = Number.isFinite(raw.total) ? raw.total : null;
  const { note, details, failingInput, failingExpected } = shapeFailure(raw.failure);

  const base = {
    blockedKind: null,
    verdict: verdict || (accepted ? 'Accepted' : 'Not accepted'),
    passed,
    total,
    runtime: text(raw.runtime).trim(),
    memory: text(raw.memory).trim(),
    runtimePercentile: formatPercentile(raw.runtimePercentile),
    memoryPercentile: formatPercentile(raw.memoryPercentile),
    submissionUrl: submissionUrlOf(raw),
    submissionsUrl: submissionsUrlOf(slug),
    note,
    details,
    failingInput,
    failingExpected,
    retry: false,
    checkFirst: false,
  };

  if (accepted) {
    // Accepted with an incomplete count is a contradiction. Report the verdict —
    // it is the judge's — but never let the counts read as a clean sweep.
    const short = passed !== null && total !== null && passed < total;
    return {
      ...base,
      status: 'accepted',
      tone: 'ok',
      headline: verdict || 'Accepted',
      message: short
        ? `The judge returned ${verdict || 'Accepted'} but reported only ${passed} of ${total} tests passing. Those two disagree; both are shown exactly as they came back.`
        : '',
    };
  }

  // Everything else is a failure and is presented as one. The headline is the
  // judge's own status string, never a rewording of it.
  return {
    ...base,
    status: 'rejected',
    tone: 'err',
    headline: verdict || 'Not accepted',
    message: claimed && statusCode !== null && statusCode !== 10
      ? `The response said it was accepted but carried status code ${statusCode}, and only status code 10 is an acceptance. It is reported here as not accepted.`
      : '',
  };
}

/** The one-line status the toolbar shows next to the Submit button. */
export function submitLine(shaped) {
  if (!shaped) return '';
  if (shaped.status === 'blocked') return shaped.headline;
  const bits = [shaped.verdict];
  if (shaped.passed !== null && shaped.total !== null) bits.push(`${shaped.passed}/${shaped.total}`);
  if (shaped.runtime) bits.push(shaped.runtime);
  return bits.join(' · ');
}

/* ================================ rendering ================================ */

function stat(label, value, sub = '') {
  if (!value) return null;
  return el('div', { class: 'sub-stat' }, [
    el('div', { class: 'mono dim', text: label }),
    el('div', { class: 'sub-statv tnum', text: value }),
    sub ? el('div', { class: 'mono dim sub-statsub', text: sub }) : null,
  ]);
}

function detailBlock(detail) {
  return el('div', { class: 'sub-detail' + (detail.wide ? ' wide' : '') + (detail.bad ? ' bad' : '') }, [
    el('div', { class: 'mono dim', text: detail.label }),
    el('pre', { text: detail.value }),
  ]);
}

function linkOut(href, label) {
  return el('a', { class: 'sub-link mono', href, target: '_blank', rel: 'noopener noreferrer', text: label });
}

/**
 * Render a shaped verdict into `target`. `handlers.onResubmit` is only attached
 * to the states where sending a second submission is a sensible, safe move —
 * never after an expired session, and never after a rate limit.
 */
export function renderSubmitResult(target, shaped, handlers = {}) {
  clear(target);
  if (!shaped) return target;

  if (shaped.status === 'blocked') {
    const acts = [];
    if (shaped.retry && handlers.onResubmit) acts.push(el('button', { class: 'act', type: 'button', text: 'Submit again', onclick: handlers.onResubmit }));
    target.append(el('div', { class: 'state ' + shaped.tone }, [
      el('h3', { text: shaped.headline }),
      el('p', { text: shaped.message }),
      shaped.advice ? el('p', { text: shaped.advice }) : null,
      shaped.credentials
        ? el('p', { text: 'Studio signs in to LeetCode with three cookies copied out of your browser — LEETCODE_SESSION, csrftoken and cf_clearance — kept in the macOS keychain. Paste them in again and submit. Local Run needs none of them and is unaffected.' })
        : null,
      shaped.checkFirst
        ? el('p', { class: 'sub-check' }, shaped.submissionUrl
          ? ['This submission is on LeetCode and will finish judging with or without this panel. ', linkOut(shaped.submissionUrl, 'Open it ↗')]
          : ['Check your submissions on LeetCode before sending another — this one may already be there. ', linkOut(shaped.submissionsUrl, 'Submissions ↗')])
        : null,
      acts.length ? el('div', { class: 'acts' }, acts) : null,
    ]));
    return target;
  }

  const counts = shaped.passed !== null && shaped.total !== null
    ? `${shaped.passed} of ${shaped.total} tests passed`
    : '';

  target.append(el('div', { class: 'sub-verdict v-' + shaped.status }, [
    el('span', { class: 'sub-vdot' }),
    el('span', { class: 'sub-vname', text: shaped.headline }),
    el('span', { class: 'spacer' }),
    counts ? el('span', { class: 'mono sub-vcount tnum', text: counts }) : null,
  ]));

  if (shaped.message) target.append(el('p', { class: 'sub-msg', text: shaped.message }));

  // The test count lives in the verdict row above, not down here: a lone "Tests"
  // box stretched across the panel looked like a mistake, and saying it twice
  // did not make it any truer.
  const stats = [
    stat('Runtime', shaped.runtime, shaped.runtimePercentile),
    stat('Memory', shaped.memory, shaped.memoryPercentile),
  ].filter(Boolean);
  if (stats.length) target.append(el('div', { class: 'sub-stats' }, stats));

  if (shaped.details.length || shaped.note) {
    target.append(el('div', { class: 'sub-judge' }, [
      el('div', { class: 'mono dim sub-judgehead' }, [
        el('span', { text: "The judge's own words" }),
        el('span', { class: 'spacer' }),
        // The input that broke it is the most useful thing on this screen, and until now
        // the only thing you could do with it was read it.
        shaped.failingInput && handlers.onUseFailingCase
          ? el('button', {
            class: 'ws-mini', type: 'button', text: 'Use as test case',
            title: 'Add this input to the local cases, so you can run against it here',
            onclick: () => handlers.onUseFailingCase({
              input: shaped.failingInput,
              expected: shaped.failingExpected || null,
            }),
          })
          : null,
      ]),
      shaped.note ? el('p', { class: 'sub-msg', text: shaped.note }) : null,
      shaped.details.length ? el('div', { class: 'sub-details' }, shaped.details.map(detailBlock)) : null,
    ]));
  } else if (shaped.status === 'rejected') {
    target.append(el('p', { class: 'sub-msg', text: 'LeetCode returned this verdict without any failing input, output or error attached, so there is nothing more to show than the verdict itself.' }));
  }

  const foot = el('div', { class: 'sub-foot' }, [
    shaped.submissionUrl ? linkOut(shaped.submissionUrl, 'This submission on LeetCode ↗') : null,
    shaped.submissionUrl ? null : linkOut(shaped.submissionsUrl, 'Your submissions on LeetCode ↗'),
    el('span', { class: 'spacer' }),
    handlers.onResubmit
      ? el('button', { class: 'act', type: 'button', text: 'Submit again', onclick: handlers.onResubmit })
      : null,
  ]);
  target.append(foot);
  return target;
}

/* ============================== the live panel ============================== */

/** How long we will sit watching before we stop and say we do not know. */
export const WATCH_CAP_MS = 90000;

/**
 * Owns one verdict panel: the judging state, the cap, the give-up, and the
 * rendered verdict. `getCode` is called at submit time so what is judged is what
 * is on screen right now.
 *
 * Nothing in here submits by itself. `submit()` is called from a click and from
 * nowhere else — no timer, no retry, no batching, ever.
 */
export function createSubmitPanel({ slug, getCode, onEvent = () => {}, onUseFailingCase = null }) {
  const body = el('div', { class: 'sub-body' });
  const scope = el('span', { class: 'mono sub-scope', text: 'leetcode.com' });
  const root = el('div', { class: 'sub', hidden: true }, [
    el('div', { class: 'sub-head' }, [
      el('span', { class: 'mono sub-mark', text: 'Submission' }),
      scope,
    ]),
    body,
  ]);

  let busy = false;
  let ticker = null;
  let controller = null;
  let last = null;

  function showJudging() {
    const started = Date.now();
    const clock = el('span', { class: 'mono tnum sub-clock', text: '0.0s' });
    const fill = el('i');
    replace(body, el('div', { class: 'sub-judging' }, [
      el('div', { class: 'sub-progress' }, fill),
      el('div', { class: 'sub-runrow' }, [
        el('span', { class: 'mono', text: 'Judging on LeetCode' }),
        clock,
        el('span', { class: 'spacer' }),
        el('button', { class: 'act', type: 'button', text: 'Stop waiting', onclick: () => stop('cancelled') }),
      ]),
    ]));
    ticker = setInterval(() => {
      const elapsed = Date.now() - started;
      clock.textContent = (elapsed / 1000).toFixed(1) + 's';
      fill.style.width = Math.min(100, (elapsed / WATCH_CAP_MS) * 100).toFixed(1) + '%';
      if (elapsed >= WATCH_CAP_MS) stop('timeout');
    }, 100);
  }

  function stop(reason) {
    if (!busy) return;
    if (controller) { try { controller.abort(); } catch { /* already gone */ } }
    finish(shapeSubmitResult({ ok: false, kind: reason }, slug));
  }

  function finish(shaped) {
    busy = false;
    controller = null;
    if (ticker) { clearInterval(ticker); ticker = null; }
    last = shaped;
    // No resubmit affordance on the states where a second submission is either
    // useless (expired session) or unwelcome (rate limited).
    const allow = shaped.status !== 'blocked' || shaped.retry;
    renderSubmitResult(body, shaped, {
      ...(allow ? { onResubmit: submit } : {}),
      ...(onUseFailingCase ? { onUseFailingCase } : {}),
    });
    onEvent({ type: 'result', shaped });
  }

  /** The only path that submits. Called from a click, never from anything else. */
  async function submit() {
    if (busy) return;
    busy = true;
    root.hidden = false;
    controller = new AbortController();
    onEvent({ type: 'start' });
    showJudging();
    const raw = await submitCode(slug, getCode(), controller.signal);
    if (!busy) return;               // stopped watching while we waited
    finish(shapeSubmitResult(raw, slug));
  }

  return {
    root,
    submit,
    stop: () => stop('cancelled'),
    isBusy: () => busy,
    lastResult: () => last,
    dispose() {
      if (ticker) clearInterval(ticker);
      // Aborting only stops us listening. The submission itself is LeetCode's now.
      if (controller) { try { controller.abort(); } catch { /* noop */ } }
      busy = false;
    },
  };
}

/**
 * Contract-shaped entry point. The panel is normally mounted by editor.js, which
 * owns the workspace; this exists so main.js can mount it directly.
 */
export function init(mountEl, apiState) {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  const slug = match ? decodeURIComponent(match[1]) : '';
  const panel = createSubmitPanel({ slug, getCode: () => '' });
  replace(mountEl, panel.root);
  return panel;
}
