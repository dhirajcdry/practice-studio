// Submits to LeetCode from inside a leetcode.com tab, so the request is the browser's
// own: its cookies, its CSRF token, its Cloudflare clearance and its TLS fingerprint.
// That is why this works where a request from Studio's Node server gets challenged.
//
// The protocol is docs/LEETCODE-API.md Part 2; the full design is docs/SUBMITTING.md.
// Rules that hold everywhere here:
//   * ONE POST to /submit/ per request. No retry anywhere.
//   * `question_id` is the INTERNAL questionId from GraphQL, not the displayed number.
//   * `state: "SUCCESS"` means judging finished; the verdict itself is decided by Studio.
//   * Every error says whether anything reached LeetCode (`submissionState`).
//
// Premium problems go to neetcode.io instead (`target: 'neetcode'`, further down). That
// path never touches a cookie: it puts the code where NeetCode's own editor loads it
// from, presses NeetCode's own Submit button once, and reads the verdict off the page.

const LEETCODE = 'https://leetcode.com';
const TAB_LOAD_MS = 25000;
const POLL_CEILING_MS = 55000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const inFlight = new Set();
const detailsInFlight = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'studio-submit') return;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(port.sender?.url ?? '')) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(async (message) => {
    if (message?.type === 'details') {
      const result = await fetchDetails(message);
      try { port.postMessage(result); } catch {}
      return;
    }
    if (message?.type !== 'submit') return;
    // Only an explicit target sends anywhere but LeetCode; the LeetCode path is unchanged.
    const result = message.target === 'neetcode'
      ? await submitNeetCode(message, port.sender?.tab?.id ?? null)
      : await submit(message);
    try { port.postMessage(result); } catch { /* the Studio tab closed while judging */ }
  });
});

function fail(code, message, extra = {}) {
  return { ok: false, code, message, submissionState: 'not_sent', ...extra };
}

async function submit({ slug, code, lang }) {
  if (typeof slug !== 'string' || !SLUG.test(slug)) return fail('BAD_REQUEST', 'That submit request did not name a valid problem. Nothing was submitted.');
  if (typeof code !== 'string' || code.trim() === '') return fail('BAD_REQUEST', 'There is no code to submit. Nothing was submitted.');
  if (inFlight.has(slug)) {
    return fail('SUBMIT_IN_FLIGHT', 'A submission for this problem is already being judged. Wait for it to finish. Nothing was sent twice.');
  }
  inFlight.add(slug);
  let tab = null;
  try {
    const [session, csrf] = await Promise.all([
      chrome.cookies.get({ url: LEETCODE, name: 'LEETCODE_SESSION' }),
      chrome.cookies.get({ url: LEETCODE, name: 'csrftoken' }),
    ]);
    if (!session?.value || !csrf?.value) {
      return fail('SIGNED_OUT', 'This browser profile is not signed in to LeetCode. Sign in on leetcode.com, then submit again. Nothing was submitted.');
    }

    tab = await leetcodeTab(slug);
    if (!tab) {
      return fail('JUDGE_UNREACHABLE', 'A LeetCode tab could not be opened in time. Check your connection, then submit again. Nothing was submitted.');
    }

    const sent = await inTab(tab.id, pageSubmit, [slug, code, lang === 'python3' ? lang : 'python3', csrf.value]);
    if (!sent) {
      return fail('CONNECTOR_ERROR', 'Studio Connector could not run inside the LeetCode tab. Check your submissions on LeetCode before sending another.', { submissionState: 'unknown' });
    }
    if (!sent.ok) return sent;

    const judged = await inTab(tab.id, pagePoll, [sent.submissionId, csrf.value, POLL_CEILING_MS]);
    if (judged?.ok && judged.check?.state === 'SUCCESS') {
      const read = await inTab(tab.id, pageDetails, [sent.submissionId, csrf.value]);
      judged.details = read?.details ?? null;
      if (!read?.ok) judged.detailsError = read?.detailsError || 'Submission details could not be read.';
    }
    return judged ?? {
      ok: false, code: 'JUDGE_UNREACHABLE', submissionState: 'submitted', submissionId: sent.submissionId,
      message: 'The submission went through, but its verdict could not be read back. Open it on LeetCode. Do not submit again.',
    };
  } catch {
    return fail('CONNECTOR_ERROR', 'Studio Connector hit an unexpected error. Check your submissions on LeetCode before sending another.', { submissionState: 'unknown' });
  } finally {
    inFlight.delete(slug);
    if (tab?.created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** An open, loaded leetcode.com tab, or a new background one on the problem page. */
async function leetcodeTab(slug) {
  const open = await chrome.tabs.query({ url: `${LEETCODE}/*` });
  const ready = open.find((t) => !t.discarded && t.status === 'complete');
  if (ready) return { id: ready.id, created: false };

  const created = await chrome.tabs.create({ url: `${LEETCODE}/problems/${slug}/`, active: false });
  const loaded = await new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(watch); resolve(false); }, TAB_LOAD_MS);
    function watch(tabId, change) {
      if (tabId !== created.id || change.status !== 'complete') return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(watch);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(watch);
  });
  if (!loaded) {
    chrome.tabs.remove(created.id).catch(() => {});
    return null;
  }
  return { id: created.id, created: true };
}

async function inTab(tabId, func, args) {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return frame?.result ?? null;
  } catch {
    return null;
  }
}

/* ===== NeetCode: premium problems (target 'neetcode') ===== */
//
// LeetCode premium problems are judged on neetcode.io instead, in this browser's own
// NeetCode sign-in. No cookie is read here, for NeetCode or anyone: the page's own
// session does the work, exactly as when Dhiraj presses Submit there himself.
//
// The sequence, and why each step is there:
//   1. Get a neetcode.io tab: reuse a loaded one, or open the problem in a background tab
//      (closed again afterwards, only if we opened it).
//   2. Write the code into localStorage under `<slug>_python_tabs`, which is where
//      NeetCode's editor loads its code from on page load. Its Monaco editor is not
//      reachable from outside the page (there is no window.monaco), and typing into it
//      would fight auto-indent and bracket completion, so this is the one way to put the
//      exact bytes there.
//   3. Load /problems/<slug>/question fresh. The editor reads what we wrote, and no
//      verdict from an earlier submission is on the page to be mistaken for ours.
//   4. The stale-code guard. Before pressing anything, check that the editor SHOWS our
//      code, and that NeetCode's stored copy is still ours. If not, stop with not_sent.
//      Submitting whatever was in NeetCode's editor before is the one mistake this path
//      must never make, so a doubt here is always a refusal, never a guess.
//   5. Press NeetCode's Submit button ONCE. Then read the page once a second for a
//      verdict that was not there before the press, for up to 60 s. Reading the page is
//      not resubmitting, and nothing here ever presses Submit a second time.

const NEETCODE = 'https://neetcode.io';
const NC_PREPARE_MS = 20000;
const NC_VERDICT_MS = 60000;
const NC_POLL_MS = 1000;
/** Polls to wait for the full verdict card once only the console line has appeared. */
const NC_CARD_GRACE_POLLS = 3;

async function submitNeetCode({ neetcodeSlug, code }, studioTabId) {
  const slug = neetcodeSlug;
  if (typeof slug !== 'string' || !SLUG.test(slug)) return fail('BAD_REQUEST', 'That submit request did not name a valid NeetCode problem. Nothing was submitted.');
  if (typeof code !== 'string' || code.trim() === '') return fail('BAD_REQUEST', 'There is no code to submit. Nothing was submitted.');
  const key = `neetcode:${slug}`;
  if (inFlight.has(key)) {
    return fail('SUBMIT_IN_FLIGHT', 'A submission for this problem is already on its way to NeetCode. Wait for it to finish. Nothing was sent twice.');
  }
  inFlight.add(key);
  const questionUrl = `${NEETCODE}/problems/${slug}/question`;
  let tab = null;
  let activated = false;
  let pressed = false;
  try {
    // NeetCode's editor only draws, and its page only judges reliably, while its tab is on
    // screen. A tab in another window cannot be put on screen from here (macOS hides an
    // occluded window), so the tab has to live in Studio's own window, and it is shown
    // for the few seconds the submission takes, then Studio comes back to the front.
    const windowId = studioTabId !== null
      ? await chrome.tabs.get(studioTabId).then((t) => t.windowId, () => undefined)
      : undefined;
    tab = await neetcodeTab(slug, questionUrl, windowId);
    if (tab) activated = await chrome.tabs.update(tab.id, { active: true }).then(() => true, () => false);
    if (!tab) {
      return fail('JUDGE_UNREACHABLE', 'A NeetCode tab could not be opened in time. Check your connection, then submit again. Nothing was submitted.');
    }

    const stored = await inTab(tab.id, pageStoreNeetCodeCode, [slug, code]);
    if (!stored) return fail('CONNECTOR_ERROR', 'Studio Connector could not run inside the NeetCode tab. Nothing was submitted.');
    if (!stored.ok) return stored;

    if (!(await loadTab(tab.id, questionUrl))) {
      return fail('JUDGE_UNREACHABLE', 'The NeetCode problem page did not finish loading. Check your connection, then submit again. Nothing was submitted.');
    }

    let sent = await inTab(tab.id, pageNeetCodeSubmit, [slug, code, NC_PREPARE_MS]);
    // Monaco paints its lines on animation frames, which a background tab may not get, so
    // in a hidden tab there can be nothing on screen to check. Bring the tab forward and
    // run the same function once more. That is not a retry: the first call returned
    // before pressing anything (EDITOR_HIDDEN is only ever answered before the press).
    if (sent?.code === 'EDITOR_HIDDEN') {
      activated = await chrome.tabs.update(tab.id, { active: true }).then(() => true, () => false);
      if (activated) sent = await inTab(tab.id, pageNeetCodeSubmit, [slug, code, NC_PREPARE_MS]);
    }
    if (!sent) {
      return fail('CONNECTOR_ERROR', 'Studio Connector stopped while working in the NeetCode tab. Check your submissions on NeetCode before sending another.', { submissionState: 'unknown', url: `${NEETCODE}/problems/${slug}/history` });
    }
    if (!sent.ok) return sent;
    pressed = true;

    // === Submit was pressed exactly once. From here on we only read. ===
    const started = Date.now();
    let grace = NC_CARD_GRACE_POLLS;
    let lastUrl = sent.url || questionUrl;
    let partial = null;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, NC_POLL_MS));
      const seen = await inTab(tab.id, pageNeetCodeVerdict, []);
      if (seen?.url) lastUrl = seen.url;
      if (seen?.signInPrompt) {
        return fail('SIGNED_OUT', 'NeetCode asked this browser to sign in instead of judging. Sign in on neetcode.io, then submit again. Check your submissions on NeetCode first.', { submissionState: 'unknown', url: lastUrl });
      }
      if (seen?.status) {
        // The console line can land a moment before the verdict card with time and memory.
        // A failure's test-case section can render a beat after its title; give it the
        // same grace so the failing input comes back with the verdict.
        const settled = seen.complete && (seen.accepted || seen.input || seen.error);
        if (settled || grace <= 0) return { ok: true, target: 'neetcode', result: seen };
        partial = seen;
        grace -= 1;
      }
      if (seen === null && !(await chrome.tabs.get(tab.id).then(() => true, () => false))) {
        return fail('JUDGE_TIMEOUT', 'The NeetCode tab was closed before its verdict appeared. Submit was pressed once; check your submissions on NeetCode. Do not submit again.', { submissionState: 'submitted', url: `${NEETCODE}/problems/${slug}/history` });
      }
      if (Date.now() - started >= NC_VERDICT_MS) {
        if (partial) return { ok: true, target: 'neetcode', result: partial };
        return fail('JUDGE_TIMEOUT', `NeetCode had not shown a verdict after ${Math.round(NC_VERDICT_MS / 1000)} seconds. Submit was pressed once; look on NeetCode: ${lastUrl}. Do not submit again.`, { submissionState: 'submitted', url: lastUrl });
      }
    }
  } catch {
    return fail('CONNECTOR_ERROR', 'Studio Connector hit an unexpected error. Check your submissions on NeetCode before sending another.', { submissionState: pressed ? 'submitted' : 'unknown', url: `${NEETCODE}/problems/${slug}/history` });
  } finally {
    inFlight.delete(key);
    if (activated && studioTabId !== null) chrome.tabs.update(studioTabId, { active: true }).catch(() => {});
    if (tab?.created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

/** A loaded neetcode.io tab in Studio's window (one already on this problem first), or a new one there. */
async function neetcodeTab(slug, questionUrl, windowId) {
  const open = await chrome.tabs.query(windowId === undefined ? { url: `${NEETCODE}/*` } : { url: `${NEETCODE}/*`, windowId });
  const ready = open.filter((t) => !t.discarded && t.status === 'complete');
  const same = ready.find((t) => (t.url || '').startsWith(`${NEETCODE}/problems/${slug}/`));
  if (same || ready[0]) return { id: (same || ready[0]).id, created: false };

  const created = await chrome.tabs.create({ url: questionUrl, active: false, ...(windowId === undefined ? {} : { windowId }) });
  if (!(await whenLoaded(created.id, false))) {
    chrome.tabs.remove(created.id).catch(() => {});
    return null;
  }
  return { id: created.id, created: true };
}

/** Load `url` in the tab afresh (a reload when it is already there) and wait for it. */
async function loadTab(tabId, url) {
  const current = await chrome.tabs.get(tabId);
  const loaded = whenLoaded(tabId, true);
  if (current.url === url) await chrome.tabs.reload(tabId);
  else await chrome.tabs.update(tabId, { url });
  return loaded;
}

/** Resolves true on the tab's next `complete`. With `fresh`, only a `complete` that
 *  follows a `loading`, so an earlier load finishing cannot be mistaken for this one. */
function whenLoaded(tabId, fresh) {
  return new Promise((resolve) => {
    let sawLoading = !fresh;
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(watch); resolve(false); }, TAB_LOAD_MS);
    function watch(id, change) {
      if (id !== tabId) return;
      if (change.status === 'loading') sawLoading = true;
      if (change.status !== 'complete' || !sawLoading) return;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(watch);
      resolve(true);
    }
    chrome.tabs.onUpdated.addListener(watch);
  });
}

/* ===== Everything below runs inside the leetcode.com tab and must be self-contained. ===== */

/** Look up the internal question id, then send exactly one POST to /submit/. */
async function pageSubmit(slug, code, lang, csrf) {
  const headers = { 'content-type': 'application/json', accept: 'application/json', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' };
  const notSent = (code, message, extra = {}) => ({ ok: false, code, message, submissionState: 'not_sent', ...extra });

  async function problem(res, sent) {
    const state = sent ? 'unknown' : 'not_sent';
    const tail = sent ? ' Check your submissions on LeetCode before sending another.' : ' Nothing was submitted.';
    const type = res.headers.get('content-type') || '';
    if (res.status === 429) return notSent('RATE_LIMITED', 'LeetCode is rate-limiting submissions. Wait a minute or two, then submit again.' + tail, { submissionState: state });
    if (!type.includes('json')) {
      const text = await res.text().catch(() => '');
      if (res.headers.get('cf-mitigated') === 'challenge' || /Just a moment|cf-browser-verification|cdn-cgi\/challenge/i.test(text)) {
        return notSent('JUDGE_UNREACHABLE', 'Cloudflare wants this browser to verify itself. Open the LeetCode tab, finish the check, then submit again.' + tail, { submissionState: state, challenge: true });
      }
      if (res.url.includes('/accounts/login') || res.status === 401 || res.status === 403) {
        return notSent('SESSION_EXPIRED', 'LeetCode treated this browser as signed out. Sign in on leetcode.com, then submit again.' + tail, { submissionState: state });
      }
      return notSent('JUDGE_UNREACHABLE', `LeetCode returned a web page instead of data (HTTP ${res.status}).` + tail, { submissionState: state });
    }
    if (res.status === 401 || res.status === 403) {
      return notSent('SESSION_EXPIRED', 'LeetCode refused the request as signed out. Sign in on leetcode.com, then submit again.' + tail, { submissionState: state });
    }
    if (!res.ok) return notSent('JUDGE_UNREACHABLE', `LeetCode returned HTTP ${res.status}.` + tail, { submissionState: state });
    return null;
  }

  let res;
  try {
    res = await fetch(`${location.origin}/graphql/`, {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({
        operationName: 'questionData',
        variables: { titleSlug: slug },
        query: 'query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId } }',
      }),
    });
  } catch {
    return notSent('JUDGE_UNREACHABLE', 'LeetCode could not be reached. Nothing was submitted.');
  }
  const lookupProblem = await problem(res, false);
  if (lookupProblem) return lookupProblem;
  const lookup = await res.json().catch(() => null);
  const questionId = String(lookup?.data?.question?.questionId ?? '');
  if (!/^[1-9][0-9]*$/.test(questionId)) {
    return notSent('PROBLEM_NOT_FOUND', `LeetCode does not know a problem called "${slug}". Nothing was submitted.`);
  }

  // === the one and only POST /submit/ ===
  try {
    res = await fetch(`${location.origin}/problems/${slug}/submit/`, {
      method: 'POST', headers, credentials: 'include',
      body: JSON.stringify({ lang, question_id: questionId, typed_code: code, test_mode: false, judge_type: 'large' }),
    });
  } catch {
    return notSent('JUDGE_UNREACHABLE', 'The connection dropped while sending. Check your submissions on LeetCode before sending another.', { submissionState: 'unknown' });
  }
  const submitProblem = await problem(res, true);
  if (submitProblem) return submitProblem;
  const body = await res.json().catch(() => null);
  const submissionId = body?.submission_id;
  if (submissionId === undefined || submissionId === null || submissionId === '') {
    return notSent('JUDGE_UNREACHABLE', 'LeetCode answered but did not return a submission id. Check your submissions on LeetCode before sending another.', { submissionState: 'unknown' });
  }
  return { ok: true, submissionId, questionId };
}

/** Poll /check/ once a second until judging finishes, with a hard ceiling. Never resubmits. */
async function pagePoll(submissionId, csrf, ceilingMs) {
  const url = `${location.origin}/submissions/detail/${submissionId}/check/`;
  const link = `${location.origin}/submissions/detail/${submissionId}/`;
  const stuck = (code, message) => ({ ok: false, code, message, submissionState: 'submitted', submissionId });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const started = Date.now();

  await sleep(1000);
  for (;;) {
    let check = null;
    try {
      const res = await fetch(url, {
        credentials: 'include',
        headers: { accept: 'application/json', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' },
      });
      if ((res.headers.get('content-type') || '').includes('json')) check = await res.json();
    } catch { /* one dropped poll is not a verdict; the ceiling below still applies */ }

    if (check?.state === 'SUCCESS') return { ok: true, submissionId, check };
    if (check?.state === 'FAILURE') {
      return stuck('JUDGE_UNREACHABLE', `LeetCode's judge reported an internal failure instead of a verdict. The submission exists: ${link}`);
    }
    if (Date.now() - started >= ceilingMs) {
      return stuck('JUDGE_TIMEOUT', `LeetCode had not finished judging after ${Math.round(ceilingMs / 1000)} seconds. Submission ${submissionId} is real: ${link}. Do not submit again.`);
    }
    await sleep(1000);
  }
}

/* ===== Everything below runs inside the neetcode.io tab and must be self-contained. ===== */

/**
 * Put `code` where NeetCode's editor loads it from: `<slug>_python_tabs`, a JSON array of
 * editor tabs (`[{ code }]`), at the index in `<slug>_python_activeTab`. Every other field
 * of that tab is kept. A missing or unreadable key becomes one tab holding our code.
 */
function pageStoreNeetCodeCode(slug, code) {
  const tabsKey = `${slug}_python_tabs`;
  const activeKey = `${slug}_python_activeTab`;
  try {
    let tabs = null;
    try { tabs = JSON.parse(localStorage.getItem(tabsKey) ?? 'null'); } catch { tabs = null; }
    let active = Number.parseInt(localStorage.getItem(activeKey) ?? '', 10);
    if (!Array.isArray(tabs) || tabs.length === 0) {
      tabs = [{ code }];
      active = 0;
    } else {
      if (!Number.isInteger(active) || active < 0 || active >= tabs.length) active = 0;
      const current = tabs[active] && typeof tabs[active] === 'object' && !Array.isArray(tabs[active]) ? tabs[active] : {};
      tabs = tabs.slice();
      tabs[active] = { ...current, code };
    }
    localStorage.setItem(tabsKey, JSON.stringify(tabs));
    localStorage.setItem(activeKey, String(active));
    return { ok: true, activeTab: active };
  } catch {
    return { ok: false, code: 'CONNECTOR_ERROR', submissionState: 'not_sent', message: 'NeetCode’s page would not let Studio Connector store your code. Nothing was submitted.' };
  }
}

/**
 * Wait for the editor, check it shows OUR code (the stale-code guard), then press Submit
 * exactly once. Every answer before the press is not_sent.
 *
 * The guard has two halves, and both must hold:
 *   * NeetCode's stored copy of the active tab is still our code. If the page wrote its
 *     own code back over ours while loading, the editor is showing something else.
 *   * What Monaco has painted is our code. Its `.view-line`s (sorted by their `top`, the
 *     order Monaco lays them out in) are joined and compared with all whitespace removed,
 *     because Monaco paints spaces as U+00A0, may draw whitespace markers, and wraps long
 *     lines into several view-lines. The painted text must be the start of our code: all
 *     of it when the code fits on screen, otherwise everything the viewport shows.
 * The first-line check alone would not do: nearly every solution starts with
 * `class Solution:`, so stale starter code would pass it.
 */
async function pageNeetCodeSubmit(slug, code, waitMs) {
  const notSent = (errorCode, message) => ({ ok: false, code: errorCode, message, submissionState: 'not_sent' });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const squash = (s) => String(s ?? '').replace(/[\s ·→⸱​‌‍﻿]/g, '');
  const visible = (el) => el && el.getClientRects().length > 0;
  const want = squash(code);
  const started = Date.now();

  const signInPrompt = () => [...document.querySelectorAll('a, button')]
    .some((el) => visible(el) && /^\s*(sign\s*in|log\s*in|login)\s*$/i.test(el.textContent || ''));

  function storedIsOurs() {
    try {
      const tabs = JSON.parse(localStorage.getItem(`${slug}_python_tabs`) ?? 'null');
      const active = Number.parseInt(localStorage.getItem(`${slug}_python_activeTab`) ?? '0', 10) || 0;
      return Array.isArray(tabs) && squash(tabs[active]?.code) === want;
    } catch {
      return false;
    }
  }

  function painted() {
    return [...document.querySelectorAll('.monaco-editor')].map((editor) => [...editor.querySelectorAll('.view-lines .view-line')]
      .map((line) => ({ top: Number.parseFloat(line.style.top) || 0, text: line.textContent || '' }))
      .sort((a, b) => a.top - b.top)
      .map((line) => line.text)
      .join('\n'));
  }

  const showsOurs = (texts) => texts.some((text) => {
    const shown = squash(text);
    return shown !== '' && want.startsWith(shown);
  });

  let lines = [];
  for (;;) {
    const language = document.querySelector('button.editor-language-btn');
    if (language && !/python/i.test(language.textContent || '')) {
      return notSent('NOT_PYTHON', `NeetCode’s editor is set to ${(language.textContent || '').trim() || 'another language'}, not Python. Switch NeetCode’s editor to Python once, then submit again. Nothing was submitted.`);
    }
    const button = document.querySelector('button.submit-btn');
    lines = painted();
    if (!button && signInPrompt() && Date.now() - started > 5000) {
      return notSent('SIGNED_OUT', 'This browser profile is not signed in to NeetCode. Sign in to neetcode.io in this browser, then submit again. Nothing was submitted.');
    }
    if (button && !button.disabled && storedIsOurs() && showsOurs(lines)) break;
    // A hidden tab may never paint Monaco. Say so early, so the worker can bring it forward.
    if (button && document.hidden && lines.every((text) => text === '') && Date.now() - started > 4000) {
      return notSent('EDITOR_HIDDEN', 'NeetCode’s editor did not draw in a background tab, so Studio could not check your code was in it. Keep a neetcode.io tab open in front once, then submit again. Nothing was submitted.');
    }
    if (Date.now() - started >= waitMs) {
      if (!button) {
        return signInPrompt()
          ? notSent('SIGNED_OUT', 'This browser profile is not signed in to NeetCode. Sign in to neetcode.io in this browser, then submit again. Nothing was submitted.')
          : notSent('JUDGE_UNREACHABLE', 'NeetCode’s problem page loaded, but its Submit button never appeared. Open the problem on neetcode.io to check it works, then submit again. Nothing was submitted.');
      }
      if (button.disabled) return notSent('JUDGE_UNREACHABLE', 'NeetCode’s Submit button stayed disabled. Nothing was submitted.');
      return notSent('STALE_CODE', 'NeetCode’s editor is not showing the code from Studio, so Studio did not press Submit: it would have judged whatever was there before. Nothing was submitted.');
    }
    await sleep(500);
  }

  if (signInPrompt()) {
    return notSent('SIGNED_OUT', 'This browser profile is not signed in to NeetCode. Sign in to neetcode.io in this browser, then submit again. Nothing was submitted.');
  }
  // Any verdict already on the page is not ours. Mark it, so the reader skips it.
  for (const old of document.querySelectorAll('.submission-status-title, .output-header .status-row p')) old.dataset.studioSeen = '1';

  // === the one and only press of Submit ===
  document.querySelector('button.submit-btn').click();
  return { ok: true, url: location.href };
}

/**
 * Read the verdict NeetCode rendered after our press, or `{ status: null }` while there is
 * none yet. Read-only; safe to call once a second.
 *
 * `accepted` is only a hint. The server decides acceptance, and only the exact status
 * text "Accepted" counts (server/judge/verdict.mjs, buildNeetCodeVerdict).
 */
function pageNeetCodeVerdict() {
  const PENDING = /^(pending|judging|running|queued|processing|submitting)\b/i;
  const visible = (el) => el && el.getClientRects().length > 0;
  const fresh = (selector) => [...document.querySelectorAll(selector)].find((el) => {
    const text = (el.textContent || '').trim();
    return el.dataset.studioSeen !== '1' && text !== '' && !PENDING.test(text);
  });
  const title = fresh('.submission-status-title');
  const line = fresh('.output-header .status-row p[class*="submission-result-"]');
  const shown = title || line;
  if (!shown) {
    const prompt = [...document.querySelectorAll('[role="dialog"], .modal, .cdk-overlay-pane, mat-dialog-container')]
      .some((el) => visible(el) && /sign\s*in|log\s*in/i.test(el.textContent || ''));
    return { status: null, signInPrompt: prompt, url: location.href };
  }

  const card = title ? (title.closest('.submission-detail') || document) : null;
  const countText = (card?.querySelector('.test-case-count')?.textContent)
    || (document.querySelector('.output-header .test-case-count')?.textContent) || '';
  const counts = /(\d+)\s*\/\s*(\d+)/.exec(countText);
  const metas = card ? [...card.querySelectorAll('.submission-meta span')].map((s) => (s.textContent || '').trim()) : [];
  const meta = (label) => {
    const hit = metas.find((t) => t.toLowerCase().startsWith(`${label}:`));
    return hit ? hit.slice(label.length + 1).trim() || null : null;
  };
  const output = document.querySelector('.output-content');
  const status = (shown.textContent || '').trim();
  // A failed submission names its failing case in one of two layouts, and the label is
  // followed by its value either way [VERIFIED 2026-10-16 on valid-tree and
  // count-connected-components]:
  //   the console:        p.output-label "Input:"   then <code>
  //   the verdict card:   p.test-case-label "Input" then pre.test-case-value
  // ("Your Output" / "Expected output" or "Expected Output" likewise). Read them by label
  // so the page can offer the failing input as a test case.
  const detail = card || document.querySelector('.submission-detail');
  const labelled = (pattern) => {
    const labels = [
      ...(detail?.querySelectorAll('.test-case-label') || []),
      ...(output?.querySelectorAll('.output-label') || []),
    ];
    for (const label of labels) {
      if (!pattern.test((label.textContent || '').trim())) continue;
      let node = label.nextElementSibling;
      while (node && !/^(PRE|CODE)$/.test(node.tagName) && !node.querySelector?.('pre, code')) {
        if (node.matches?.('.test-case-label, .output-label')) { node = null; break; }
        node = node.nextElementSibling;
      }
      const value = node && (/^(PRE|CODE)$/.test(node.tagName) ? node : node.querySelector('pre, code'));
      const text = (value?.textContent || '').trim();
      if (text) return text.slice(0, 4000);
    }
    return null;
  };
  // A runtime error inside a failing case prints its traceback under "Error".
  const errorText = ((detail || output)?.querySelector('[class*="error-text"]')?.textContent || '').trim();
  return {
    status,
    accepted: status === 'Accepted' || shown.classList.contains('submission-result-accepted'),
    passed: counts ? Number(counts[1]) : null,
    total: counts ? Number(counts[2]) : null,
    memory: meta('memory'),
    time: meta('time'),
    details: ((output?.innerText ?? output?.textContent) || '').trim().slice(0, 4000),
    input: labelled(/^input:?$/i),
    error: errorText ? errorText.slice(0, 4000) : null,
    output: labelled(/^your output:?$/i),
    expected: labelled(/^expected( output)?:?$/i),
    url: location.href,
    complete: Boolean(title),
  };
}

async function fetchDetails({ submissionId, slug }) {
  if (!/^[1-9]\d*$/.test(String(submissionId))) {
    return { ok: false, details: null, message: 'That submission id is invalid.' };
  }
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    return { ok: false, details: null, message: 'That problem name is invalid.' };
  }
  const key = `${slug}:${submissionId}`;
  if (detailsInFlight.has(key)) {
    return {
      ok: false, details: null, code: 'DETAILS_IN_FLIGHT',
      message: 'Details for this submission are already being read. Wait for that read to finish.',
    };
  }
  detailsInFlight.add(key);
  let tab;
  try {
    const csrf = await chrome.cookies.get({ url: LEETCODE, name: 'csrftoken' });
    if (!csrf?.value) return { ok: false, details: null, message: 'Sign in on LeetCode to read details.' };
    tab = await leetcodeTab(slug);
    const result = tab && await inTab(tab.id, pageDetails, [submissionId, csrf.value]);
    return result || { ok: false, details: null, message: 'The details could not be read.' };
  } catch {
    return { ok: false, details: null, message: 'The details could not be read.' };
  } finally {
    detailsInFlight.delete(key);
    if (tab?.created) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function pageDetails(submissionId, csrf) {
  try {
    const response = await fetch('/graphql/', {
      method: 'POST', credentials: 'include', signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrftoken': csrf, 'x-requested-with': 'XMLHttpRequest' },
      body: JSON.stringify({ operationName: 'submissionDetails', variables: { submissionId: Number(submissionId) },
        query: `query submissionDetails($submissionId: Int!) {
          submissionDetails(submissionId: $submissionId) {
            runtime runtimeDisplay runtimePercentile runtimeDistribution
            memory memoryDisplay memoryPercentile memoryDistribution
            timestamp statusCode lang { name } totalCorrect totalTestcases
            lastTestcase codeOutput expectedOutput stdOutput compileError runtimeError
          }
        }` }),
    });
    if (!response.ok) throw new Error('LeetCode could not return submission details.');
    const body = await response.json();
    if (body.errors?.length) throw new Error(body.errors.map(e => e.message).join('; ').slice(0, 2000));
    const details = body.data?.submissionDetails;
    if (!details || typeof details !== 'object') throw new Error('LeetCode returned no submission details.');
    for (const key of ['runtimeDistribution', 'memoryDistribution']) {
      if (typeof details[key] === 'string') {
        try {
          details[key] = JSON.parse(details[key]);
        } catch {
          details[key] = null;
        }
      }
    }
    return { ok: true, details };
  } catch (error) {
    return { ok: false, details: null, detailsError: error.message, message: 'Submission details could not be read.' };
  }
}
