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
export function submitViaConnector({
  slug, code, lang = 'python3', signal = null, target = 'leetcode', neetcodeSlug = null,
}) {
  const request = { type: 'submit', slug, code, lang };
  if (target === 'neetcode') Object.assign(request, { target, neetcodeSlug });
  return connectorRequest(request, signal);
}

/** Details have their own request shape and failure wording: this path cannot submit. */
export function detailsViaConnector(slug, submissionId) {
  if (!versionAtLeast(connectorVersion(), '1.2.0')) {
    return Promise.resolve({
      ok: false, message: 'Reload Studio Connector 1.2.0 in chrome://extensions to fetch details.',
    });
  }
  return connectorRequest({ type: 'details', slug, submissionId });
}

// Correlation and listener cleanup are shared; operation semantics stay at the edges.
function connectorRequest(request, signal = null) {
  const id = `studio-${Date.now()}-${nextId += 1}`;
  const reading = request.type === 'details';
  return new Promise(resolve => {
    function done(result) {
      window.removeEventListener('message', onMessage);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    }
    function onMessage(event) {
      const data = event.data;
      if (event.source !== window || data?.source !== 'studio-connector' || data.id !== id) return;
      const result = data.result && typeof data.result === 'object' ? data.result : null;
      if (result) {
        done(request.target === 'neetcode' ? { ...result, requestId: id } : result);
        return;
      }
      if (reading) {
        done({ ok: false, code: 'CONNECTOR_ERROR', message: 'The details response could not be read.' });
        return;
      }
      const source = request.target === 'neetcode' ? 'NeetCode' : 'LeetCode';
      done({
        ok: false, code: 'CONNECTOR_ERROR', submissionState: 'unknown',
        message: `The Connector sent an unreadable answer. Check your submissions on ${source} before sending another.`,
      });
    }
    function onAbort() {
      if (reading) done({ ok: false, code: 'CANCELLED', message: 'Stopped waiting for details.' });
      else done({
        ok: false, code: 'CANCELLED', submissionState: 'unknown', message: 'Stopped waiting for the verdict.',
      });
    }
    if (signal?.aborted) return onAbort();
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    window.postMessage({ ...request, source: 'studio-page', id }, location.origin);
  });
}
