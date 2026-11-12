import { cleanupChrome } from './chrome-cleanup.mjs';
// Shuffle opens a random problem from the filtered set, from the explorer and the
// problem page, by button and by `r`, and never re-opens the problem already open.
//
//   node scripts/check-shuffle.mjs

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch } from './check-scratch.mjs';

const NEW_SLUG = 'find-the-xor-of-numbers-which-appear-twice'; // not in the catalog; its statement is cached by the scratch helper
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scratch = process.env.STUDIO_ORIGIN ? null : await startScratch(4189, NEW_SLUG);
const ORIGIN = process.env.STUDIO_ORIGIN || scratch?.origin;
const PORT = 9341;
const PROFILE = await fsp.mkdtemp(`${os.tmpdir()}/studio-shuffle-profile-`);

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
  '--headless=new', '--disable-background-networking', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
const fail = (message) => { failed = true; console.error('FAIL  ' + message); };
let loads = 0;
const slugOf = 'decodeURIComponent((/^#\\/p\\/(.+)$/.exec(location.hash) || [])[1] || "")';

try {
  let session = null;
  for (let attempt = 0; attempt < 40 && !session; attempt++) {
    await sleep(250);
    try { session = await cdp(); } catch { /* Chrome still starting */ }
  }
  if (!session) throw Error('Chrome did not open a debugging port');
  const { send, evaluate, close } = session;
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*', 'http://leetcode.com/*', 'http://*.leetcode.com/*', 'http://neetcode.io/*', 'http://*.neetcode.io/*'] });
  // A known filter: Blind 75, Easy. Every shuffle must land inside it.
  await send('Page.navigate', { url: `${ORIGIN}/#/` });
  await sleep(2500);
  await evaluate(`(() => { [...document.querySelectorAll('.seg-opt')].find(b => b.textContent.trim() === 'Blind 75').click();
    [...document.querySelectorAll('.seg-opt')].find(b => b.textContent.trim() === 'Easy').click(); return true; })()`);
  await sleep(300);
  const allowed = await evaluate(`(async () => { const catalog = await (await fetch('/api/problems')).json();
    return (catalog.problems || catalog).filter(p => p.lists?.blind75 && p.difficulty === 'Easy').map(p => p.slug); })()`);
  if (!allowed?.length) throw Error('could not read the catalog for the filter');

  const button = await evaluate(`(() => { const b = document.querySelector('.catalog .filterbar .shufflebtn');
    if (!b) return null; const r = b.getBoundingClientRect(); const c = document.querySelector('.catalog .countpill').getBoundingClientRect();
    return { text: b.textContent.trim(), h: r.height, dy: Math.abs((r.top + r.bottom) / 2 - (c.top + c.bottom) / 2) }; })()`);
  if (!button) fail('explorer has no Shuffle button');
  else if (button.text !== 'Shuffle' || button.dy > 1.5) fail(`explorer Shuffle button looks wrong: ${JSON.stringify(button)}`);

  await evaluate(`document.querySelector('.catalog .filterbar .shufflebtn').click()`);
  await sleep(600);
  let current = await evaluate(slugOf);
  if (!allowed.includes(current)) fail(`explorer button opened ${current || 'nothing'}, outside Blind 75 / Easy`);

  // On the problem page: the button sits with the arrows, and button + r both move.
  const nav = await evaluate(`(() => { const s = document.querySelector('.pnav-shuffle'), n = document.querySelectorAll('.pnav-btn')[1];
    if (!s || !n) return null; const a = s.getBoundingClientRect(), b = n.getBoundingClientRect();
    const title = document.querySelector('.ui-screen-header h1')?.getBoundingClientRect();
    return { disabled: s.disabled, dy: Math.abs(a.top - b.top), after: a.left >= b.right, w: a.width, overlap: title ? title.right > a.left && title.top < a.bottom : false }; })()`);
  if (!nav) fail('problem page has no shuffle button');
  else if (nav.disabled || nav.dy > 1 || !nav.after || nav.w !== 28 || nav.overlap) fail(`problem shuffle button misplaced: ${JSON.stringify(nav)}`);

  const seen = new Set([current]);
  for (let i = 0; i < 12; i++) {
    const before = current;
    if (i % 2) await evaluate(`document.querySelector('.pnav-shuffle').click()`);
    else await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true }))`);
    await sleep(450);
    current = await evaluate(slugOf);
    if (current === before) fail(`shuffle stayed on ${before}`);
    if (!allowed.includes(current)) fail(`shuffle opened ${current}, outside Blind 75 / Easy`);
    seen.add(current);
  }
  if (seen.size < 3) fail(`twelve shuffles only visited ${seen.size} problems`);

  // ⌘R must still reload: the r shortcut is bare-key only.
  const stolen = await evaluate(`(() => { const e = new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', metaKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(e); return e.defaultPrevented; })()`);
  if (stolen) fail('⌘R was intercepted');

  // A different query string forces a full load, so no simulated Connector survives into the next case.
  const fresh = () => send('Page.navigate', { url: `${ORIGIN}/?load=${++loads}#/` });
  // ---- LeetCode mode, with a simulated Connector (nothing reaches LeetCode) ----
  await evaluate(`localStorage.setItem('studio.shuffle-source.v1', 'leetcode'); true`);
  await fresh();
  await sleep(2500);
  await evaluate(`(() => {
    document.documentElement.dataset.studioConnector = '1.3.0';
    window.__requests = 0; window.__reply = null;
    window.addEventListener('message', e => {
      const d = e.data; if (!d || d.source !== 'studio-page' || d.type !== 'random') return;
      window.__requests++;
      setTimeout(() => window.postMessage({ source: 'studio-connector', id: d.id, result: window.__reply }, location.origin), 400);
    });
    return true; })()`);
  const countProblems = `(async () => (await (await fetch('/api/problems')).json()).problems.length)()`;
  const before = await evaluate(countProblems);

  // A problem Studio lacks: imported once into Others, opened, and a double click sends one request.
  await evaluate(`window.__reply = { ok: true, slug: '${NEW_SLUG}', paidOnly: false };
    document.querySelector('.shufflebtn').click(); document.querySelector('.shufflebtn').click(); true`);
  const busy = await evaluate(`(() => { const b = document.querySelector('.shufflebtn'); return { busy: b.getAttribute('aria-busy'), disabled: b.disabled, text: b.textContent.trim() }; })()`);
  if (busy.busy !== 'true' || !busy.disabled) fail(`Shuffle not busy while the Connector works: ${JSON.stringify(busy)}`);
  await sleep(1500);
  if (await evaluate(slugOf) !== NEW_SLUG) fail(`LeetCode shuffle did not open ${NEW_SLUG} (at ${await evaluate(slugOf)})`);
  if (await evaluate('window.__requests') !== 1) fail(`double click sent ${await evaluate('window.__requests')} Connector requests`);
  const imported = await evaluate(`(async () => (await (await fetch('/api/problems')).json()).problems.find(p => p.slug === '${NEW_SLUG}')?.lists)()`);
  if (!imported?.others || imported?.added) fail(`new problem not filed under Others: ${JSON.stringify(imported)}`);
  if (await evaluate(countProblems) !== before + 1) fail('importing one new problem did not add exactly one');

  // Already in Studio (curated, and the one just imported): opened, nothing added.
  for (const slug of ['two-sum', NEW_SLUG]) {
    await fresh(); await sleep(1500);
    await evaluate(`(() => { document.documentElement.dataset.studioConnector = '1.3.0';
      window.addEventListener('message', e => { const d = e.data; if (!d || d.source !== 'studio-page' || d.type !== 'random') return;
        window.postMessage({ source: 'studio-connector', id: d.id, result: { ok: true, slug: '${slug}', paidOnly: false } }, location.origin); });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', code: 'KeyR', bubbles: true, cancelable: true })); return true; })()`);
    await sleep(1200);
    if (await evaluate(slugOf) !== slug) fail(`existing ${slug} was not opened`);
  }
  if (await evaluate(countProblems) !== before + 1) fail('an existing problem was added again');

  // The explorer shows the Others list.
  await fresh(); await sleep(1500);
  const lists = await evaluate(`[...document.querySelectorAll('.seg-opt')].map(b => b.textContent.trim())`);
  if (!lists.includes('Others') || !lists.includes('You') === lists.includes('Added by you')) fail(`list switcher: ${JSON.stringify(lists)}`);

  // A Connector failure is shown on screen, and no local pick happens.
  await evaluate(`(() => { document.documentElement.dataset.studioConnector = '1.3.0';
    window.addEventListener('message', e => { const d = e.data; if (!d || d.source !== 'studio-page' || d.type !== 'random') return;
      window.postMessage({ source: 'studio-connector', id: d.id, result: { ok: false, code: 'SIGNED_OUT', message: 'Sign in on leetcode.com, then shuffle again.' } }, location.origin); });
    document.querySelector('.shufflebtn').click(); return true; })()`);
  await sleep(800);
  const notice = await evaluate(`(() => { const n = document.querySelector('[data-shuffle-notice]'); if (!n) return null; const r = n.getBoundingClientRect();
    return { text: n.textContent, onScreen: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth }; })()`);
  if (!notice?.text.includes('Sign in on leetcode.com') || !notice.onScreen) fail(`failure notice: ${JSON.stringify(notice)}`);
  if (await evaluate(slugOf)) fail('a failed LeetCode shuffle still opened a problem');

  // No Connector: says so.
  await fresh(); await sleep(1500);
  await evaluate(`delete document.documentElement.dataset.studioConnector; document.querySelector('.shufflebtn').click(); true`);
  await sleep(500);
  const missing = await evaluate(`document.querySelector('[data-shuffle-notice]')?.textContent || ''`);
  if (!/Install Studio Connector/.test(missing)) fail(`missing-Connector notice: ${JSON.stringify(missing)}`);

  if (!failed) console.log(`shuffle ok — ${seen.size} different problems, all inside the filter, button aligned with the arrows; LeetCode mode imports once into Others, reuses existing problems, shows failures`);
  close();
} catch (err) {
  failed = true;
  console.error(`could not run the check: ${err.message}`);
} finally {
  const chromeExited = chrome.exitCode === null && chrome.signalCode === null
    ? new Promise((resolve) => chrome.once('exit', resolve)) : Promise.resolve();
  chrome.kill();
  await chromeExited;
  await scratch?.cleanup();
  await cleanupChrome(chrome, PROFILE);
}

process.exit(failed ? 1 : 0);
