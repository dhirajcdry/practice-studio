// The page's side of the Studio Connector browser extension (extension/).
//
// The extension submits from inside a leetcode.com tab (or, for premium problems, a
// neetcode.io tab) with the browser's own sign-in, so Studio never holds cookies. This file only passes one request across and
// waits for one answer. It never retries.

let nextId = 0;

/** The installed connector's version, or '' when it is not installed in this browser. */
export function connectorVersion() {
  return document.documentElement.dataset.studioConnector || '';
}

/** The first Connector version that can submit premium problems to NeetCode. */
export const NEETCODE_CONNECTOR_VERSION = '1.1.0';

/** `a >= b` for dotted versions like "1.10.2". */
export function versionAtLeast(a, b) {
  const pa = String(a || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return true;
}

/**
 * Whether the installed Connector can submit to NeetCode: '' when it can, otherwise
 * 'missing' or 'outdated'. This matters for more than the wording: a Connector older
 * than 1.1.0 ignores `target` and would send a premium problem to LeetCode instead, so
 * nothing may be sent to an outdated one.
 */
export function neetcodeConnectorProblem() {
  const version = connectorVersion();
  if (!version) return 'missing';
  return versionAtLeast(version, NEETCODE_CONNECTOR_VERSION) ? '' : 'outdated';
}

/**
 * Ask the connector for one submission. Resolves to `{ ok:true, submissionId, check }`
 * or `{ ok:false, code, message, submissionState, submissionId? }`. Aborting only stops
 * us waiting; LeetCode judges what it was sent.
 *
 * With `target: 'neetcode'` (premium problems) the connector submits on neetcode.io
 * instead and resolves to `{ ok:true, target:'neetcode', result }`, `result` being the
 * verdict it read off NeetCode's page. The request's `id` comes back as `requestId`.
 */
export function submitViaConnector({ slug, code, lang = 'python3', signal = null, target = 'leetcode', neetcodeSlug = null }) {
  const id = `studio-${Date.now()}-${nextId += 1}`;
  return new Promise((resolve) => {
    function done(result) {
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || data?.source !== 'studio-connector' || data.id !== id) return;
      const result = data.result && typeof data.result === 'object' ? data.result : null;
      done(result ? (target === 'neetcode' ? { ...result, requestId: id } : result) : {
        ok: false, code: 'CONNECTOR_ERROR', submissionState: 'unknown',
        message: `The Studio Connector sent an unreadable answer. Check your submissions on ${target === 'neetcode' ? 'NeetCode' : 'LeetCode'} before sending another.`,
      });
    }
    function onAbort() {
      done({ ok: false, code: 'CANCELLED', submissionState: 'unknown', message: 'Stopped waiting for the verdict.' });
    }
    if (signal?.aborted) return onAbort();
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    const request = { source: 'studio-page', type: 'submit', id, slug, code, lang };
    if (target === 'neetcode') Object.assign(request, { target, neetcodeSlug });
    window.postMessage(request, location.origin);
  });
}
