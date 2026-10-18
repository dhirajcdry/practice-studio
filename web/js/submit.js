// The judge panel: turning a LeetCode verdict into something true.
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
//
// Premium problems are judged on neetcode.io instead (docs/SUBMITTING.md, "Premium
// problems: NeetCode"). The same panel shows them, told apart by `target: 'neetcode'`:
// its own scope, links and failure states, and the same three rules.

import { el, clear, replace } from './dom.js';
import { submitCode, neetcodeSubmitBlocker } from './api.js';

const LOGIN_URL = 'https://leetcode.com/accounts/login/';

const SITES = {
  leetcode: { name: 'LeetCode', host: 'leetcode.com', login: LOGIN_URL },
  neetcode: { name: 'NeetCode', host: 'neetcode.io', login: 'https://neetcode.io/' },
};

/** Where a submission is judged: 'neetcode' for premium problems, 'leetcode' otherwise. */
export function targetOf(value) {
  return value === 'neetcode' ? 'neetcode' : 'leetcode';
}

function siteOf(target) {
  return SITES[targetOf(target)];
}

/** NeetCode's problem page and its submission history, for links. */
export function neetcodeProblemUrl(neetcodeSlug, page = 'question') {
  return `https://neetcode.io/problems/${encodeURIComponent(text(neetcodeSlug).trim())}/${page}`;
}

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
export function submissionUrlOf(raw, target = 'leetcode') {
  const direct = text(raw?.submissionUrl).trim();
  // NeetCode has no id we can link by, only the page the Connector was on.
  if (targetOf(target) === 'neetcode') return /^https:\/\/neetcode\.io\//.test(direct) ? direct : '';
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
  // NeetCode's console text for a failed submission, verbatim: input, output, expected.
  { label: 'NeetCode’s output', wide: true, keys: ['consoleOutput'] },
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
  demo: {tone:'',headline:'Submissions are unavailable in the demo',message:'Nothing was sent to LeetCode. Use Run to test your code locally.',retry:false,checkFirst:false},
  session_expired: {
    tone: 'err',
    headline: 'Your LeetCode session has expired',
    message: 'This browser is not signed in to LeetCode. Sign in on leetcode.com, then submit again. Nothing was submitted.',
    // Deliberately no retry. Pressing it again cannot help, and offering it would be a lie.
    retry: false,
    signIn: true,
  },
  no_session: {
    tone: 'warn',
    headline: 'You are not signed in to LeetCode',
    message: 'Nothing was submitted. This browser is not signed in to LeetCode.',
    retry: false,
    signIn: true,
  },
  no_connector: {
    tone: 'warn',
    headline: 'Install the Studio Connector to submit',
    message: 'Studio submits through your browser’s own LeetCode sign-in, using a small extension that ships with Studio. Nothing was submitted.',
    advice: 'One-time setup: open chrome://extensions (dia://extensions in Dia), turn on Developer mode, choose “Load unpacked” and pick the extension folder inside practice-studio. Then reload this page.',
    retry: false,
    fallback: true,
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

  // ---- NeetCode only (premium problems) ----
  nc_no_connector: {
    tone: 'warn',
    headline: 'Install the Studio Connector to submit to NeetCode',
    message: 'Premium problems are judged on neetcode.io through your browser’s own NeetCode sign-in, using the extension that ships with Studio. It is not installed in this browser, so nothing was submitted.',
    advice: 'One-time setup: open chrome://extensions (dia://extensions in Dia), turn on Developer mode, choose “Load unpacked” and pick the extension folder inside practice-studio. Then reload this page.',
    retry: false,
    fallback: true,
  },
  nc_old_connector: {
    tone: 'warn',
    headline: 'Update the Studio Connector',
    message: 'The Studio Connector in this browser is older than 1.1.0 and cannot submit to NeetCode, so nothing was submitted.',
    advice: 'Update the Studio Connector: reload it in chrome://extensions (the reload icon on its card), then reload this page.',
    retry: false,
    fallback: true,
  },
  nc_signed_out: {
    tone: 'warn',
    headline: 'You are not signed in to NeetCode',
    message: 'Nothing was submitted. This browser is not signed in to neetcode.io.',
    retry: false,
    signIn: true,
  },
  nc_not_python: {
    tone: 'warn',
    headline: 'NeetCode’s editor is not set to Python',
    message: 'Nothing was submitted. NeetCode’s editor is set to another language.',
    advice: 'Switch NeetCode’s editor to Python once: open the problem on neetcode.io, choose Python above the editor, then submit again here.',
    retry: false,
    openProblem: true,
  },
  nc_stale_code: {
    tone: 'err',
    headline: 'Your code did not show up in NeetCode’s editor',
    message: 'Studio did not press Submit, because NeetCode would have judged whatever was in its editor before. Nothing was submitted.',
    // Safe to offer: nothing was sent, and the next press starts again from a fresh page.
    retry: true,
    openProblem: true,
  },
  nc_timeout: {
    tone: 'warn',
    headline: 'NeetCode has not shown a verdict',
    message: 'Submit was pressed once on NeetCode, but no verdict appeared in time. This is not a verdict on your code. Look on NeetCode rather than submitting again.',
    retry: false,
    checkFirst: true,
  },
  nc_unreachable: {
    tone: 'err',
    headline: 'NeetCode could not be reached',
    message: 'The NeetCode problem page did not load. Nothing was submitted.',
    retry: true,
  },
};

// The shared presets above are worded for LeetCode. On the NeetCode path the same
// sentences are true with the site's name swapped, so they are reused that way rather
// than copied; the NeetCode-only states have their own wording.
function forSite(value, target) {
  return targetOf(target) === 'neetcode' && value ? value.replace(/LeetCode/g, 'NeetCode') : value;
}

function blocked(kind, message, slug, raw = null, where = {}) {
  const target = targetOf(where.target ?? raw?.target);
  const neetcode = target === 'neetcode';
  const ncSlug = where.neetcodeSlug || slug;
  const base = BLOCKED[kind] || BLOCKED.server;
  const preset = { ...base, headline: forSite(base.headline, target), message: forSite(base.message, target), advice: forSite(base.advice, target) };
  const url = submissionUrlOf(raw, target);
  const challenge = raw?.challenge === true;
  const submissionState = raw?.submissionState || (url ? 'submitted' : null);
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
    retry: preset.retry === true && url === '' && !challenge && submissionState !== 'unknown',
    checkFirst: url !== '' || submissionState === 'unknown' || (preset.checkFirst === true && !submissionState),
    challenge,
    submissionState,
    signIn: preset.signIn === true,
    fallback: preset.fallback === true || (challenge && submissionState === 'not_sent'),
    advice: preset.advice || '',
    openProblem: preset.openProblem === true,
    target,
    note: '',
    passed: null,
    total: null,
    runtime: '',
    memory: '',
    runtimePercentile: '',
    memoryPercentile: '',
    submissionUrl: url,
    problemUrl: neetcode ? neetcodeProblemUrl(ncSlug) : `https://leetcode.com/problems/${encodeURIComponent(slug)}/`,
    submissionsUrl: neetcode ? neetcodeProblemUrl(ncSlug, 'history') : submissionsUrlOf(slug),
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
 *
 * On NeetCode (`where.target` or `raw.target` 'neetcode') there is no status code, and
 * acceptance is the verdict text being exactly "Accepted", as the server decides it.
 */
export function shapeSubmitResult(raw, slug = '', where = {}) {
  const target = targetOf(where.target ?? raw?.target);
  const neetcode = target === 'neetcode';
  where = { ...where, target };
  if (!raw || typeof raw !== 'object') {
    return blocked('server', 'The submit request produced no response at all. Nothing came back from the judge.', slug, null, where);
  }

  if (raw.ok === false) {
    if (raw.code === 'DEMO_ONLY' || raw.kind === 'demo') return blocked('demo', neetcode ? text(raw.message) || null : null, slug, null, where);
    // An unrecognised kind or an error code nobody here has heard of still gets
    // the server's own sentence, verbatim — a generic fallback would throw away
    // the only accurate thing in the response.
    const kind = typeof raw.kind === 'string' && BLOCKED[raw.kind] ? raw.kind : 'server';
    return blocked(kind, text(raw.message) || null, slug, raw, where);
  }

  const statusCode = typeof raw.statusCode === 'number' ? raw.statusCode : null;
  const verdict = text(raw.verdict).trim();
  const claimed = raw.accepted === true;
  const accepted = neetcode
    ? claimed && verdict === 'Accepted'
    : claimed && (statusCode === null || statusCode === 10);

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
    target,
    submissionUrl: submissionUrlOf(raw, target),
    submissionsUrl: neetcode ? neetcodeProblemUrl(where.neetcodeSlug || slug, 'history') : submissionsUrlOf(slug),
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
      : neetcode && claimed
        ? `The response said it was accepted, but NeetCode’s verdict reads “${verdict || 'nothing'}”, and only “Accepted” is an acceptance. It is reported here as not accepted.`
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

  const site = siteOf(shaped.target);
  if (shaped.status === 'blocked') {
    const acts = [];
    if (shaped.retry && handlers.onResubmit) acts.push(el('button', { class: 'act', type: 'button', text: 'Submit again', onclick: handlers.onResubmit }));
    target.append(el('div', { class: 'state ' + shaped.tone }, [
      el('h3', { text: shaped.headline }),
      el('p', { text: shaped.message }),
      shaped.advice && !shaped.challenge ? el('p', { text: shaped.advice }) : null,
      shaped.fallback ? (() => {
        const copyStatus = el('p', { role: 'status', text: handlers.fallbackNote || `Or submit by hand: copy your solution, paste it into ${site.name}’s editor and submit there.` });
        const copy = el('button', { class: 'act', type: 'button', text: 'Copy current solution', onclick: async () => {
          try {
            await navigator.clipboard.writeText(handlers.getCode());
            copyStatus.textContent = `Solution copied. Paste it into ${site.name}’s editor, check the language, then submit there. Studio has not submitted it.`;
          } catch {
            copyStatus.textContent = `Clipboard access failed. Select and copy your solution from the Studio editor, then paste it on ${site.name}.`;
          }
        } });
        return el('div', {}, [
          el('div', { class: 'acts' }, [handlers.getCode ? copy : null, linkOut(shaped.problemUrl, `Open problem on ${site.name} ↗`)]),
          copyStatus,
        ]);
      })() : null,
      shaped.signIn ? el('div', { class: 'acts' }, [linkOut(site.login, `Sign in to ${site.name} ↗`)]) : null,
      shaped.openProblem && !shaped.fallback ? el('div', { class: 'acts' }, [linkOut(shaped.problemUrl, `Open problem on ${site.name} ↗`)]) : null,
      shaped.checkFirst
        ? el('p', { class: 'sub-check' }, shaped.submissionUrl
          ? [`This submission is on ${site.name} and will finish judging with or without this panel. `, linkOut(shaped.submissionUrl, 'Open it ↗')]
          : [`Check your submissions on ${site.name} before sending another — this one may already be there. `, linkOut(shaped.submissionsUrl, 'Submissions ↗')])
        : null,
      acts.length ? el('div', { class: 'acts' }, acts) : null,
    ]));
    return target;
  }

  const counts = shaped.passed === null || shaped.total === null ? ''
    : shaped.target === 'neetcode' ? `${shaped.passed} / ${shaped.total} tests`
      : `${shaped.passed} of ${shaped.total} tests passed`;

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
    stat(shaped.target === 'neetcode' ? 'Time' : 'Runtime', shaped.runtime, shaped.runtimePercentile),
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
    target.append(el('p', { class: 'sub-msg', text: `${site.name} returned this verdict without any failing input, output or error attached, so there is nothing more to show than the verdict itself.` }));
  }

  const foot = el('div', { class: 'sub-foot' }, [
    shaped.submissionUrl
      ? linkOut(shaped.submissionUrl, shaped.target === 'neetcode' ? 'Open on NeetCode ↗' : 'This submission on LeetCode ↗')
      : linkOut(shaped.submissionsUrl, `Your submissions on ${site.name} ↗`),
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
 *
 * `getTarget()` is read at each press: 'neetcode' sends a premium problem to neetcode.io
 * (as `neetcodeSlug`), anything else to LeetCode. It is a function because whether a
 * problem is premium is only known once its content has loaded.
 */
export function createSubmitPanel({ slug, getCode, onEvent = () => {}, onUseFailingCase = null, getTarget = () => 'leetcode', neetcodeSlug = null, getMismatch = () => null }) {
  const body = el('div', { class: 'sub-body' });
  const scope = el('span', { class: 'mono sub-scope', text: 'leetcode.com' });
  let where = { target: 'leetcode', neetcodeSlug: neetcodeSlug || slug };
  function aim() {
    where = { target: targetOf(getTarget()), neetcodeSlug: neetcodeSlug || slug };
    scope.textContent = siteOf(where.target).host;
    return where;
  }
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
        el('span', { class: 'mono', text: `Judging on ${siteOf(where.target).name}` }),
        clock,
        el('span', { class: 'spacer' }),
        el('button', { class: 'act', type: 'button', text: 'Stop waiting', onclick: () => stop('cancelled') }),
      ]),
    ]));
    ticker = setInterval(() => {
      const elapsed = Date.now() - started;
      clock.textContent = (elapsed / 1000).toFixed(1) + 's';
      fill.style.transform = `scaleX(${Math.min(1, elapsed / WATCH_CAP_MS).toFixed(3)})`;
      if (elapsed >= WATCH_CAP_MS) stop('timeout');
    }, 100);
  }

  function stop(reason) {
    if (!busy) return;
    if (controller) { try { controller.abort(); } catch { /* already gone */ } }
    finish(shapeSubmitResult({ ok: false, kind: reason }, slug, where));
  }

  function finish(shaped, extra = {}) {
    busy = false;
    controller = null;
    if (ticker) { clearInterval(ticker); ticker = null; }
    last = shaped;
    // No resubmit affordance on the states where a second submission is either
    // useless (expired session) or unwelcome (rate limited).
    const allow = shaped.status !== 'blocked' || shaped.retry;
    renderSubmitResult(body, shaped, {
      ...extra,
      getCode,
      ...(allow ? { onResubmit: submit } : {}),
      ...(onUseFailingCase ? { onUseFailingCase } : {}),
    });
    onEvent({ type: 'result', shaped });
    if (shaped.status === 'rejected') requestAnimationFrame(() => {
      // Move only the results scroller: revealing a failure must not shift the editor.
      const comparison = [...body.querySelectorAll('.sub-detail')].find(node => node.firstElementChild?.textContent === 'Expected output') || body.querySelector('.sub-details');
      const pane = root.closest('.ws-results');
      if (!comparison || !pane || last !== shaped) return;
      const block = comparison.getBoundingClientRect();
      const viewport = pane.getBoundingClientRect();
      if (block.top < viewport.top || block.bottom > viewport.bottom) {
        pane.scrollTo({ top: pane.scrollTop + block.top - viewport.top - 8,
          behavior: document.body.classList.contains('motion-off') || matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
      }
    });
  }

  /** The only path that submits. Called from a click, never from anything else. */
  async function submit() {
    if (busy) return;
    const mismatch = targetOf(getTarget()) === 'neetcode' ? getMismatch() : null;
    if (mismatch) {
      root.hidden = false;
      aim();
      replace(body, [
        el('p', { text: mismatch.message }),
        ...(mismatch.fix ? [el('button', { class: 'act', type: 'button',
          text: "Use NeetCode's name", onclick: () => {
            mismatch.fix();
            replace(body, el('p', { text: 'Check your code, then submit when ready.' }));
          } })] : []),
      ]);
      return;
    }
    busy = true;
    root.hidden = false;
    controller = new AbortController();
    aim();
    onEvent({ type: 'start' });
    showJudging();
    const raw = await submitCode(slug, getCode(), controller.signal, where);
    if (!busy) return;               // stopped watching while we waited
    finish(shapeSubmitResult(raw, slug, where));
    if (raw.submissionId) {
      const detail = { slug, submissionId: String(raw.submissionId) };
      window.dispatchEvent(new CustomEvent('studio-submission', { detail }));
      let footer = body.querySelector('.sub-foot');
      if (!footer) {
        footer = el('div', { class: 'sub-foot' }, el('span', { class: 'spacer' }));
        body.append(footer);
      }
      footer.append(el('button', { class: 'ws-mini', type: 'button', text: 'Open in Submissions', onclick: () => window.dispatchEvent(new CustomEvent('studio-open-submission', { detail })) }));
    }
  }

  /** Show why nothing can be submitted, without submitting: the caller has already
   *  fallen back (for NeetCode, copied the code and opened the problem). */
  function explain(kind, note = '') {
    if (busy) return;
    root.hidden = false;
    aim();
    finish(shapeSubmitResult({ ok: false, kind, target: where.target }, slug, where), note ? { fallbackNote: note } : {});
  }

  return {
    root,
    submit,
    explain,
    /** '' when a press can go through the Connector; otherwise the panel kind saying
     *  why not ('nc_no_connector', 'nc_old_connector'). Only NeetCode checks ahead. */
    blocker: () => (targetOf(getTarget()) === 'neetcode' ? neetcodeSubmitBlocker() : ''),
    targetName: () => siteOf(where.target).name,
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
