import { cleanupChrome } from './chrome-cleanup.mjs';
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
// own server against a scratch workspace and cannot reach the real one. Synthetic cached content keeps the check offline.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch, requireFreePort } from './check-scratch.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9336;
const SERVER_PORT = 4179;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

await requireFreePort(PORT);
const { cleanup: cleanupScratch } = await startScratch(SERVER_PORT, 'contains-duplicate', {});

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
    [...document.querySelectorAll('.ui-screen-header .ws-run, .ui-screen-header .ws-submit')]
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

  await evaluate(`[...document.querySelectorAll('.ui-screen-header .ws-run, .ui-screen-header .ws-submit')].find(b => b.textContent.trim().startsWith('Run')).click()`);
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
      const b = [...document.querySelectorAll('.ui-screen-header .ws-run, .ui-screen-header .ws-submit')].find(x => x.querySelector('span')?.textContent.trim() === 'Running');
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
    // One click resets, and nothing is lost: the notice offers Undo and the editor's
    // own undo stack holds what was written.
    await evaluate(`${resetSel}.click()`);
    await sleep(300);
    const after = await evaluate(`window.monaco.editor.getEditors()[0].getValue()`);
    const undo = `[...document.querySelectorAll('.ws-notice:not([hidden]) button')].find(b => b.textContent.trim() === 'Undo')`;
    const offered = await evaluate(`!!${undo}`);
    if (!after.includes('something of my own') && after.includes('class Solution') && offered) ok('one click on Reset puts the starter back and offers Undo');
    else bad('one click on Reset restores the starter and offers Undo', `undoOffered=${offered} ${JSON.stringify(after.slice(0, 80))}`);

    if (offered) {
      await evaluate(`${undo}.click()`);
      await sleep(300);
      const restored = await evaluate(`window.monaco.editor.getEditors()[0].getValue().includes('something of my own')`);
      const cleared = await evaluate(`!document.querySelector('.ws-notice:not([hidden])')`);
      if (restored && cleared) ok('Undo brings back exactly what was written');
      else bad('Undo restores the code and clears the notice', `restored=${restored} noticeCleared=${cleared}`);
    }
  }

  /* ---- 3b. The file row's wrap toggle and the way back to a hidden sidebar ---- */
  const wrapOption = () => evaluate(`(() => { const e = window.monaco.editor.getEditors()[0]; return e.getOption(window.monaco.editor.EditorOption.wordWrap); })()`);
  const wrapBefore = await wrapOption();
  await evaluate(`document.querySelector('.editor-wrap').click()`);
  const wrapAfter = await wrapOption();
  const wrapStored = await evaluate(`localStorage.getItem('studio.editor.wrap')`);
  if (wrapBefore !== wrapAfter && wrapStored === (wrapAfter === 'on' ? 'on' : 'off')) ok(`Wrap toggles the editor (${wrapBefore} → ${wrapAfter}) and is remembered`);
  else bad('Wrap toggles the editor and is remembered', `before=${wrapBefore} after=${wrapAfter} stored=${wrapStored}`);
  await evaluate(`document.querySelector('.editor-wrap').click()`);

  await evaluate(`document.body.classList.contains('coach-open') && document.querySelector('.coach-hide').click()`);
  await sleep(100);
  const openVisible = await evaluate(`(() => { const r = document.querySelector('.editor-open-sidebar').getBoundingClientRect(); return r.width > 0 && r.height > 0; })()`);
  await evaluate(`document.querySelector('.editor-open-sidebar').click()`);
  await sleep(100);
  const reopened = await evaluate(`document.body.classList.contains('coach-open')`);
  const goneWhenOpen = await evaluate(`document.querySelector('.editor-open-sidebar').getBoundingClientRect().width === 0`);
  if (openVisible && reopened && goneWhenOpen) ok('a hidden sidebar has a button in the file row that brings it back');
  else bad('a hidden sidebar can be reopened from the file row', `visible=${openVisible} reopened=${reopened} hiddenWhenOpen=${goneWhenOpen}`);
  await evaluate(`document.querySelector('.coach-hide').click()`);

  // Every public opener targets the same mounted pane and preserves its tabs.
  for (const opener of ['rail', 'launcher', 'event', 'shortcut']) {
    await evaluate(`document.body.classList.contains('coach-open') && document.querySelector('.coach-hide').click()`);
    if (opener === 'shortcut') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '\\', code: 'Backslash', modifiers: 4 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '\\', code: 'Backslash', modifiers: 4 });
    } else await evaluate(opener === 'event' ? `window.dispatchEvent(new CustomEvent('studio:open-coach'))` :
      opener === 'rail' ? `document.querySelector('[data-pane="coach"]').click()` : `document.querySelector('.coach-launch').click()`);
    await sleep(100);
    const opened = await evaluate(`(() => {
      const panel = document.querySelector('.coach'), r = panel.getBoundingClientRect();
      return document.body.classList.contains('coach-open') && r.width > 0 && r.height > 0
        && [...panel.querySelectorAll('.coach-tab')].map(n=>n.textContent).join('|').match(/Chat.*Interviews.*Submissions/);
    })()`);
    if (opened) ok(opener + ' opens the coach pane and all three tabs');
    else bad(opener + ' opens the coach pane');
  }
  await evaluate(`document.querySelector('.coach-hide').click()`);

  const chromeGeometry = await evaluate(`(() => {
    const issues = [], box = n => n.getBoundingClientRect();
    const nav = [...document.querySelectorAll('.ui-screen-header .pnav-btn')];
    if (nav.length !== 3 || nav.some(n => box(n).width !== 28 || n.querySelectorAll('svg').length !== 1 || n.childNodes[0].nodeType === 3)) issues.push('previous/next/shuffle must be three SVG buttons');
    const tabs = [...document.querySelectorAll('.problem-tabs [role=tab]')];
    if (tabs.map(n=>n.textContent.replace(/[sa]$/, '').trim()).length !== 4 || tabs.some(n=>Math.abs(box(n).top-box(tabs[0]).top)>1 || box(n).height!==38)) issues.push('problem tabs must share a 38px row');
    const meta = document.querySelector('.editor-meta'), original = meta.style.cssText;
    try {
      for (const width of [220, 320, 600]) {
        meta.style.flex = 'none'; meta.style.width = width + 'px';
        const items = [...meta.querySelectorAll('.editor-path,.editor-cursor,.editor-wrap,.editor-open-sidebar')].filter(n=>box(n).width>0);
        if (items.some((n,i)=>i && box(items[i-1]).right > box(n).left + 1)) issues.push('editor controls overlap at '+width);
      }
    } finally { meta.style.cssText = original; }
    return issues;
  })()`);
  if (chromeGeometry.length) bad('workspace chrome geometry', chromeGeometry.join('; '));
  else ok('navigation, tabs and editor controls meet the shared geometry');

  /* ---- 4. Reference tabs: Solution / Article switch the problem pane in place ---- */
  const key = async (k) => {
    await evaluate(`document.activeElement?.blur?.()`);
    const code = k === 'Escape' ? 'Escape' : 'Key' + k.toUpperCase();
    const vk = k === 'Escape' ? 27 : k.toUpperCase().charCodeAt(0);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk, ...(k.length === 1 ? { text: k } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
    await sleep(150);
  };
  const tabState = () => evaluate(`(() => {
    const shown = n => !!n && n.getClientRects().length > 0;
    const selected = [...document.querySelectorAll('.problem-tabs [role=tab][aria-selected=true]')].map(n => n.dataset.panel);
    const panel = [...document.querySelectorAll('.pcol .ref-tab')].find(shown);
    return { selected: selected.join(','), statement: shown(document.querySelector('#ref-problem')), panel: panel?.dataset.panel ?? null,
      inPane: !!panel && document.querySelector('.pcol').contains(panel), connected: !!document.querySelector('#ref-problem')?.isConnected,
      drawer: !!document.querySelector('#drawer,.drawer,.scrim'), hidden: document.body.classList.contains('hide-problem') };
  })()`);
  const expectTab = async (what, want) => {
    const got = await tabState();
    const good = got.selected === want && !got.drawer && got.connected
      && (want === 'problem' ? got.statement && !got.panel : !got.statement && got.panel === want && got.inPane && !got.hidden);
    if (good) ok(what); else bad(what, JSON.stringify(got));
  };
  await evaluate(`(async () => {
    for (let i = 0; i < 100 && !document.querySelector('[data-panel="solution"]'); i++) await new Promise(r => setTimeout(r, 100));
  })()`);
  await expectTab('the problem pane opens on the Problem tab', 'problem');
  // Count the reveal events the page logs: one per open that put a reference on screen.
  await evaluate(`(() => { window.__reveals = { revealed_solution: 0, revealed_article: 0 }; const f = window.fetch;
    window.fetch = (url, init) => { if (String(url).includes('/api/sessions/event')) { const t = JSON.parse(init?.body || '{}').type; if (t in window.__reveals) window.__reveals[t]++; } return f(url, init); }; })()`);
  // Give the statement something to scroll, so the per-tab positions can be told apart.
  await evaluate(`(() => { const d = document.querySelector('#ref-problem .desc'); d.append(Object.assign(document.createElement('div'), { className: 'toolbar-check-pad', style: 'height:3000px' })); document.querySelector('.pcol').scrollTop = 400; })()`);
  await evaluate(`document.querySelector('[data-panel="solution"]').click()`);
  await sleep(300);
  await expectTab('clicking Solution shows it inside the problem pane, statement hidden', 'solution');
  await evaluate(`document.querySelector('[data-panel="problem"]').click()`);
  await sleep(100);
  await expectTab('clicking Problem brings the statement back', 'problem');
  const restored = await evaluate(`document.querySelector('.pcol').scrollTop`);
  if (Math.abs(restored - 400) <= 1) ok('the statement keeps its scroll position across tabs');
  else bad('the statement keeps its scroll position across tabs', `scrollTop ${restored}`);
  await key('s'); await expectTab('s switches to the Solution tab', 'solution');
  await key('a'); await expectTab('a switches to the Article tab', 'article');
  await key('a'); await expectTab('a again returns to Problem', 'problem');
  await key('s'); await key('Escape'); await expectTab('Escape on a reference tab returns to Problem', 'problem');
  if (await evaluate(`location.hash`) === '#/p/contains-duplicate') ok('Escape on a reference tab stays on the problem');
  else bad('Escape on a reference tab stays on the problem', await evaluate(`location.hash`));
  // The coach's open_panel, with the problem pane collapsed (⌘B): the pane comes back on that tab.
  await evaluate(`document.querySelector('.ws-run')?.focus()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 4 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 4 });
  await sleep(150);
  if (!await evaluate(`document.body.classList.contains('hide-problem')`)) bad('⌘B collapses the problem pane', 'still showing');
  const coach = await evaluate(`(async () => {
    const m = await import('/js/coach-actions.js');
    return m.applyAction({ id: 'toolbar-open-panel-' + Date.now(), needsAck: true, tool: 'open_panel', slug: 'contains-duplicate', args: { panel: 'article' } });
  })()`);
  await sleep(300);
  if (coach?.ok) ok('the coach open_panel action answers ok'); else bad('the coach open_panel action answers ok', JSON.stringify(coach));
  await expectTab('the coach open_panel shows the collapsed pane on the Article tab', 'article');
  await evaluate(`document.querySelector('[data-panel="problem"]').click()`);
  // Opens: Solution by click, s, s again (before Escape); Article by a, then the coach.
  const reveals = await evaluate(`({ ...window.__reveals, solutionShown: !!document.querySelector('.ref-tab[data-panel="solution"] pre.solutioncode'), articleShown: !!document.querySelector('.ref-tab[data-panel="article"] .rich') })`);
  const wantSolution = reveals.solutionShown ? 3 : 0, wantArticle = reveals.articleShown ? 2 : 0;
  if (reveals.revealed_solution === wantSolution && reveals.revealed_article === wantArticle) ok(`reveal events logged once per open (solution ${wantSolution}, article ${wantArticle})`);
  else bad('reveal events logged once per open', JSON.stringify(reveals));

  close();
} finally {
  chrome.kill();
  await cleanupScratch();
  await cleanupChrome(chrome, PROFILE);
}

if (problems.length) {
  console.error(`\ntoolbar check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('toolbar ok — order, the Run-opens-the-panel rule, and a Reset that survives being written over');
