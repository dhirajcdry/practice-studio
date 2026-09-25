// Toolbar behaviour, checked in a real browser.
//
//   node scripts/check-toolbar.mjs
//
// Three things that are invisible to every unit test in this repo, and that have each
// already been wrong:
//
//   * Pressing Run while the panel is collapsed did nothing you could see. `doRun` added
//     an `open` class to a pane that `hide-results` had already collapsed, so the results
//     arrived behind a closed door and you had to go and open it yourself.
//   * Reset hid itself the moment there was anything to reset. It only knew the starter
//     when the server had just handed it over, which is exactly when the button is
//     useless.
//   * Button order and which buttons exist at all.
//
// None of that throws. None of it fails a unit test. It is only visible by looking.
//
// This check drives the real editor, and the real editor SAVES. The first run of it typed
// into contains-duplicate and then pressed its own Reset, writing the bare stub over a
// working solution; the attempt snapshots got it back, which was luck. So it starts its
// own server against a scratch workspace and cannot reach the real one. The LeetCode
// cache is copied in read-only, so the run needs no network.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9336;
const SERVER_PORT = 4179;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-toolbar-home-'));
const realCache = path.join(os.homedir(), 'LeetCodeTutor', 'cache');
if (fs.existsSync(realCache)) {
  await fsp.cp(realCache, path.join(HOME, 'cache'), { recursive: true });
}

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname), '..'),
  env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(SERVER_PORT) },
  stdio: 'ignore',
});

// Wait for it rather than guessing.
for (let i = 0; i < 100; i += 1) {
  try {
    await fetch(`${ORIGIN}/api/stats`);
    break;
  } catch {
    await sleep(100);
  }
}

async function cdp() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));

  let id = 0;
  const waiting = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const n = ++id;
    waiting.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw');
    }
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const problems = [];
const ok = (what) => console.log(`  ok   ${what}`);
const bad = (what, detail) => { problems.push(`${what} — ${detail}`); console.log(`  FAIL ${what}: ${detail}`); };

// A fresh profile every run. A shared one carries localStorage between runs, so the
// panel's collapsed/expanded state survives — and an assertion that assumed it started
// expanded passed or failed depending on how the LAST run happened to end.
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-toolbar-profile-'));

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();

  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: `${ORIGIN}/#/p/contains-duplicate` });

  const ready = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150 && !window.monaco?.editor?.getEditors?.().length; i++) await sleep(100);
    return Boolean(window.monaco?.editor?.getEditors?.().length);
  })()`);
  if (!ready) throw new Error('the editor never mounted');

  /* ---- 1. which buttons, in which order ---- */

  // Scoped to the workspace's own bar: the coach panel uses `.ws-bar` too, and its
  // buttons are not part of this ordering.
  const labels = await evaluate(`
    [...document.querySelectorAll('.ws > .ws-bar button')]
      .filter(b => !b.hidden)
      .map(b => (b.querySelector('span')?.textContent ?? b.textContent).trim())
  `);
  const runAt = labels.indexOf('Run');
  const submitAt = labels.indexOf('Submit');

  if (runAt === -1 || submitAt === -1) bad('Run and Submit are both in the toolbar', labels.join(' | '));
  else if (runAt > submitAt) bad('Run comes before Submit', labels.join(' | '));
  else ok(`button order: ${labels.join(' · ')}`);

  if (submitAt !== labels.length - 1) bad('Submit is last', labels.join(' | '));
  else ok('Submit is last — the irreversible one sits on its own');

  if (labels.includes('Panel')) bad('the Panel button is gone', 'it is still there');
  else ok('no Panel button (the chord still works, and Run opens the pane itself)');

  /* ---- 2. Run brings the panel up ---- */

  const chordJ = () => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown',
    { key: 'j', code: 'KeyJ', metaKey: true, bubbles: true, cancelable: true }))`);
  const collapsed = () => evaluate(`document.body.classList.contains('hide-results')`);

  // Assert the chord TOGGLES, from whatever state the page happens to be in. Asserting it
  // collapses assumes it started expanded, which is a fact about the last run, not this one.
  const before = await collapsed();
  await chordJ();
  await sleep(200);
  const after = await collapsed();
  if (after !== before) ok('⌘J toggles the run panel');
  else bad('⌘J toggles the run panel', 'the state did not change');

  // Now put it in the state this check is actually about: collapsed.
  if (!(await collapsed())) { await chordJ(); await sleep(200); }
  if (!(await collapsed())) bad('the panel can be collapsed at all', 'it would not collapse');

  await evaluate(`[...document.querySelectorAll('.ws > .ws-bar button')].find(b => b.textContent.trim().startsWith('Run')).click()`);
  await sleep(600);
  if (await evaluate(`document.body.classList.contains('hide-results')`)) {
    bad('pressing Run reveals the panel', 'the panel stayed collapsed — results behind a closed door');
  } else {
    ok('pressing Run reveals the collapsed panel');
  }

  const paneOpen = await evaluate(`document.querySelector('.ws-results')?.classList.contains('open') === true`);
  if (paneOpen) ok('...and the results pane itself is open');
  else bad('the results pane is open after Run', 'it is not');

  /* ---- 3. Reset knows the starter even after you have written over it ---- */

  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      const b = [...document.querySelectorAll('.ws > .ws-bar button')].find(x => x.textContent.trim() === 'Running');
      if (!b) break;
      await sleep(100);
    }
  })()`);

  const resetSel = `[...document.querySelectorAll('.ws-reset')][0]`;
  await evaluate(`window.monaco.editor.getEditors()[0].setValue('# something of my own\\nclass Solution:\\n    pass\\n')`);
  await sleep(600);

  const visible = await evaluate(`${resetSel} && !${resetSel}.hidden`);
  if (visible) ok('Reset appears once the buffer differs from the starter');
  else bad('Reset appears once you have written something', 'the button is hidden — it does not know the starter');

  if (visible) {
    // One click arms, it does not wipe.
    await evaluate(`${resetSel}.click()`);
    await sleep(120);
    const armed = await evaluate(`${resetSel}.classList.contains('is-arming')`);
    const stillMine = await evaluate(`window.monaco.editor.getEditors()[0].getValue().includes('something of my own')`);
    if (armed && stillMine) ok('one click on Reset asks rather than wipes');
    else bad('one click on Reset only asks', `armed=${armed} codeIntact=${stillMine}`);

    // The second click does it, and puts back something that is not what we typed.
    await evaluate(`${resetSel}.click()`);
    await sleep(300);
    const after = await evaluate(`window.monaco.editor.getEditors()[0].getValue()`);
    if (!after.includes('something of my own') && after.includes('class Solution')) {
      ok('the second click puts the starter back');
    } else {
      bad('the second click restores the starter', JSON.stringify(after.slice(0, 80)));
    }
  }

  close();
} finally {
  chrome.kill();
  server.kill();
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

if (problems.length) {
  console.error(`\ntoolbar check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('toolbar ok — order, the Run-opens-the-panel rule, and a Reset that survives being written over');
