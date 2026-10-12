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

const LEETCODE = 'https://leetcode.com';
const TAB_LOAD_MS = 25000;
const POLL_CEILING_MS = 55000;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const inFlight = new Set();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'studio-submit') return;
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(port.sender?.url ?? '')) {
    port.disconnect();
    return;
  }
  port.onMessage.addListener(async (message) => {
    if (message?.type !== 'submit') return;
    const result = await submit(message);
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
