// Runs on local pages. Relays one Studio submit request to the background worker and
// hands the answer back to the page. It never sees cookies and never talks to LeetCode.
//
// The marker attribute is how Studio knows the connector is installed. Requests are only
// accepted from a page that declares itself as Practice Studio, so another local site
// cannot use this browser's LeetCode account.

document.documentElement.dataset.studioConnector = chrome.runtime.getManifest().version;

const isStudio = () => document.querySelector('meta[name="practice-studio"]') !== null;

window.addEventListener('message', (event) => {
  const data = event.data;
  if (event.source !== window || !data || data.source !== 'studio-page' || data.type !== 'submit') return;
  if (!isStudio()) return;

  const reply = (result) => window.postMessage({ source: 'studio-connector', id: data.id, result }, location.origin);
  let answered = false;
  let port;
  try {
    port = chrome.runtime.connect({ name: 'studio-submit' });
  } catch {
    // The extension was reloaded or removed after this page loaded.
    return reply({ ok: false, code: 'CONNECTOR_GONE', submissionState: 'not_sent',
      message: 'The Studio Connector was reloaded since this page opened. Reload Studio, then submit again. Nothing was submitted.' });
  }
  port.onMessage.addListener((result) => {
    answered = true;
    reply(result);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => {
    if (answered) return;
    reply({ ok: false, code: 'CONNECTOR_ERROR', submissionState: 'unknown',
      message: 'The Studio Connector stopped before it answered. Check your submissions on LeetCode before sending another.' });
  });
  port.postMessage({ type: 'submit', slug: data.slug, code: data.code, lang: data.lang });
});
