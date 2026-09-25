// HTTP client for the Studio API (docs/API-CONTRACT.md) with a bundled offline
// fallback. Every call resolves to a tagged result object — never a rejected
// promise, never an indefinite wait — so the UI can always render something true.
//
//   { ok:true,  ...payload, source:'live'|'mock' }
//   { ok:false, kind:'missing'|'premium'|'offline'|'timeout'|'server', message, code }

const REQUEST_TIMEOUT_MS = 8000;
const BOOT_TIMEOUT_MS = 3500;

export const flags = new URLSearchParams(location.search);
/** Dev switch for exercising the honest states without a server: ?sim=premium|stale|error|slow */
export const simulate = flags.get('sim') || '';

export const api = {
  mode: 'boot',        // 'live' once the server answers, 'mock' otherwise
  reason: '',          // plain-English explanation shown in the banner
  health: null,
};

async function fetchJson(path, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, { signal: controller.signal, headers: { accept: 'application/json' } });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!response.ok) {
      const err = data && data.error ? data.error : null;
      return {
        ok: false,
        kind: response.status === 404 ? 'missing' : 'server',
        code: err?.code || `HTTP_${response.status}`,
        message: err?.message || `The server answered ${response.status} for ${path}.`,
      };
    }
    if (!data) return { ok: false, kind: 'server', code: 'BAD_JSON', message: 'The server sent a response that was not valid JSON.' };
    return { ok: true, data };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      kind: timedOut ? 'timeout' : 'offline',
      code: timedOut ? 'TIMEOUT' : 'UNREACHABLE',
      message: timedOut
        ? `The server took longer than ${Math.round(timeoutMs / 1000)}s to answer.`
        : 'The studio server is not answering on this address.',
    };
  }
}

/* --------------------------------------------------------------------------
   mock data — bundled, so the page is fully usable with the network down
   -------------------------------------------------------------------------- */

let mockBundle = null;
let mockSamples = null;

async function loadMockBundle() {
  if (!mockBundle) {
    const result = await fetchJson('./mock/problems.json');
    if (!result.ok) throw new Error('bundled mock data is missing');
    mockBundle = result.data;
  }
  return mockBundle;
}

async function loadMockSamples() {
  if (!mockSamples) {
    const result = await fetchJson('./mock/samples.json');
    mockSamples = result.ok ? result.data : { license: null, solutions: {}, articles: {} };
  }
  return mockSamples;
}

const MOCK_LICENSE = {
  notice: 'Solutions from neetcode-gh/leetcode, MIT licensed, Copyright (c) 2022 neetcode-gh.',
  copyright: 'Copyright (c) 2022 neetcode-gh',
};

/** Known LeetCode-premium slugs, so offline mode reproduces the real premium state. */
const MOCK_PREMIUM_SLUGS = new Set([
  'meeting-rooms', 'meeting-rooms-ii', 'graph-valid-tree', 'number-of-connected-components-in-an-undirected-graph',
  'alien-dictionary', 'encode-and-decode-strings', 'design-in-memory-file-system', 'binary-tree-vertical-order-traversal',
]);

/** A description that is obviously a placeholder — it must never read as the real one. */
function mockDescription(entry) {
  return [
    '<p><strong>Sample description.</strong> The real LeetCode statement is fetched by the studio ',
    'server the first time you open a problem; it is not bundled with the page. Everything else on ',
    'this screen is real catalog data.</p>',
    `<p>This is <em>${entry.title}</em> — problem ${entry.number}, ${entry.difficulty}, `,
    `filed under the <code>${entry.pattern}</code> pattern.</p>`,
    '<p><strong>Example 1:</strong></p>',
    '<pre>Input: nums = [2,7,11,15], target = 9\nOutput: [0,1]\nExplanation: nums[0] + nums[1] == 9.</pre>',
    '<p><strong>Constraints:</strong></p>',
    '<ul><li><code>2 &lt;= nums.length &lt;= 10<sup>4</sup></code></li>',
    '<li><code>-10<sup>9</sup> &lt;= nums[i] &lt;= 10<sup>9</sup></code></li></ul>',
  ].join('');
}

/* --------------------------------------------------------------------------
   public API
   -------------------------------------------------------------------------- */

/** Boot: health check + the full problem list. Falls back to mocks, honestly. */
export async function loadCatalog() {
  if (flags.get('mock') === '1') {
    api.mode = 'mock';
    api.reason = 'Mock mode was requested with ?mock=1 in the URL.';
    return await loadMockBundle();
  }

  const health = await fetchJson('/api/health', BOOT_TIMEOUT_MS);
  const list = health.ok ? await fetchJson('/api/problems', BOOT_TIMEOUT_MS) : health;

  if (list.ok && Array.isArray(list.data?.problems) && list.data.problems.length) {
    api.mode = 'live';
    api.health = health.ok ? health.data : null;
    return list.data;
  }

  api.mode = 'mock';
  api.reason = list.kind === 'timeout'
    ? 'The studio server did not answer in time, so this page is showing bundled sample data.'
    : 'The studio server is not running, so this page is showing bundled sample data.';
  return await loadMockBundle();
}

/** GET /api/problems/:slug — catalog entry plus live LeetCode content. */
export async function loadProblem(slug, entry) {
  if (api.mode === 'live') {
    const result = await fetchJson(`/api/problems/${encodeURIComponent(slug)}`);
    if (result.ok) return { ok: true, source: 'live', ...result.data };
    return { ...result, source: 'live' };
  }

  await new Promise(r => setTimeout(r, simulate === 'slow' ? 1400 : 90)); // feel of a real fetch
  if (simulate === 'error') {
    return {
      ok: false, source: 'mock', kind: 'offline', code: 'LEETCODE_UNREACHABLE',
      message: 'The description could not be loaded — LeetCode was unreachable and nothing is cached yet.',
    };
  }
  // Only `content.isPaidOnly` marks a LeetCode-premium problem. `catalog.isPro` is
  // NeetCode-pro — a different thing — and is deliberately not consulted here.
  const premium = simulate === 'premium' || MOCK_PREMIUM_SLUGS.has(slug);
  return {
    ok: true,
    source: 'mock',
    slug,
    catalog: entry || null,
    content: {
      title: entry?.title || slug,
      difficulty: entry?.difficulty || 'Medium',
      // Premium: descriptionHtml is null but the rest of `content` is still real.
      descriptionHtml: premium ? null : mockDescription(entry || { title: slug, number: 0, difficulty: 'Medium', pattern: '—' }),
      topicTags: ['Array', 'Hash Table'],
      exampleTestcases: '[2,7,11,15]\n9',
      isPaidOnly: premium,
      fetchedAt: new Date().toISOString(),
      stale: simulate === 'stale',
    },
    solution: { available: !!entry?.hasPythonSolution, language: 'python' },
    article: { available: !!entry?.hasArticle },
  };
}

/** GET /api/problems/:slug/solution */
export async function loadSolution(slug, entry) {
  if (api.mode === 'live') {
    const result = await fetchJson(`/api/problems/${encodeURIComponent(slug)}/solution`);
    if (result.ok) return { ok: true, source: 'live', ...result.data };
    return { ...result, source: 'live' };
  }
  const samples = await loadMockSamples();
  if (entry && entry.hasPythonSolution === false) {
    return {
      ok: false, source: 'mock', kind: 'missing', code: 'SOLUTION_NOT_AVAILABLE',
      message: 'There is no Python reference solution for this problem in the NeetCode bundle.',
    };
  }
  const hit = samples.solutions?.[slug];
  if (hit) return { ok: true, source: 'mock', language: 'python', ...hit, license: samples.license || MOCK_LICENSE };
  return {
    ok: false, source: 'mock', kind: 'offline', code: 'MOCK_NO_SAMPLE',
    message: 'Reference solutions are read from the local NeetCode bundle by the studio server, which is not running. A handful are bundled with this page as samples.',
  };
}

/** GET /api/problems/:slug/article */
export async function loadArticle(slug, entry) {
  if (api.mode === 'live') {
    const result = await fetchJson(`/api/problems/${encodeURIComponent(slug)}/article`);
    if (result.ok) return { ok: true, source: 'live', ...result.data };
    return { ...result, source: 'live' };
  }
  const samples = await loadMockSamples();
  if (entry && entry.hasArticle === false) {
    return {
      ok: false, source: 'mock', kind: 'missing', code: 'ARTICLE_NOT_AVAILABLE',
      message: 'There is no written article for this problem in the NeetCode bundle.',
    };
  }
  const hit = samples.articles?.[slug];
  if (hit) return { ok: true, source: 'mock', ...hit, license: samples.license || MOCK_LICENSE };
  return {
    ok: false, source: 'mock', kind: 'offline', code: 'MOCK_NO_SAMPLE',
    message: 'Articles are read from the local NeetCode bundle by the studio server, which is not running. A handful are bundled with this page as samples.',
  };
}

/* ==========================================================================
   Phase 2 — the working buffer and local execution (docs/API-CONTRACT-P2.md)

   Same discipline as above: every call resolves to a tagged object, never a
   rejection and never an open-ended wait. The endpoints below are new, so a
   server that predates them answers 404/405 — that is reported as its own
   honest state ("this server cannot run code yet"), not as a failure of the
   user's code.
   ========================================================================== */

const RUN_TIMEOUT_MS = 30000;
const SAVE_TIMEOUT_MS = 6000;

/** Dev switch for the run states without a runner: ?simrun=pass|order|fail|runtime|timeout|compile|unsupported|empty */
export const simulateRun = flags.get('simrun') || '';

/** fetchJson's sibling, with a method, a body and a caller-supplied abort signal. */
async function sendJson(path, { method = 'GET', body = null, timeoutMs = REQUEST_TIMEOUT_MS, signal = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }
  try {
    const response = await fetch(path, {
      method,
      signal: controller.signal,
      headers: body === null
        ? { accept: 'application/json' }
        : { accept: 'application/json', 'content-type': 'application/json' },
      body: body === null ? undefined : JSON.stringify(body),
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON body */ }
    if (!response.ok) {
      const err = data && data.error ? data.error : null;
      // 404/405 from a server that simply has not shipped this route yet.
      const missingRoute = response.status === 404 || response.status === 405 || response.status === 501;
      return {
        ok: false,
        kind: missingRoute ? 'unavailable' : 'server',
        code: err?.code || `HTTP_${response.status}`,
        message: missingRoute
          ? 'This studio server does not have that endpoint yet. It is running an older build than this page.'
          : (err?.message || `The server answered ${response.status} for ${path}.`),
        // The failure envelope itself, kept rather than dropped: some errors carry
        // payload that still matters (a submission id behind a judge timeout).
        data,
      };
    }
    if (!data) return { ok: false, kind: 'server', code: 'BAD_JSON', message: 'The server sent a response that was not valid JSON.' };
    return { ok: true, data };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    const byCaller = aborted && signal && signal.aborted;
    return {
      ok: false,
      kind: byCaller ? 'cancelled' : (aborted ? 'timeout' : 'offline'),
      code: byCaller ? 'CANCELLED' : (aborted ? 'TIMEOUT' : 'UNREACHABLE'),
      message: byCaller
        ? 'The request was stopped before it finished.'
        : (aborted
          ? `The server took longer than ${Math.round(timeoutMs / 1000)}s to answer.`
          : 'The studio server is not answering on this address.'),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

/* ------------------------- offline buffer ------------------------- */

const DRAFT_PREFIX = 'studio.code.v1.';

/** The browser-local mirror of the working buffer. It exists so that a server
 *  that is down, old, or mid-restart can never cost the user a line of code. */
export function readDraft(slug) {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + slug);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed?.code !== 'string') return null;
    return { code: parsed.code, savedAt: parsed.savedAt || null, syncedAt: parsed.syncedAt || null };
  } catch { return null; }
}

export function writeDraft(slug, code, { synced = false } = {}) {
  try {
    const now = new Date().toISOString();
    const previous = readDraft(slug);
    localStorage.setItem(DRAFT_PREFIX + slug, JSON.stringify({
      code,
      savedAt: now,
      syncedAt: synced ? now : (previous?.syncedAt || null),
    }));
  } catch { /* private browsing — the editor still works, it just cannot remember */ }
}

export function clearDraft(slug) {
  try { localStorage.removeItem(DRAFT_PREFIX + slug); } catch { /* noop */ }
}

/** A last-resort starting point when no server and no draft can supply one. */
export function fallbackStub(slug, entry) {
  const method = String(slug || 'solve')
    .split('-')
    .filter(Boolean)
    .map((word, i) => (i === 0 ? word : word[0].toUpperCase() + word.slice(1)))
    .join('') || 'solve';
  return [
    '# ' + (entry?.title || slug || 'Problem'),
    '# The studio server normally fills this in with LeetCode\'s own stub,',
    '# including the real signature. It is not answering, so this is a shell.',
    '',
    'class Solution:',
    `    def ${method}(self):`,
    '        pass',
    '',
  ].join('\n');
}

/** GET /api/problems/:slug/code — the working buffer, or LeetCode's stub. */
export async function loadCode(slug, entry) {
  if (api.mode === 'live') {
    const result = await sendJson(`/api/problems/${encodeURIComponent(slug)}/code`);
    if (result.ok) {
      const data = result.data || {};
      return {
        ok: true,
        source: 'live',
        code: typeof data.code === 'string' && data.code !== '' ? data.code : fallbackStub(slug, entry),
        language: data.language || 'python',
        updatedAt: data.updatedAt || null,
        isStub: data.isStub === true,
        // LeetCode's starter, sent whether or not there is a buffer — it is what Reset
        // puts back, and Reset only matters once there IS a buffer.
        stub: typeof data.stub === 'string' && data.stub !== '' ? data.stub : null,
      };
    }
    return { ...result, source: 'live' };
  }
  const draft = readDraft(slug);
  const stub = fallbackStub(slug, entry);
  if (draft) return { ok: true, source: 'mock', code: draft.code, language: 'python', updatedAt: draft.savedAt, isStub: false, stub };
  return { ok: true, source: 'mock', code: stub, language: 'python', updatedAt: null, isStub: true, stub };
}

/** PUT /api/problems/:slug/code — the ONLY path that writes the user's file. */
export async function saveCode(slug, code) {
  if (api.mode !== 'live') {
    writeDraft(slug, code);
    return {
      ok: false, source: 'mock', kind: 'unavailable', code: 'NO_SERVER',
      message: 'Kept in this browser only — the studio server is not running, so nothing was written to disk.',
    };
  }
  const result = await sendJson(`/api/problems/${encodeURIComponent(slug)}/code`, {
    method: 'PUT', body: { code }, timeoutMs: SAVE_TIMEOUT_MS,
  });
  if (result.ok) {
    writeDraft(slug, code, { synced: true });
    return { ok: true, source: 'live', updatedAt: result.data?.updatedAt || new Date().toISOString() };
  }
  writeDraft(slug, code);
  return { ...result, source: 'live' };
}

/* ------------------------------- running ------------------------------- */

const SIM_CASE = {
  index: 0, input: '[2,7,11,15]\n9', expected: '[0,1]', actual: '[0,1]', stdout: '', passed: true, ms: 12,
};

/** Canned responses for ?simrun= — development and screenshots only. */
function simulatedRun(kind) {
  const cases = [
    { ...SIM_CASE },
    { index: 1, input: '[3,2,4]\n6', expected: '[1,2]', actual: '[1,2]', stdout: 'scanning 3 items\n', passed: true, ms: 9 },
    { index: 2, input: '[3,3]\n6', expected: '[0,1]', actual: '[0,1]', stdout: '', passed: true, ms: 7 },
  ];
  switch (kind) {
    case 'pass':
      return { ok: true, cases, summary: { passed: 3, total: 3, totalMs: 28 }, error: null };
    case 'order':
      return {
        ok: true,
        cases: cases.map((c, i) => (i === 1 ? { ...c, actual: '[2,1]', orderInsensitive: true } : c)),
        summary: { passed: 3, total: 3, totalMs: 31 }, error: null,
      };
    case 'fail':
      return {
        ok: true,
        cases: [cases[0], { ...cases[1], actual: '[0,2]', passed: false }, cases[2]],
        summary: { passed: 2, total: 3, totalMs: 26 }, error: null,
      };
    case 'runtime':
      return {
        ok: true,
        cases: [
          cases[0],
          { index: 1, input: '[3,2,4]\n6', expected: '[1,2]', actual: '', stdout: '', passed: false, ms: 4,
            error: { kind: 'runtime', message: "IndexError: list index out of range",
              traceback: 'Traceback (most recent call last):\n  File "solution.py", line 7, in twoSum\n    return [seen[need], i]\n            ~~~~^^^^^^\nIndexError: list index out of range' } },
          cases[2],
        ],
        summary: { passed: 2, total: 3, totalMs: 23 }, error: null,
      };
    case 'timeout':
      return {
        ok: true,
        cases: [
          cases[0],
          { index: 1, input: '[3,2,4]\n6', expected: '[1,2]', actual: '', stdout: '', passed: false, ms: 5000,
            error: { kind: 'timeout', message: 'Case 2 was still running after 5 seconds.' } },
          cases[2],
        ],
        summary: { passed: 2, total: 3, totalMs: 5019 }, error: null,
      };
    case 'compile':
      return {
        ok: false, cases: [],
        error: { kind: 'compile', message: "IndentationError: expected an indented block after function definition on line 2",
          traceback: '  File "solution.py", line 3\n    return []\n    ^\nIndentationError: expected an indented block after function definition on line 2' },
      };
    case 'unsupported':
      return {
        ok: false, cases: [],
        error: { kind: 'unsupported', message: 'This is a design problem — it needs a constructor plus a sequence of method calls, and the local runner cannot build that driver yet.' },
      };
    case 'empty':
      return { ok: true, cases: [], summary: { passed: 0, total: 0, totalMs: 0 }, error: null };
    default:
      return { ok: true, cases, summary: { passed: 3, total: 3, totalMs: 28 }, error: null };
  }
}

/** POST /api/run. `testcases` is omitted so the server uses exampleTestcases. */
/** Everything this problem remembers: submissions with their code, and past chats. */
export async function loadHistory(slug) {
  if (api.mode !== 'live') return { ok: false, submissions: [], threads: [] };
  const result = await fetchJson(`/api/problems/${encodeURIComponent(slug)}/history`);
  if (!result.ok) return { ok: false, submissions: [], threads: [] };
  return {
    ok: true,
    submissions: Array.isArray(result.data?.submissions) ? result.data.submissions : [],
    threads: Array.isArray(result.data?.threads) ? result.data.threads : [],
  };
}

/** The cases a local run will use, fetched without running anything. */
export async function loadTestcases(slug) {
  if (api.mode !== 'live') return { ok: false, reason: 'The studio server is not answering.' };
  const result = await fetchJson(`/api/problems/${encodeURIComponent(slug)}/testcases`);
  if (!result.ok) return { ok: false, reason: 'The example cases could not be loaded.' };
  const cases = Array.isArray(result.data?.cases) ? result.data.cases : [];
  return {
    ok: true,
    cases,
    // The ones you added — kept separate from the examples, which are LeetCode's and
    // are not ours to edit.
    extra: Array.isArray(result.data?.extra) ? result.data.extra : [],
    params: Array.isArray(result.data?.params) ? result.data.params : [],
    perCase: Number(result.data?.perCase) || null,
    // Whether the local runner can drive this problem at all. False means `reason` is the
    // whole story and there is nothing to add a case to.
    runnable: result.data?.runnable !== false,
    reason: result.data?.reason ?? null,
  };
}

/** PUT the cases you added. Whole-list replacement; the examples are untouched. */
export async function saveTestcases(slug, cases) {
  if (api.mode !== 'live') return { ok: false, message: 'The studio server is not answering.' };
  const result = await sendJson(`/api/problems/${encodeURIComponent(slug)}/testcases`, {
    method: 'PUT', body: { cases }, timeoutMs: 8000,
  });
  if (result.ok) return { ok: true, cases: result.data?.cases ?? [] };
  return { ok: false, message: result.message || 'Those cases could not be saved.' };
}

export async function runCode(slug, code, signal, { testcases = null, expected = null } = {}) {
  if (simulateRun) {
    await new Promise(r => setTimeout(r, 650));
    return { ...simulatedRun(simulateRun), source: 'mock' };
  }
  if (api.mode !== 'live') {
    return {
      ok: false, source: 'mock', kind: 'offline', code: 'NO_SERVER',
      message: 'Nothing was executed. Local run needs the studio server, which is not answering — your code is untouched.',
    };
  }
  const body = { slug, code };
  // Absent means "the examples", which is what the server defaults to. Sent only when
  // the panel is running a list it assembled, so a plain run stays a plain run.
  if (typeof testcases === 'string' && testcases.trim() !== '') {
    body.testcases = testcases;
    if (Array.isArray(expected)) body.expected = expected;
  }
  const result = await sendJson('/api/run', { method: 'POST', body, timeoutMs: RUN_TIMEOUT_MS, signal });
  if (result.ok) return { ...result.data, source: 'live' };
  return { ...result, source: 'live' };
}

/** POST /api/run/cancel — best effort. A server without it changes nothing here. */
export function cancelRun(slug) {
  if (api.mode !== 'live') return;
  sendJson('/api/run/cancel', { method: 'POST', body: { slug }, timeoutMs: 2000 }).catch(() => {});
}

/* ==========================================================================
   Phase 4 — the judge (docs/API-CONTRACT-P2.md)

   Submit is the only call in this file that leaves the machine, and the only
   one with a cost attached: every press is a real submission on a real account.
   So it is exactly as literal as the rest — one request per call, no retry
   anywhere in here, no cancel endpoint (LeetCode judges what it was sent
   whether or not anyone is listening), and the judge's own words carried
   through untouched.
   ========================================================================== */

const SUBMIT_TIMEOUT_MS = 90000;

/** Dev switch for the verdict states without a judge: ?simsubmit=
 *  accepted|wrong|tle|mle|compile|runtime|nodetail
 *  |expired|nosession|unreachable|judgetimeout|ratelimited|inflight|missing */
export const simulateSubmit = flags.get('simsubmit') || '';

/**
 * The judge's error codes, mapped onto this file's `kind` vocabulary.
 *
 * `kind` only decides the shape of the panel — the headline, whether a retry
 * button is offered, whether we link out. The words always come from the
 * server's own `error.message`, including for a code that is not in this table:
 * an unknown code falls through to `server`, which prints the message verbatim
 * rather than replacing it with something generic.
 *
 * NO_SESSION and SESSION_EXPIRED are both 401 and need different actions from
 * the user, so they are deliberately two kinds and not one.
 */
const SUBMIT_KINDS = {
  NO_SESSION: 'no_session',
  SESSION_EXPIRED: 'session_expired', HTTP_401: 'session_expired', HTTP_403: 'session_expired',
  RATE_LIMITED: 'rate_limited', HTTP_429: 'rate_limited',
  JUDGE_UNREACHABLE: 'judge_unreachable', HTTP_502: 'judge_unreachable', HTTP_503: 'judge_unreachable',
  JUDGE_TIMEOUT: 'judge_timeout', HTTP_504: 'judge_timeout',
  SUBMIT_IN_FLIGHT: 'in_flight', HTTP_409: 'in_flight',
};

const SIM_ACCEPTED = {
  ok: true, accepted: true, verdict: 'Accepted', statusCode: 10,
  passed: 64, total: 64, runtime: '3 ms', memory: '20.4 MB',
  runtimePercentile: 53.86, memoryPercentile: 58.13,
  submissionId: 2081220750, submissionUrl: 'https://leetcode.com/submissions/detail/2081220750/',
  failure: null,
};

/** Canned verdicts for ?simsubmit= — development and screenshots only. Nothing
 *  in here ever touches the network, and none of it is a real submission. */
function simulatedSubmit(kind) {
  const base = { ...SIM_ACCEPTED, accepted: false, failure: null };
  switch (kind) {
    case 'accepted':
      return { ...SIM_ACCEPTED };
    case 'wrong':
      return { ...base, verdict: 'Wrong Answer', statusCode: 11, passed: 41, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
        failure: { lastTestcase: '[3,2,4]\n6', expected: '[1,2]', actual: '[0,2]', stdout: 'scanning 3 items\n' } };
    case 'tle':
      return { ...base, verdict: 'Time Limit Exceeded', statusCode: 14, passed: 58, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
        failure: { lastTestcase: '[1,3,5,7,9,11,13,15,17,19,21,23,25,27,29,31,33,35,37,39]\n40',
          message: 'The last input your code was given before the time limit was reached.' } };
    case 'mle':
      return { ...base, verdict: 'Memory Limit Exceeded', statusCode: 12, passed: 60, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
        failure: { lastTestcase: '[2,7,11,15]\n9' } };
    case 'compile':
      return { ...base, verdict: 'Compile Error', statusCode: 20, passed: 0, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
        failure: { fullCompileError: 'Line 7: IndentationError: expected an indented block after function definition on line 6\n    return [seen[need], i]\n    ^' } };
    case 'runtime':
      return { ...base, verdict: 'Runtime Error', statusCode: 15, passed: 12, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null,
        failure: { fullRuntimeError: 'IndexError: list index out of range\n    Line 9 in twoSum (Solution.py)\n    Line 24 in _driver (Solution.py)',
          lastTestcase: '[3,3]\n6' } };
    case 'nodetail':
      return { ...base, verdict: 'Wrong Answer', statusCode: 11, passed: 41, total: 64,
        runtime: '', memory: '', runtimePercentile: null, memoryPercentile: null, failure: null };
    case 'expired':
      return { ok: false, kind: 'session_expired', code: 'SESSION_EXPIRED',
        message: 'Your LeetCode session cookie is no longer valid, so nothing was submitted.' };
    case 'nosession':
      return { ok: false, kind: 'no_session', code: 'NO_SESSION',
        message: 'No LeetCode credentials are stored on this machine, so there is nothing to submit with.' };
    case 'judgetimeout':
      return { ok: false, kind: 'judge_timeout', code: 'JUDGE_TIMEOUT',
        message: 'LeetCode accepted the submission but had not finished judging it when the server stopped polling.',
        submissionId: 2081220750, submissionUrl: 'https://leetcode.com/submissions/detail/2081220750/' };
    case 'inflight':
      return { ok: false, kind: 'in_flight', code: 'SUBMIT_IN_FLIGHT',
        message: 'A submission for this problem is already on its way to LeetCode. Nothing was sent twice.' };
    case 'unreachable':
      return { ok: false, kind: 'judge_unreachable', code: 'JUDGE_UNREACHABLE',
        message: 'LeetCode did not answer — the request was challenged by Cloudflare before it reached the judge.' };
    case 'ratelimited':
      return { ok: false, kind: 'rate_limited', code: 'RATE_LIMITED',
        message: 'LeetCode answered 429: too many submissions in a short window. Nothing was judged.' };
    case 'missing':
      return { ok: false, kind: 'unavailable', code: 'HTTP_404',
        message: 'This studio server does not have that endpoint yet. It is running an older build than this page.' };
    default:
      return { ...SIM_ACCEPTED };
  }
}

/**
 * POST /api/submit — one submission, judged by LeetCode against every hidden test.
 *
 * There is deliberately no retry, no backoff loop and no second attempt in this
 * function: it sends once, waits once, and reports whatever came back. Aborting
 * the signal stops us waiting; it does not and cannot cancel the submission.
 */
export async function submitCode(slug, code, signal) {
  if (simulateSubmit) {
    await new Promise(r => setTimeout(r, 1200));
    return { ...simulatedSubmit(simulateSubmit), source: 'mock' };
  }
  if (api.mode !== 'live') {
    return {
      ok: false, source: 'mock', kind: 'offline', code: 'NO_SERVER',
      message: 'Nothing was submitted. Submitting needs the studio server, which is not answering — it holds the LeetCode session and this page never sees it.',
    };
  }
  const result = await sendJson('/api/submit', { method: 'POST', body: { slug, code }, timeoutMs: SUBMIT_TIMEOUT_MS, signal });
  if (result.ok) return { ...result.data, source: 'live' };
  // A judge timeout still identifies the submission it gave up on, and the user
  // is entitled to that link — it is the only way left to find out what happened.
  const envelope = result.data && typeof result.data === 'object' ? result.data : {};
  const carried = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};
  return {
    ...result,
    kind: SUBMIT_KINDS[result.code] || result.kind,
    submissionId: envelope.submissionId ?? carried.submissionId ?? null,
    submissionUrl: envelope.submissionUrl ?? carried.submissionUrl ?? null,
    source: 'live',
  };
}

/* ==========================================================================
   Phase 3 & 5 — the coach, the session log, and transcription
   (docs/API-CONTRACT-P2.md)

   Same discipline as everything above: every call resolves to a tagged object,
   never a rejection. The coach is the one part of Studio that is allowed to be
   missing entirely — a server without it, or a machine without the `claude`
   binary, must cost you nothing but the coach.
   ========================================================================== */

const COACH_IDLE_TIMEOUT_MS = 120000;   // silence, not total length: a long answer is fine
const ASR_TIMEOUT_MS = 120000;
const EVENT_TIMEOUT_MS = 4000;

/**
 * Incremental Server-Sent Events decoder.
 *
 * The wire format is simple and the failure is silent, which is exactly the
 * combination that produces bugs: chunks arrive split anywhere — mid-word,
 * mid-field, between the two newlines that terminate an event — and a decoder
 * that assumes whole events per chunk drops or duplicates them. This one keeps
 * a buffer and only ever emits complete, blank-line-terminated events.
 *
 * Multi-line `data:` fields are joined with '\n', per the spec, because the
 * server splits any payload containing a newline across several data lines.
 */
export class SseDecoder {
  constructor() {
    this.buffer = '';
  }

  /**
   * @param {string} chunk any slice of the stream, including a partial event
   * @returns {Array<{event:string, data:string}>} only the events that are whole
   */
  push(chunk) {
    if (typeof chunk !== 'string' || chunk === '') return [];
    // Normalise line endings first: a CRLF split across two chunks would
    // otherwise leave a lone CR at the end of a data value.
    this.buffer += chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const out = [];
    let split;
    while ((split = this.buffer.indexOf('\n\n')) !== -1) {
      const block = this.buffer.slice(0, split);
      this.buffer = this.buffer.slice(split + 2);
      const parsed = parseSseBlock(block);
      if (parsed) out.push(parsed);
    }
    return out;
  }

  /** Anything still buffered when the stream ends. A well-formed stream ends empty. */
  flush() {
    const rest = this.buffer;
    this.buffer = '';
    const parsed = parseSseBlock(rest);
    return parsed ? [parsed] : [];
  }
}

/** One `field: value` block → an event, or null when there is nothing to dispatch. */
function parseSseBlock(block) {
  if (typeof block !== 'string' || block.trim() === '') return null;
  let event = 'message';
  const data = [];
  let sawData = false;
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;   // blank or comment (": open")
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);    // exactly one leading space
    if (field === 'event') event = value;
    else if (field === 'data') { data.push(value); sawData = true; }
  }
  if (!sawData && event === 'message') return null;
  return { event, data: data.join('\n') };
}

/**
 * POST /api/coach/message, streamed.
 *
 * `fetch` rather than `EventSource` because the request is a POST with a body.
 * Callbacks fire as the stream arrives; the promise resolves once, with an
 * honest outcome, whatever happened — including when the coach is not installed.
 *
 * @returns {Promise<{ok:true, sessionId:string|null, stoppedReason:string|null}
 *                 | {ok:false, kind:string, message:string}>}
 */
/**
 * Read one coach SSE stream to its end.
 *
 * Shared by the POST that starts a turn and the GET that re-attaches to one already
 * running, so a reloaded page reads exactly the same events in exactly the same way.
 */
async function consumeCoachStream(response, { onToken, onTool, onRun }, bump = () => {}) {
  const reader = response.body.getReader();
  const utf8 = new TextDecoder();
  const decoder = new SseDecoder();
  let done = null;
  let failure = null;

  const handle = ({ event, data }) => {
    let payload = null;
    try { payload = data ? JSON.parse(data) : null; } catch { return; } // a frame we cannot read is not a message
    if (event === 'token' && typeof payload?.text === 'string') onToken(payload.text);
    else if (event === 'tool') onTool(String(payload?.name || 'Tool'), String(payload?.summary || ''));
    // The server's id for this turn, sent first. It is what lets a reload find it again.
    else if (event === 'run' && payload?.id) onRun?.(payload);
    else if (event === 'done') done = { sessionId: payload?.sessionId ?? null, stoppedReason: payload?.stoppedReason ?? null };
    else if (event === 'error') failure = String(payload?.message || 'The coach stopped with an error it did not explain.');
  };

  for (;;) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    bump();
    for (const frame of decoder.push(utf8.decode(value, { stream: true }))) handle(frame);
  }
  for (const frame of decoder.flush()) handle(frame);

  if (failure) return { ok: false, kind: 'coach', code: 'COACH_ERROR', message: failure };
  if (done) return { ok: true, sessionId: done.sessionId, stoppedReason: done.stoppedReason };
  return {
    ok: false, kind: 'truncated', code: 'NO_DONE',
    message: 'The coach stopped mid-answer — the connection ended before it finished. Whatever arrived is above.',
  };
}

/** GET /api/coach/runs — turns the server is still holding, for a page that just loaded. */
export async function listCoachRuns() {
  if (api.mode !== 'live') return { ok: false, runs: [] };
  const result = await sendJson('/api/coach/runs');
  if (result.ok) return { ok: true, runs: Array.isArray(result.data?.runs) ? result.data.runs : [] };
  return { ok: false, runs: [] };
}

/** POST /api/coach/stop — the only thing besides finishing that ends a turn. */
export async function stopCoachRun({ slug = null, runId = null } = {}) {
  if (api.mode !== 'live') return { ok: false };
  return sendJson('/api/coach/stop', { method: 'POST', body: { slug, runId } });
}

/**
 * GET /api/coach/runs/:id — watch a turn already in flight, from wherever it has got to.
 *
 * The server replays what has arrived before streaming the rest, so this is also how a
 * dropped connection recovers: re-attaching gives back the whole answer, not the tail.
 */
export async function attachCoachRun(runId, { signal = null, onToken = () => {}, onTool = () => {}, onRun = null } = {}) {
  if (api.mode !== 'live') {
    return { ok: false, kind: 'offline', code: 'NO_SERVER', message: 'The studio server is not answering.' };
  }
  try {
    const response = await fetch(`/api/coach/runs/${encodeURIComponent(runId)}`, {
      signal, headers: { accept: 'text/event-stream' },
    });
    if (response.status === 404) {
      return { ok: false, kind: 'gone', code: 'RUN_NOT_FOUND', message: 'That coach turn is no longer being held.' };
    }
    if (!response.ok || !response.body) {
      return { ok: false, kind: 'server', code: `HTTP_${response.status}`, message: 'The coach turn could not be re-opened.' };
    }
    return await consumeCoachStream(response, { onToken, onTool, onRun });
  } catch (error) {
    if (error && error.name === 'AbortError') {
      return { ok: false, kind: 'cancelled', code: 'CANCELLED', message: 'You stopped watching the coach.' };
    }
    return { ok: false, kind: 'offline', code: 'UNREACHABLE', message: 'The connection to the studio server dropped.' };
  }
}

export async function streamCoachMessage(slug, message, {
  includeCode = true, signal = null, kind = null, attemptId = null, newThread = false, resumeSessionId = null,
  onToken = () => {}, onTool = () => {}, onRun = null,
} = {}) {
  if (api.mode !== 'live') {
    return {
      ok: false, kind: 'offline', code: 'NO_SERVER',
      message: 'The coach needs the studio server, which is not answering. Everything else on this page still works.',
    };
  }

  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }
  // An idle timer, reset by every byte: a coach that thinks for ninety seconds is
  // working, a coach that has said nothing for two minutes is gone.
  let idle = null;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { timedOut = true; controller.abort(); }, COACH_IDLE_TIMEOUT_MS);
  };
  let timedOut = false;

  try {
    bump();
    const response = await fetch('/api/coach/message', {
      method: 'POST',
      signal: controller.signal,
      headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
      body: JSON.stringify({ slug, message, includeCode, kind, attemptId, newThread, resumeSessionId }),
    });

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let payload = null;
      try { payload = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
      const missing = response.status === 404 || response.status === 405 || response.status === 501;
      return {
        ok: false,
        kind: missing ? 'unavailable' : 'server',
        code: payload?.error?.code || `HTTP_${response.status}`,
        message: missing
          ? 'This studio server has no coach endpoint yet. It is running an older build than this page.'
          : (payload?.error?.message || `The coach endpoint answered ${response.status}.`),
      };
    }
    if (!response.body) {
      return { ok: false, kind: 'server', code: 'NO_STREAM', message: 'The coach answered without a stream to read.' };
    }

    return await consumeCoachStream(response, { onToken, onTool, onRun }, bump);
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    if (aborted && !timedOut) {
      return { ok: false, kind: 'cancelled', code: 'CANCELLED', message: 'You stopped the coach before it finished.' };
    }
    if (timedOut) {
      return { ok: false, kind: 'timeout', code: 'TIMEOUT', message: 'The coach went quiet for two minutes, so the request was dropped.' };
    }
    return { ok: false, kind: 'offline', code: 'UNREACHABLE', message: 'The connection to the studio server dropped mid-answer.' };
  } finally {
    clearTimeout(idle);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

/**
 * POST /api/sessions/event — one line in the append-only session log.
 *
 * This log becomes the weakness view, so it must only ever describe things that
 * actually happened. Callers log AFTER the fact, never in anticipation, and a
 * failure here is deliberately quiet: a missing log line must not interrupt a solve.
 */
export async function logSessionEvent(slug, type, data = null) {
  if (api.mode !== 'live') {
    return { ok: false, kind: 'offline', code: 'NO_SERVER', message: 'No server, so nothing was logged.' };
  }
  const body = data === null ? { slug, type } : { slug, type, data };
  const result = await sendJson('/api/sessions/event', { method: 'POST', body, timeoutMs: EVENT_TIMEOUT_MS });
  if (result.ok) return { ok: true, sessionId: result.data?.sessionId || null, at: result.data?.at || null };
  return result;
}

/** GET /api/sessions/:slug — every recorded session for one problem. */
export async function loadSessions(slug) {
  if (api.mode !== 'live') {
    return { ok: false, kind: 'offline', code: 'NO_SERVER', message: 'The studio server is not answering.' };
  }
  const result = await sendJson(`/api/sessions/${encodeURIComponent(slug)}`);
  if (result.ok) return { ok: true, sessions: Array.isArray(result.data?.sessions) ? result.data.sessions : [] };
  return result;
}

/**
 * POST /api/asr — multipart audio in, a local transcript out. Nothing leaves the
 * machine; transcription is a Swift binary the server spawns.
 *
 * A recording with no speech in it comes back as an ERROR, and stays one here:
 * `ok:true` with an empty `text` is converted into a failure, because a silent
 * success would look exactly like a successful transcription of nothing.
 */
export async function transcribeAudio(slug, blob, { filename = 'take.webm', mode = 'think_aloud', attemptId = null, signal = null } = {}) {
  if (api.mode !== 'live') {
    return {
      ok: false, kind: 'offline', code: 'NO_SERVER',
      message: 'Transcription runs on the studio server, which is not answering. Nothing was sent anywhere.',
    };
  }

  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', relay, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), ASR_TIMEOUT_MS);

  try {
    const form = new FormData();
    form.append('audio', blob, filename);
    form.append('slug', slug);
    form.append('mode', mode);
    if (attemptId) form.append('attemptId', attemptId);

    const response = await fetch('/api/asr', { method: 'POST', body: form, signal: controller.signal });
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }

    if (!response.ok) {
      const missing = response.status === 404 || response.status === 405 || response.status === 501;
      const err = payload?.error || null;
      return {
        ok: false,
        kind: missing ? 'unavailable' : (err?.code === 'NO_AUDIO' || err?.kind === 'no_audio' ? 'no_audio' : 'server'),
        code: err?.code || `HTTP_${response.status}`,
        message: missing
          ? 'This studio server cannot transcribe yet — it has no /api/asr endpoint. Your recording was not saved.'
          : (err?.message || `The transcriber answered ${response.status}.`),
      };
    }

    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (text === '') {
      return {
        ok: false, kind: 'empty_transcript', code: 'EMPTY_TRANSCRIPT',
        message: 'The recording came back with no words in it. Nothing was heard — check the right microphone is selected and try again.',
      };
    }
    return {
      ok: true,
      text,
      words: Array.isArray(payload.words) ? payload.words : [],
      durationSeconds: typeof payload.durationSeconds === 'number' ? payload.durationSeconds : null,
      // The filename the server chose. Logged into the session event so the coach can
      // match this take to this attempt exactly, without timestamp arithmetic.
      transcript: typeof payload.transcript === 'string' ? payload.transcript : null,
    };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    const byCaller = aborted && signal && signal.aborted;
    return {
      ok: false,
      kind: byCaller ? 'cancelled' : (aborted ? 'timeout' : 'offline'),
      code: byCaller ? 'CANCELLED' : (aborted ? 'TIMEOUT' : 'UNREACHABLE'),
      message: byCaller
        ? 'The recording was discarded before it was transcribed.'
        : (aborted
          ? 'The transcriber did not answer in time. Your recording was not transcribed.'
          : 'The studio server is not answering, so nothing was transcribed.'),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}
