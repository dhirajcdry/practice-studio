// LeetCode content fetch + a permanent local cache.
//
// Rules that come straight from the measured findings in docs/LEETCODE-API.md:
//
//  * Lazy-fetch on first open. Cache forever in ~/LeetCodeTutor/cache/leetcode/<slug>.json.
//    Statements do not change, and a bulk pre-fetch is the one behaviour that would
//    plausibly trip Cloudflare. There is deliberately no "fetch all" function in this file.
//  * Premium returns HTTP 200 with isPaidOnly:true, content:null, codeSnippets:null and NO
//    errors array. That is a successful, cacheable answer — not a failure.
//  * Auth/challenge failures arrive as HTML, not JSON. Check content-type before parsing,
//    or an expired cookie surfaces as a mystery parse error.
//  * A LeetCode failure must never crash the process or block the rest of the app.

import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const GRAPHQL_URL = 'https://leetcode.com/graphql/';

// [VERIFIED 2026-07-25] — copied verbatim from docs/LEETCODE-API.md §1.2. Do not "tidy".
const QUESTION_QUERY =
  'query questionData($titleSlug: String!) { question(titleSlug: $titleSlug) { questionId questionFrontendId title titleSlug content difficulty isPaidOnly likes dislikes categoryTitle stats hints exampleTestcases sampleTestCase metaData topicTags { name slug } codeSnippets { lang langSlug code } } }';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class LeetCodeError extends Error {
  constructor(message, { kind = 'unreachable', cause } = {}) {
    super(message);
    this.kind = kind;
    this.cause = cause;
  }
}

/** One anonymous GraphQL call. Throws LeetCodeError with a plain-English message. */
export async function fetchQuestion(slug, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': USER_AGENT,
        referer: `https://leetcode.com/problems/${slug}/`,
      },
      body: JSON.stringify({
        operationName: 'questionData',
        variables: { titleSlug: slug },
        query: QUESTION_QUERY,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new LeetCodeError(
      'Could not reach LeetCode. Check your network connection.',
      { kind: 'network', cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  const contentType = String(res.headers?.get?.('content-type') ?? '');
  const isJson = contentType.toLowerCase().includes('json');
  const mitigated = res.headers?.get?.('cf-mitigated');

  if (!isJson) {
    // Almost always a Cloudflare interstitial or a login redirect. Never JSON.parse this.
    if (res.status === 403 || mitigated) {
      throw new LeetCodeError(
        'LeetCode blocked this request with a browser challenge instead of answering. Try again in a few minutes.',
        { kind: 'challenged' },
      );
    }
    throw new LeetCodeError(
      `LeetCode returned a web page instead of data (HTTP ${res.status}). It may be down or blocking this client.`,
      { kind: 'not-json' },
    );
  }

  if (res.status === 429) {
    throw new LeetCodeError('LeetCode is rate-limiting this client. Wait a minute and try again.', {
      kind: 'rate-limited',
    });
  }

  let body;
  try {
    body = await res.json();
  } catch (err) {
    throw new LeetCodeError('LeetCode sent a response that could not be read.', {
      kind: 'not-json',
      cause: err,
    });
  }

  if (!res.ok) {
    throw new LeetCodeError(`LeetCode returned an error (HTTP ${res.status}).`, {
      kind: 'http-error',
    });
  }

  if (Array.isArray(body?.errors) && body.errors.length > 0) {
    const first = body.errors[0]?.message;
    throw new LeetCodeError(
      typeof first === 'string' && first
        ? `LeetCode rejected the request: ${first}`
        : 'LeetCode rejected the request.',
      { kind: 'graphql-error' },
    );
  }

  const question = body?.data?.question ?? null;
  if (question === null || question === undefined) {
    // A valid request for a slug LeetCode does not know.
    throw new LeetCodeError(`LeetCode has no problem with the slug "${slug}".`, {
      kind: 'unknown-slug',
    });
  }

  return question;
}

/**
 * Shape the raw GraphQL question into the contract's `content` object.
 * Everything is null-checked: premium problems arrive with half the fields null.
 */
/** metaData arrives as a JSON string. Junk must degrade to null, never throw. */
function parseMetaDataSafely(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function toContent(question, { fetchedAt, stale = false }) {
  const tags = Array.isArray(question?.topicTags) ? question.topicTags : [];
  return {
    title: question?.title ?? null,
    difficulty: question?.difficulty ?? null,
    descriptionHtml: question?.content ?? null,
    topicTags: tags.map((t) => t?.name).filter((n) => typeof n === 'string'),
    exampleTestcases: question?.exampleTestcases ?? null,
    // The local runner cannot generate a driver without metaData, and the editor cannot
    // offer a starting stub without codeSnippets. Both were always fetched; they were
    // simply not surfaced. Premium returns null for codeSnippets — do not assume an array.
    metaData: parseMetaDataSafely(question?.metaData),
    codeSnippets: Array.isArray(question?.codeSnippets) ? question.codeSnippets : null,
    isPaidOnly: question?.isPaidOnly === true,
    fetchedAt: fetchedAt ?? null,
    stale: stale === true,
  };
}

export class LeetCodeContentCache {
  constructor({ cacheDir, fetchImpl = fetch, fetchQuestionImpl = fetchQuestion } = {}) {
    this.cacheDir = cacheDir;
    this.fetchImpl = fetchImpl;
    this.fetchQuestionImpl = fetchQuestionImpl;
    this.inFlight = new Map();
  }

  cacheFile(slug) {
    return path.join(this.cacheDir, `${slug}.json`);
  }

  async readCache(slug) {
    let text;
    try {
      text = await fsp.readFile(this.cacheFile(slug), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || !parsed.question) return null;
      return parsed;
    } catch {
      // A truncated or hand-mangled cache file is treated as a miss, never a crash.
      return null;
    }
  }

  /** temp file + rename, so a crash mid-write can never leave a half-written cache entry. */
  async writeCache(slug, record) {
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const finalPath = this.cacheFile(slug);
    const tmpPath = `${finalPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fsp.writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8');
    try {
      await fsp.rename(tmpPath, finalPath);
    } catch (err) {
      await fsp.rm(tmpPath, { force: true }).catch(() => {});
      throw err;
    }
  }

  /**
   * Cache-first. On a hit, no network happens at all.
   * On a miss: fetch, cache, return. If the fetch fails and a cache entry exists, the
   * cached copy is served with stale:true. If neither, the LeetCodeError propagates and
   * the route turns it into a 503 — the rest of the app keeps working.
   */
  async getContent(slug) {
    const existing = this.inFlight.get(slug);
    if (existing) return existing;

    const work = this._getContent(slug).finally(() => this.inFlight.delete(slug));
    this.inFlight.set(slug, work);
    return work;
  }

  async _getContent(slug) {
    const cached = await this.readCache(slug);
    if (cached && cached.complete !== false) {
      return {
        content: toContent(cached.question, { fetchedAt: cached.fetchedAt ?? null, stale: false }),
        question: cached.question,
        fromCache: true,
      };
    }

    let question;
    try {
      question = await this.fetchQuestionImpl(slug, { fetchImpl: this.fetchImpl });
    } catch (err) {
      if (cached) {
        return {
          content: toContent(cached.question, {
            fetchedAt: cached.fetchedAt ?? null,
            stale: true,
          }),
          question: cached.question,
          fromCache: true,
          stale: true,
          error: err,
        };
      }
      throw err;
    }

    const fetchedAt = new Date().toISOString();
    const record = { slug, fetchedAt, complete: true, question };
    try {
      await this.writeCache(slug, record);
    } catch {
      // An unwritable cache is a nuisance, not a failure. Serve what we fetched.
    }

    return {
      content: toContent(question, { fetchedAt, stale: false }),
      question,
      fromCache: false,
    };
  }
}
