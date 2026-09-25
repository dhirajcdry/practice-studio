// One results lane at a time, checked in a real browser.
//
//   node scripts/check-lanes.mjs
//
// The verdict panel and the local results used to stack. So one submission left its
// verdict — headline, 64/64, runtime percentile, a Submit again button — sitting on top of
// the pane for the rest of the session, and pressing Run scrolled you to the top of last
// submission's news instead of the run you just asked for. Nothing throws; it is only
// visible by looking.
//
// The rule under test: the pane shows the lane you asked for, and the other collapses to
// one line that says what it is holding.
//
// It never submits anything. `?simsubmit=accepted` is api.js's canned verdict, which is
// rendered entirely in the browser and does not reach the network, let alone LeetCode.
// Its own server against a scratch workspace, so the real one is out of reach.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9338;
const SERVER_PORT = 4182;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-lanes-home-'));
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-lanes-profile-'));
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

try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  // simrun=pass keeps the local run off the runner too, so this check is about the
  // panels and nothing else.
  await send('Page.navigate', { url: `${ORIGIN}/?simsubmit=accepted&simrun=pass#/p/two-sum` });
  const ready = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150 && !window.monaco?.editor?.getEditors?.().length; i++) await sleep(100);
    return Boolean(window.monaco?.editor?.getEditors?.().length);
  })()`);
  if (!ready) throw new Error('the editor never mounted');

  const press = (label) => evaluate(
    `[...document.querySelectorAll('.ws > .ws-bar button')]`
    + `.find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`,
  );
  const settle = (busyLabel) => evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 150; i++) {
      const b = [...document.querySelectorAll('.ws > .ws-bar button')]
        .find(x => x.textContent.trim().startsWith(${JSON.stringify(busyLabel)}));
      if (!b) return true;
      await sleep(100);
    }
    return false;
  })()`);

  // What is actually on screen, by height rather than by class — a lane that is "hidden"
  // but still occupying rows is the bug, not a passing test.
  const seen = () => evaluate(`(() => {
    const box = (sel) => {
      const n = document.querySelector(sel);
      if (!n) return 0;
      return Math.round(n.getBoundingClientRect().height);
    };
    const stubs = [...document.querySelectorAll('.ws-stub')].filter(s => !s.hidden)
      .map(s => s.textContent.replace(/\\s+/g, ' ').trim());
    return {
      verdict: box('.sub'),
      run: box('.rr'),
      stubs,
    };
  })()`);

  /* ---- 1. a verdict, then a run ---- */

  await press('Submit');
  if (!(await settle('Judging'))) throw new Error('the canned verdict never landed');
  await sleep(300);

  const afterSubmit = await seen();
  if (afterSubmit.verdict > 0) ok(`Submit shows the verdict (${afterSubmit.verdict}px)`);
  else bad('Submit shows the verdict', 'the verdict panel has no height');
  if (afterSubmit.run === 0) ok('...and the local lane is folded away while you read it');
  else bad('the local lane folds away on Submit', `.rr is still ${afterSubmit.run}px tall`);

  await press('Run');
  if (!(await settle('Running'))) throw new Error('the canned run never landed');
  await sleep(300);

  const afterRun = await seen();
  if (afterRun.verdict === 0) ok('pressing Run takes the previous verdict off the screen');
  else bad('Run hides the previous verdict', `the verdict panel is still ${afterRun.verdict}px tall — this is the bug`);
  if (afterRun.run > 0) ok(`...and shows the run (${afterRun.run}px)`);
  else bad('Run shows the run', '.rr has no height');

  /* ---- 2. the verdict is not gone, it is one line ---- */

  const stub = afterRun.stubs.find((s) => s.startsWith('Submission'));
  if (!stub) {
    bad('the verdict is still reachable', `no Submission line — stubs: ${JSON.stringify(afterRun.stubs)}`);
  } else if (!stub.includes('Accepted')) {
    bad('the collapsed line says what it is holding', JSON.stringify(stub));
  } else {
    ok(`the verdict collapses to one line: "${stub}"`);
  }

  const stubHeight = await evaluate(
    `Math.round(document.querySelector('.ws-stub:not([hidden])')?.getBoundingClientRect().height ?? 0)`,
  );
  if (stubHeight > 0 && stubHeight < 48) ok(`that line costs ${stubHeight}px, not a panel`);
  else bad('the collapsed lane is one line tall', `${stubHeight}px`);

  /* ---- 3. clicking it brings the verdict back ---- */

  await evaluate(`[...document.querySelectorAll('.ws-stub')].find(s => !s.hidden && s.textContent.includes('Submission')).click()`);
  await sleep(250);
  const back = await seen();
  if (back.verdict > 0 && back.run === 0) ok('clicking the line opens the verdict again, and folds the run');
  else bad('the collapsed line brings its lane back', `verdict=${back.verdict}px run=${back.run}px`);

  const runStub = back.stubs.find((s) => s.startsWith('Local run'));
  if (runStub && /passed/.test(runStub)) ok(`and the run keeps its own line: "${runStub}"`);
  else bad('the folded run says what it is holding', JSON.stringify(back.stubs));

  /* ---- 4. never both, and never neither ---- */

  const bothOpen = back.verdict > 0 && back.run > 0;
  const neitherOpen = back.verdict === 0 && back.run === 0;
  if (bothOpen || neitherOpen) bad('exactly one lane is open', `verdict=${back.verdict} run=${back.run}`);
  else ok('exactly one lane is ever open');

  close();
} finally {
  chrome.kill();
  server.kill();
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

if (problems.length) {
  console.error(`\nlanes check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('lanes ok — Run shows the run, the verdict folds to one line, and one click brings it back');
