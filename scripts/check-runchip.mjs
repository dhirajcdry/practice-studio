// The standing note about answers being written elsewhere, and its dismiss.
//
//   node scripts/check-runchip.mjs
//
// Ask something, walk to another problem, and a pill appears bottom-right saying an answer
// is being written back there. It had no way to be put away: the only thing that cleared it
// was going to that problem and reading the answer.
//
// The one thing that must be true of the ×: it is not a cancel. A control that looks like a
// cancel and silently is one — or looks like a dismiss and silently cancels — is worse than
// not having it. So this presses it while the coach is mid-sentence and then checks the
// transcript for the WHOLE answer.
//
// Its own server, its own scratch workspace, and a fake `claude`, so it costs nothing and
// cannot reach the real workspace.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE = path.join(ROOT, 'server', 'coach', 'test', 'bin', 'fake-claude.mjs');
const PORT = 9339;
const SERVER_PORT = 4183;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-runchip-home-'));
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-runchip-profile-'));
const realCache = path.join(os.homedir(), 'LeetCodeTutor', 'cache');
if (fs.existsSync(realCache)) {
  await fsp.cp(realCache, path.join(HOME, 'cache'), { recursive: true });
}

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: {
    ...process.env,
    STUDIO_HOME: HOME,
    STUDIO_PORT: String(SERVER_PORT),
    STUDIO_COACH_BINARY: FAKE,
    FAKE_CLAUDE_MODE: 'slow',
    FAKE_CLAUDE_DELAY_MS: '8000',
  },
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

try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  await send('Page.navigate', { url: `${ORIGIN}/#/p/two-sum` });
  await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150 && !document.querySelector('.coach-launch'); i++) await sleep(100);
  })()`);

  const asked = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.coach-launch')?.click();
    await sleep(150);
    const box = document.querySelector('.coach-compose textarea');
    if (!box) return 'no composer';
    box.value = 'why a hash map?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    for (let i = 0; i < 200; i++) {
      if (document.querySelector('.coach-log')?.textContent.includes('first half')) return 'streaming';
      await sleep(100);
    }
    return 'nothing arrived';
  })()`);
  if (asked !== 'streaming') throw new Error(`the coach never started: ${asked}`);

  /* ---- 1. the note appears once you are somewhere else ---- */

  // Walk away, mid-sentence. Not a reload — the note is about a turn this tab started.
  await evaluate(`location.hash = '#/p/contains-duplicate'`);
  const row = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      const r = document.querySelector('.coach-runs:not([hidden]) .coach-run');
      if (r) return r.textContent.replace(/\\s+/g, ' ').trim();
      await sleep(100);
    }
    return null;
  })()`);
  if (row) ok(`the note appears on another problem: "${row}"`);
  else bad('a turn elsewhere is announced', 'no .coach-run row appeared');

  /* ---- 2. it has a dismiss, and the dismiss is reachable ---- */

  const x = await evaluate(`(() => {
    const b = document.querySelector('.coach-run .coach-run-x');
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { label: b.getAttribute('aria-label'), title: b.title, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!x) {
    bad('the note has a close button', 'no .coach-run-x');
  } else {
    ok(`it has a × (${x.w}×${x.h}px) — "${x.title}"`);
    if (x.w >= 20 && x.h >= 20) ok('the × is big enough to hit');
    else bad('the × is big enough to hit', `${x.w}×${x.h}px`);
    if ((x.label ?? '').length > 0) ok(`it says what it does: "${x.label}"`);
    else bad('the × has an accessible name', 'none');
  }

  // Following the row must still work — the × must not have eaten the whole pill.
  const goWidth = await evaluate(`Math.round(document.querySelector('.coach-run .coach-run-go')?.getBoundingClientRect().width ?? 0)`);
  if (goWidth > 80) ok(`the row itself is still the bigger target (${goWidth}px)`);
  else bad('following the note is still the main action', `.coach-run-go is ${goWidth}px wide`);

  /* ---- 3. pressing it takes the note away ---- */

  await evaluate(`document.querySelector('.coach-run .coach-run-x').click()`);
  await sleep(300);
  const gone = await evaluate(`(() => {
    const box = document.querySelector('.coach-runs');
    return !box || box.hidden || box.querySelectorAll('.coach-run').length === 0;
  })()`);
  if (gone) ok('pressing it takes the note away');
  else bad('the × dismisses the note', 'the row is still there');

  /* ---- 4. and it was NOT a cancel ---- */

  const transcript = path.join(HOME, 'problems', 'two-sum', 'chats.jsonl');
  const landed = await (async () => {
    for (let i = 0; i < 200; i += 1) {
      const raw = await fsp.readFile(transcript, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length) return JSON.parse(lines.at(-1));
      await sleep(100);
    }
    return null;
  })();

  if (!landed) {
    bad('the turn finished anyway', 'nothing was ever filed — dismissing killed it');
  } else if (!landed.answer?.includes('second half')) {
    bad('the whole answer was written', `filed only: ${JSON.stringify(landed.answer)}`);
  } else if (landed.stopped === true) {
    bad('dismissing a note is not stopping a turn', 'it was filed as stopped');
  } else {
    ok('the coach kept writing and filed the whole answer — the × is not a cancel');
  }

  // The note is gone, but the answer is not: going back must still show it.
  await evaluate(`location.hash = '#/p/two-sum'`);
  const still = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) {
      const t = document.querySelector('.coach-log')?.textContent ?? '';
      if (t.includes('second half')) return true;
      await sleep(100);
    }
    return false;
  })()`);
  if (still) ok('going back to that problem still shows the answer');
  else bad('the answer survives a dismissed note', 'the panel came back empty');

  close();
} finally {
  chrome.kill();
  server.kill();
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

if (problems.length) {
  console.error(`\nrun-chip check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('run chip ok — the note can be put away, and putting it away is not a cancel');
