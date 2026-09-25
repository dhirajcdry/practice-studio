// The app must not intercept shortcuts the browser already owns.
//
//   node scripts/check-shortcuts.mjs
//
// Written after Cmd/Ctrl-Shift-R — hard reload — was bound to "start attempt", which
// meant the page could not be force-refreshed while a problem was open. The bug was
// invisible to every other test: the app worked perfectly, it just quietly broke the
// browser around it.
//
// It dispatches each reserved combo and asserts nothing called preventDefault. That is
// the exact condition for "the browser still gets it".

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.STUDIO_ORIGIN || 'http://127.0.0.1:4173';
const PORT = 9334;

// key, and the modifiers the browser reserves it with.
const RESERVED = [
  { key: 'r', meta: true, shift: true, what: 'hard reload' },
  { key: 'R', ctrl: true, shift: true, what: 'hard reload (Windows/Linux)' },
  { key: 'r', meta: true, what: 'reload' },
  { key: 'r', ctrl: true, what: 'reload (Windows/Linux)' },
  { key: 't', meta: true, what: 'new tab' },
  { key: 'w', meta: true, what: 'close tab' },
  { key: 'n', meta: true, what: 'new window' },
  { key: 'l', meta: true, what: 'focus address bar' },
  { key: 'f', meta: true, what: 'find in page' },
  { key: 'p', meta: true, what: 'print' },
  { key: 'd', meta: true, what: 'bookmark' },
  { key: 't', meta: true, shift: true, what: 'reopen closed tab' },
  { key: '[', meta: true, what: 'back' },
  { key: ']', meta: true, what: 'forward' },
  { key: '+', meta: true, what: 'zoom in' },
  { key: '-', meta: true, what: 'zoom out' },
  { key: '0', meta: true, what: 'reset zoom' },
  // Studio owns ⌘B, ⌘J and ⌘\ for its panes. The browser owns the shifted versions,
  // and the pane handler bails on Shift for exactly that reason — checked here so it
  // stays true.
  { key: 'b', meta: true, shift: true, what: 'toggle the bookmarks bar' },
  { key: 'j', meta: true, shift: true, what: 'show downloads' },
  { key: 'b', meta: true, alt: true, what: 'the bookmark manager' },
  { key: 'j', meta: true, alt: true, what: 'the DevTools console' },
];

/** The physical key that produces this character, as KeyboardEvent.code names it. */
function codeFor(key) {
  if (/^[a-zA-Z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  return { '[': 'BracketLeft', ']': 'BracketRight', '+': 'Equal', '-': 'Minus' }[key] ?? '';
}

async function cdp() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TMPDIR || '/tmp'}/studio-shortcut-check`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: `${ORIGIN}/#/p/contains-duplicate` });
  await sleep(2800);

  // Stop anything a handler might actually do — this checks interception, not behaviour.
  await evaluate(`(() => {
    window.__stolen = [];
    window.fetch = () => new Promise(() => {});
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) window.__stolen.push(e.key + (e.metaKey ? '+meta' : '') + (e.ctrlKey ? '+ctrl' : '') + (e.shiftKey ? '+shift' : ''));
    }, true);
    return true;
  })()`);

  for (const combo of RESERVED) {
    // `code` as well as `key`. Handlers legitimately match on either, and a synthetic
    // event with no code silently misses every handler that checks it — which is how
    // the first version of this check passed while the bug it was written for was
    // sitting in the file.
    const spec = JSON.stringify({
      key: combo.key,
      code: codeFor(combo.key),
      metaKey: !!combo.meta, ctrlKey: !!combo.ctrl, shiftKey: !!combo.shift, altKey: !!combo.alt,
      bubbles: true, cancelable: true,
    });
    const prevented = await evaluate(
      `(() => { const e = new KeyboardEvent('keydown', ${spec}); document.dispatchEvent(e); return e.defaultPrevented; })()`,
    );
    const label = `${combo.meta ? '⌘' : ''}${combo.ctrl ? 'Ctrl+' : ''}${combo.alt ? '⌥' : ''}${combo.shift ? '⇧' : ''}${combo.key}`;
    if (prevented) {
      failed = true;
      console.error(`STOLEN  ${label.padEnd(10)} — the browser uses this for ${combo.what}`);
    }
  }

  if (!failed) console.log(`shortcuts ok — ${RESERVED.length} browser-reserved combos all reach the browser`);
  close();
} catch (err) {
  failed = true;
  console.error(`could not run the check: ${err.message}`);
  console.error('Chrome and a running studio server are both required.');
} finally {
  chrome.kill();
}

process.exit(failed ? 1 : 0);
