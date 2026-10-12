// The page's side of the Studio Connector browser extension (extension/).
//
// The extension submits from inside a leetcode.com tab with the browser's own sign-in,
// so Studio never holds LeetCode cookies. This file only passes one request across and
// waits for one answer. It never retries.

let nextId = 0;

/** The installed connector's version, or '' when it is not installed in this browser. */
export function connectorVersion() {
  return document.documentElement.dataset.studioConnector || '';
}

/**
 * Ask the connector for one submission. Resolves to `{ ok:true, submissionId, check }`
 * or `{ ok:false, code, message, submissionState, submissionId? }`. Aborting only stops
 * us waiting; LeetCode judges what it was sent.
 */
export function submitViaConnector({ slug, code, lang = 'python3', signal = null }) {
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
      done(data.result && typeof data.result === 'object' ? data.result : {
        ok: false, code: 'CONNECTOR_ERROR', submissionState: 'unknown',
        message: 'The Studio Connector sent an unreadable answer. Check your submissions on LeetCode before sending another.',
      });
    }
    function onAbort() {
      done({ ok: false, code: 'CANCELLED', submissionState: 'unknown', message: 'Stopped waiting for the verdict.' });
    }
    if (signal?.aborted) return onAbort();
    window.addEventListener('message', onMessage);
    signal?.addEventListener('abort', onAbort, { once: true });
    window.postMessage({ source: 'studio-page', type: 'submit', id, slug, code, lang }, location.origin);
  });
}
