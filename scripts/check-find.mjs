// ⌘F opens a search box, not a slab, checked in a real browser.
//
//   node scripts/check-find.mjs
//
// The bug this exists to stop coming back: this file's own `.controls` rule — the sticky
// filter bar on the problem list — was a bare class selector, and Monaco's find widget
// builds its three option toggles inside a `<div class="controls">` of its own. So
// pressing ⌘F got Studio's rule: an opaque var(--canvas) background painted straight over
// the search field, `position:sticky` in place of Monaco's absolute placement, 20px of
// padding and negative margins pushing the contents around, and a `::before` band 100vw
// wide thrown across the editor. Nothing threw. The widget was there the whole time, and
// every button in it still worked — you simply could not see the box you were typing in.
//
// Class names cannot be checked by reading CSS, because the collision is between two
// files that never mention each other. The only honest test is to open the widget in a
// browser and ask the page what is actually painted on top of the search field.
//
// It reaches nothing but its own server against a scratch workspace.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9341;
const SERVER_PORT = 4185;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-find-home-'));
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-find-profile-'));
const realCache = path.join(os.homedir(), 'LeetCodeTutor', 'cache');
if (fs.existsSync(realCache)) {
  await fsp.cp(realCache, path.join(HOME, 'cache'), { recursive: true });
}

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(SERVER_PORT) },
  stdio: 'ignore',
});
for (let i = 0; i < 100; i += 1) {
  try { await fetch(`${ORIGIN}/api/stats`); break; } catch { await sleep(100); }
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

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

// Every theme, because the widget's colours are defined per theme and "invisible" is a
// thing that happens in exactly one of them.
const THEMES = ['studio-light', 'studio-slate', 'studio-blueprint', 'studio-phosphor'];

try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  /* ---- 1. the filter bar on the problem list still exists after the rename ---- */

  await send('Page.navigate', { url: `${ORIGIN}/#/` });
  const listed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150; i++) {
      const bar = document.querySelector('.filterbar');
      if (bar) {
        const r = bar.getBoundingClientRect();
        return { h: Math.round(r.height), chips: bar.querySelectorAll('.chip').length,
                 sticky: getComputedStyle(bar).position, stray: document.querySelectorAll('.controls').length };
      }
      await sleep(100);
    }
    return null;
  })()`);
  if (!listed) {
    bad('the problem list still has its filter bar', 'no .filterbar on the page');
  } else if (listed.h < 20 || listed.chips < 4) {
    bad('the filter bar kept its shape through the rename', JSON.stringify(listed));
  } else if (listed.sticky !== 'sticky') {
    bad('the filter bar is still sticky', `position: ${listed.sticky}`);
  } else if (listed.stray > 0) {
    bad('nothing on the list is called .controls any more', `${listed.stray} left`);
  } else {
    ok(`the filter bar survived the rename (${listed.h}px, ${listed.chips} chips, sticky)`);
  }

  /* ---- 2. ⌘F, in every theme ---- */

  await send('Page.navigate', { url: `${ORIGIN}/#/p/two-sum` });
  const ready = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150 && !window.monaco?.editor?.getEditors?.().length; i++) await sleep(100);
    return Boolean(window.monaco?.editor?.getEditors?.().length);
  })()`);
  if (!ready) throw new Error('the editor never mounted');

  for (const theme of THEMES) {
    await evaluate(`window.monaco.editor.setTheme(${JSON.stringify(theme)})`);
    await evaluate(`window.monaco.editor.getEditors()[0].getAction('actions.find').run()`);
    await sleep(400);

    // The question that matters, asked the only way it can be answered: at the middle of
    // the search field, which element does the browser say is on top? If it is anything
    // other than the field itself, something is painted over it — which is the bug, and
    // is invisible to every check that only reads class names or geometry.
    const seen = await evaluate(`(() => {
      const w = document.querySelector('.monaco-editor .find-widget');
      if (!w) return { missing: true };
      const input = w.querySelector('textarea, input.input');
      if (!input) return { noInput: true };
      const r = input.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
      const covered = hit && !input.contains(hit) && hit !== input;
      const wr = w.getBoundingClientRect();
      const hr = document.querySelector('.ws-host').getBoundingClientRect();

      // Monaco's OWN .controls div — the one holding the three option toggles, and the
      // exact element the page's rule collided with. Checked here rather than at the
      // widget, because .find-widget never carried that class: it was this child that
      // got a sticky position, 20px of padding, negative margins and an opaque
      // background, and the widget's overflow:hidden hid the damage from any measurement
      // taken at the outer box.
      const mc = w.querySelector('.controls');
      const mcr = mc?.getBoundingClientRect();
      const mcs = mc ? getComputedStyle(mc) : null;
      const band = mc ? getComputedStyle(mc, '::before').content : 'none';

      const box = (sel) => { const n = w.querySelector(sel); if (!n) return null;
        const b = n.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; };

      const style = getComputedStyle(w);
      const inputStyle = getComputedStyle(input.closest('.monaco-inputbox') ?? input);
      return {
        widget: { w: Math.round(wr.width), h: Math.round(wr.height) },
        hostWidth: Math.round(hr.width),
        inputBox: { w: Math.round(r.width), h: Math.round(r.height) },
        covered, coveredBy: covered ? String(hit.className).slice(0, 60) : null,
        toggleRow: mcr ? { w: Math.round(mcr.width), h: Math.round(mcr.height),
          pos: mcs.position, bg: mcs.backgroundColor, pad: mcs.padding, margin: mcs.margin,
          band: band === 'none' ? null : band } : null,
        widgetPos: style.position,
        widgetBg: style.backgroundColor,
        fieldBg: inputStyle.backgroundColor,
        toggles: w.querySelectorAll('.monaco-custom-toggle').length,
        prev: box('.codicon-find-previous-match'), next: box('.codicon-find-next-match'),
        close: box('.codicon-widget-close'),
        count: box('.matchesCount'),
      };
    })()`);

    const label = theme.replace('studio-', '');
    if (seen.missing || seen.noInput) { bad(`${label}: ⌘F opens a search box`, JSON.stringify(seen)); continue; }

    if (seen.covered) bad(`${label}: nothing is painted over the search field`, `covered by "${seen.coveredBy}" — this is the bug`);
    else ok(`${label}: the search field is the thing on top of the search field`);

    // Monaco's own toggle row, laid out by Monaco: absolute, unpainted, no band, and
    // small. Every one of those was overwritten by the page's rule.
    const row = seen.toggleRow;
    if (!row) {
      bad(`${label}: the option toggles have a row of their own`, 'no .controls inside the widget');
    } else {
      const wrong = [];
      if (row.pos !== 'absolute') wrong.push(`position ${row.pos}`);
      if (row.bg !== 'rgba(0, 0, 0, 0)') wrong.push(`background ${row.bg}`);
      if (row.band) wrong.push(`a ::before band (${row.band})`);
      if (row.margin !== '0px') wrong.push(`margin ${row.margin}`);
      if (row.h > 28) wrong.push(`${row.h}px tall`);
      if (wrong.length) bad(`${label}: the toggle row is Monaco's, not the page's`, wrong.join(', '));
      else ok(`${label}: the toggle row is Monaco's own (absolute, unpainted, ${row.w}×${row.h})`);
    }

    if (seen.widgetPos !== 'absolute') bad(`${label}: Monaco still positions its own widget`, `position: ${seen.widgetPos}`);
    else ok(`${label}: the widget is placed by Monaco (absolute), not by the page`);

    if (seen.widget.w >= seen.hostWidth) {
      bad(`${label}: the widget is a box, not a bar`, `${seen.widget.w}px wide in a ${seen.hostWidth}px editor`);
    } else ok(`${label}: ${seen.widget.w}×${seen.widget.h} box in a ${seen.hostWidth}px editor`);

    if (seen.inputBox.w < 80 || seen.inputBox.h < 14) {
      bad(`${label}: the field is big enough to type in`, `${seen.inputBox.w}×${seen.inputBox.h}`);
    } else ok(`${label}: the field is ${seen.inputBox.w}×${seen.inputBox.h}`);

    // The three toggles were the ONLY thing visible when this was broken. Everything
    // beside them has to be there too, or the widget is still a ghost.
    const parts = { toggles: seen.toggles, prev: seen.prev, next: seen.next, close: seen.close, count: seen.count };
    const absent = Object.entries(parts).filter(([k, v]) => (k === 'toggles' ? v < 3 : !v || v.w === 0));
    if (absent.length) bad(`${label}: the whole widget is there`, `missing: ${absent.map(([k]) => k).join(', ')}`);
    else ok(`${label}: toggles, ◂ ▸, the count and ✕ are all drawn`);

    // A widget the same colour as the code behind it is a widget you cannot see.
    if (seen.fieldBg === seen.widgetBg) {
      bad(`${label}: the field reads as a field`, `field and widget are both ${seen.fieldBg}`);
    } else ok(`${label}: the field is ${seen.fieldBg} against ${seen.widgetBg}`);

    await evaluate(`window.monaco.editor.getEditors()[0].trigger('check', 'closeFindWidget')`);
    await sleep(150);
  }

  close();
} finally {
  chrome.kill();
  server.kill();
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

if (problems.length) {
  console.error(`\nfind check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('find ok — ⌘F opens a real search box in every theme, and the list keeps its filter bar');
