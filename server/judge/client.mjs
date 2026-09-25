// The verified submit protocol. docs/API-CONTRACT-P2.md "Phase 4 — The judge",
// [VERIFIED 2026-07-25] by one real hand-made submission that returned Accepted 64/64.
//
// This file implements exactly that and nothing more. In particular:
//
//   * ONE submission per call. There is no retry, no backoff-and-resubmit, no batching,
//     and deliberately no code path that can issue a second POST to /submit/. A retry loop
//     against someone else's judge is what turns a tolerated tool into abuse.
//   * `state: "SUCCESS"` means judging FINISHED. Acceptance is `status_code === 10`.
//   * `question_id` is the INTERNAL questionId from GraphQL, not the displayed number.
//     They are both "1" for two-sum, so a first test cannot catch a mix-up — hence the
//     per-slug cache and the explicit naming here.
//   * cf_clearance is bound to the User-Agent that minted it, so every request in this
//     file sends the SAME UA. Do not "tidy" it into a per-call option.
//   * Auth failures and Cloudflare challenges arrive as HTML. Nothing here parses a body
//     before checking content-type.

const BASE = 'https://leetcode.com';
const GRAPHQL_URL = `${BASE}/graphql/`;

/** Must match the browser that obtained cf_clearance, and must be identical on every
 *  request. Same string as server/leetcode.mjs; overridable only for the case where the
 *  user's own browser UA differs from this one. */
export const USER_AGENT =
  process.env.STUDIO_LEETCODE_UA ||
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const QUESTION_ID_QUERY =
  'query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId questionFrontendId } }';

export const POLL_FIRST_DELAY_MS = 1000;
export const POLL_INTERVAL_MS = 1000;
export const POLL_CEILING_MS = 60000;

/** Every failure this module produces. `status` and `code` map straight onto the contract's
 *  error envelope; `message` is user-facing English and never contains a credential. */
export class JudgeError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'JudgeError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

const sessionExpired = (detail) =>
  new JudgeError(
    401,
    'SESSION_EXPIRED',
    `Your LeetCode session cookie is no longer valid${detail ? ` (${detail})` : ''}. ` +
      'Open leetcode.com in your browser, copy LEETCODE_SESSION, csrftoken and cf_clearance again, ' +
      'and re-paste them into Studio. Nothing was submitted.',
  );

const unreachable = (detail) =>
  new JudgeError(
    503,
    'JUDGE_UNREACHABLE',
    `LeetCode's judge could not be reached${detail ? `: ${detail}` : '.'} Nothing was submitted. ` +
      'Try again in a few minutes — Studio will not retry on its own.',
    // Kept so that the same failure can be re-worded once a submission DOES exist, without
    // doing surgery on the sentence above.
    { detail: detail ?? null },
  );

/**
 * The same network failure, told truthfully after the POST has gone through.
 *
 * Every error above ends in "Nothing was submitted". Once `postSubmission` has returned an
 * id that is false, and it is the most expensive kind of false there is: the panel offers
 * "Submit again", and the user sends a second submission for work LeetCode already has.
 */
function afterSubmit(err, submissionId) {
  if (!(err instanceof JudgeError)) return err;
  if (err.submissionId !== undefined) return err;   // already says which submission it is
  const why = err.detail ? ` (${err.detail})` : '';
  return new JudgeError(
    err.status,
    err.code,
    `Your submission went through and is being judged — Studio just could not read the verdict ` +
      `back${why}. Submission ${submissionId} is real: ${submissionUrl(submissionId)}. ` +
      'Open it on LeetCode to see the result. Do not submit again — Studio will not either.',
    { submissionId, submissionUrl: submissionUrl(submissionId) },
  );
}

const rateLimited = () =>
  new JudgeError(
    429,
    'RATE_LIMITED',
    'LeetCode is rate-limiting this client. Wait a few minutes before submitting again. ' +
      'Studio will never resubmit automatically.',
  );

function headerOf(res, name) {
  const value = res?.headers?.get?.(name);
  return typeof value === 'string' ? value : null;
}

function isJsonResponse(res) {
  return String(headerOf(res, 'content-type') ?? '').toLowerCase().includes('json');
}

function looksLikeLoginRedirect(res) {
  const location = headerOf(res, 'location') ?? '';
  return location.includes('/accounts/login');
}

/**
 * Turn a non-JSON or non-OK response into the right JudgeError.
 * Returns null when the response is a JSON 200 and should simply be parsed.
 *
 * The order matters. HTML is the tell that we were signed out or challenged — never a
 * parse error. A challenge (cf-mitigated / 403 HTML with Cloudflare's markers) is a
 * different user story from an expired cookie, and the two get different messages.
 */
export function classifyResponse(res, bodyText) {
  const status = res?.status ?? 0;
  const mitigated = headerOf(res, 'cf-mitigated');
  const json = isJsonResponse(res);

  if (status === 429) return rateLimited();

  if (status >= 300 && status < 400 && looksLikeLoginRedirect(res)) {
    return sessionExpired('LeetCode redirected to the login page');
  }

  if (!json) {
    // Cloudflare interstitials and login pages are HTML. Never JSON.parse this.
    const text = typeof bodyText === 'string' ? bodyText : '';
    const challenge =
      mitigated === 'challenge' ||
      /cf-browser-verification|Just a moment|Attention Required|cdn-cgi\/challenge/i.test(text);
    if (challenge) {
      return unreachable(
        'Cloudflare answered with a browser challenge instead of the judge. ' +
          'This usually means the stored cf_clearance cookie has expired or was taken with a different browser',
      );
    }
    if (status === 401 || status === 403 || status === 302) {
      return sessionExpired('LeetCode returned a sign-in page instead of an answer');
    }
    return unreachable(`LeetCode returned a web page instead of data (HTTP ${status})`);
  }

  if (status === 401 || status === 403) {
    const text = typeof bodyText === 'string' ? bodyText : '';
    if (/csrf/i.test(text)) {
      return new JudgeError(
        401,
        'SESSION_EXPIRED',
        'LeetCode rejected the request as a CSRF failure. The stored csrftoken no longer matches ' +
          'the session cookie — re-paste both from your browser. Nothing was submitted.',
      );
    }
    return sessionExpired('LeetCode refused the request as unauthenticated');
  }

  if (status < 200 || status >= 300) {
    return unreachable(`LeetCode returned HTTP ${status}`);
  }

  return null;
}

/** Read a response once, safely, and classify it. Returns { error } or { json }. */
async function readJson(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    text = '';
  }
  const error = classifyResponse(res, text);
  if (error) return { error };
  try {
    return { json: JSON.parse(text) };
  } catch {
    return { error: unreachable('LeetCode sent a response that could not be read as JSON') };
  }
}

/** Headers shared by every authenticated call. Same UA everywhere, always. */
function authHeaders(credentials, slug) {
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'user-agent': USER_AGENT,
    origin: BASE,
    referer: `${BASE}/problems/${slug}/`,
    'x-csrftoken': credentials.csrf ?? '',
    'x-requested-with': 'XMLHttpRequest',
    cookie: credentials.cookieHeader(),
  };
}

async function doFetch(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    // Message is ours, not the platform's — a fetch error can carry the request URL but
    // never the headers, and we do not want to find out the hard way.
    throw unreachable(err?.name === 'AbortError' ? 'the request timed out' : 'the network request failed');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The INTERNAL question id. Cached per slug for the life of the process, because it is
 * immutable and because a wrong id is invisible on two-sum (internal 1 === displayed 1).
 */
export class QuestionIdCache {
  constructor({ fetchImpl = fetch, leetcode = null } = {}) {
    this.fetchImpl = fetchImpl;
    this.leetcode = leetcode;
    this.byslug = new Map();
  }

  async get(slug) {
    const cached = this.byslug.get(slug);
    if (cached) return cached;

    // Cache-first: the Phase 1 content cache already holds the raw GraphQL question, so
    // the common path costs no network at all.
    if (this.leetcode?.getContent) {
      try {
        const result = await this.leetcode.getContent(slug);
        const id = normaliseQuestionId(result?.question?.questionId);
        if (id) {
          this.byslug.set(slug, id);
          return id;
        }
      } catch {
        // Fall through to a direct query; an unreachable cache is not a submit failure yet.
      }
    }

    const res = await doFetch(
      this.fetchImpl,
      GRAPHQL_URL,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': USER_AGENT,
          referer: `${BASE}/problems/${slug}/`,
        },
        body: JSON.stringify({
          operationName: 'questionData',
          variables: { titleSlug: slug },
          query: QUESTION_ID_QUERY,
        }),
      },
      15000,
    );

    const { error, json } = await readJson(res);
    if (error) throw error;

    const id = normaliseQuestionId(json?.data?.question?.questionId);
    if (!id) {
      throw new JudgeError(
        404,
        'PROBLEM_NOT_FOUND',
        `LeetCode does not know a problem with the slug "${slug}", so there is nothing to submit to.`,
      );
    }
    this.byslug.set(slug, id);
    return id;
  }
}

/** questionId arrives as a string ("1"). Anything that is not a plain positive integer is
 *  refused rather than coerced — submitting against a guessed id is worse than failing. */
export function normaliseQuestionId(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return String(raw);
  if (typeof raw === 'string' && /^[0-9]+$/.test(raw.trim()) && raw.trim() !== '0') return raw.trim();
  return null;
}

/**
 * THE submission. Exactly one POST. Called once per explicit user action, never in a loop.
 * @returns {Promise<number|string>} the submission id
 */
export async function postSubmission({
  slug,
  code,
  questionId,
  credentials,
  fetchImpl = fetch,
  lang = 'python3',
  timeoutMs = 20000,
}) {
  const res = await doFetch(
    fetchImpl,
    `${BASE}/problems/${slug}/submit/`,
    {
      method: 'POST',
      headers: authHeaders(credentials, slug),
      body: JSON.stringify({
        lang,
        question_id: questionId,
        test_mode: false,
        typed_code: code,
        judge_type: 'large',
      }),
    },
    timeoutMs,
  );

  const { error, json } = await readJson(res);
  if (error) throw error;

  const id = json?.submission_id;
  if (id === undefined || id === null || id === '') {
    // The POST was accepted but we have no handle on it. Do NOT resubmit to "fix" this —
    // that would be a second submission the user never asked for.
    throw unreachable('LeetCode accepted the submission but did not return a submission id');
  }
  return id;
}

export function submissionUrl(id) {
  return `${BASE}/submissions/detail/${id}/`;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `/check/` until `state === "SUCCESS"`. Sane interval, hard ceiling.
 *
 * A submission that never finishes is an honest timeout naming the submission id and
 * linking to it — not an infinite spinner, and emphatically not a resubmission.
 */
export async function pollSubmission({
  submissionId,
  slug,
  credentials,
  fetchImpl = fetch,
  sleep = defaultSleep,
  now = () => Date.now(),
  firstDelayMs = POLL_FIRST_DELAY_MS,
  intervalMs = POLL_INTERVAL_MS,
  ceilingMs = POLL_CEILING_MS,
}) {
  const startedAt = now();
  const url = `${BASE}/submissions/detail/${submissionId}/check/`;
  let polls = 0;

  await sleep(firstDelayMs);

  for (;;) {
    polls += 1;
    let res;
    try {
      res = await doFetch(
        fetchImpl,
        url,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            'user-agent': USER_AGENT,
            referer: `${BASE}/problems/${slug}/`,
            'x-csrftoken': credentials.csrf ?? '',
            'x-requested-with': 'XMLHttpRequest',
            cookie: credentials.cookieHeader(),
          },
        },
        20000,
      );
    } catch (err) {
      throw afterSubmit(err, submissionId);
    }

    const { error, json } = await readJson(res);
    if (error) throw afterSubmit(error, submissionId);

    const state = json?.state;
    if (state === 'SUCCESS') return { check: json, polls };
    if (state === 'FAILURE') {
      throw new JudgeError(
        503,
        'JUDGE_UNREACHABLE',
        "LeetCode's judge reported an internal failure for this submission rather than a verdict. " +
          `The submission itself exists: ${submissionUrl(submissionId)}`,
        { submissionId, submissionUrl: submissionUrl(submissionId) },
      );
    }

    if (now() - startedAt >= ceilingMs) {
      throw new JudgeError(
        504,
        'JUDGE_TIMEOUT',
        `The submission went through but LeetCode's judge had not finished after ${Math.round(ceilingMs / 1000)} seconds. ` +
          `Submission ${submissionId} is real — check it at ${submissionUrl(submissionId)}. ` +
          'Studio will not resubmit.',
        { submissionId, submissionUrl: submissionUrl(submissionId) },
      );
    }

    await sleep(intervalMs);
  }
}
