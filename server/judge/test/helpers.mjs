// Test doubles. Nothing in server/judge/test/ ever touches the network: `fetch` is always
// one of these stubs, and any attempt to reach leetcode.com through the real fetch would
// fail the assertions in submit.test.mjs that count and inspect every call.

export const FAKE_SESSION = 'FAKE-SESSION-eyJhbGciOiJIUzI1NiJ9.dGhpcy1pcy1ub3QtcmVhbA.zzzz';
export const FAKE_CSRF = 'FAKE-CSRF-TOKEN-0123456789abcdefABCDEF';
export const FAKE_CF = 'FAKE-CF-CLEARANCE-abcdefghijklmnop.0123456789';

export const FAKE_SECRETS = [FAKE_SESSION, FAKE_CSRF, FAKE_CF];

/** A keychain that has all three items. */
export function keychainWith({ session = FAKE_SESSION, csrf = FAKE_CSRF, cf = FAKE_CF } = {}) {
  return (bin, args, opts, cb) => {
    const service = args[args.indexOf('-s') + 1];
    const value =
      service === 'studio-leetcode-session' ? session
        : service === 'studio-leetcode-csrf' ? csrf
          : service === 'studio-leetcode-cfclearance' ? cf
            : null;
    if (value === null || value === undefined) {
      const err = new Error('security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.');
      err.code = 44;
      return cb(err, '', '');
    }
    return cb(null, `${value}\n`, '');
  };
}

/** A keychain with nothing stored — `security` exits non-zero for every lookup. */
export function emptyKeychain() {
  return keychainWith({ session: null, csrf: null, cf: null });
}

/** Minimal Response-alike: only what client.mjs reads (status, headers.get, text). */
export function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function htmlResponse(text, { status = 403, headers = {} } = {}) {
  return response(text, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}

export function response(text, { status = 200, headers = {} } = {}) {
  const map = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: { get: (name) => map.get(String(name).toLowerCase()) ?? null },
    async text() {
      return text;
    },
  };
}

/**
 * A scripted fetch. `plan` maps a URL substring to a handler (or a static response);
 * every call is recorded so a test can assert exactly one POST to /submit/ was made.
 */
export function stubFetch(plan) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    for (const [needle, handler] of Object.entries(plan)) {
      if (String(url).includes(needle)) {
        const value = typeof handler === 'function' ? await handler(calls.length, { url, init }) : handler;
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`stubFetch: no plan entry for ${url}`);
  };
  fn.calls = calls;
  fn.countOf = (needle) => calls.filter((c) => c.url.includes(needle)).length;
  return fn;
}

/** Collects every log line a handler emits, so a test can grep it for credentials. */
export function collectingLog() {
  const lines = [];
  const push = (...args) => lines.push(args.map((a) => (typeof a === 'string' ? a : inspectish(a))).join(' '));
  return { lines, log: push, info: push, warn: push, error: push, debug: push, text: () => lines.join('\n') };
}

function inspectish(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const ACCEPTED_CHECK = Object.freeze({
  state: 'SUCCESS',
  status_code: 10,
  status_msg: 'Accepted',
  run_success: true,
  total_correct: 64,
  total_testcases: 64,
  status_runtime: '3 ms',
  status_memory: '20.4 MB',
  runtime_percentile: 53.86,
  memory_percentile: 58.13,
  finished: true,
});
