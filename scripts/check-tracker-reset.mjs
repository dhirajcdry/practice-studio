import { cleanupChrome } from './chrome-cleanup.mjs';
// A fresh tracker round opens every problem on its starter code, and Undo brings the code back.
//
//   node scripts/check-tracker-reset.mjs
//
// Drives Settings → Problem tracker in a real headless Chrome against a scratch workspace,
// with the problem open: the open editor follows the reset and the undo without a reload,
// neither change is saved back as typing, and the code file moves to the archive and back.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch } from './check-scratch.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = process.env.STUDIO_CHECK_PORT ? Number(process.env.STUDIO_CHECK_PORT) + 5256 : 9348;
const MINE = 'class Solution:\n    def containsDuplicate(self, nums):\n        # my earlier attempt\n        return False\n';
const scratch = await startScratch(Number(process.env.STUDIO_CHECK_PORT) || 4198, 'contains-duplicate', {}, {
  beforeStart: home => fsp.writeFile(path.join(home, 'problems', 'contains-duplicate', 'solution.py'), MINE),
});
const PROFILE = await fsp.mkdtemp(`${os.tmpdir()}/studio-tracker-reset-profile-`);
const codeFile = path.join(scratch.home, 'problems', 'contains-duplicate', 'solution.py');

async function cdp() {
  let targets = null;
  for (let i = 0; i < 50 && !targets; i++) targets = await fetch(`http://127.0.0.1:${PORT}/json`).then(r => r.json(), () => null) ?? (await sleep(200), null);
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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw');
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-background-networking', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

const problems = [];
const check = (ok, what) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) problems.push(what); };
const exists = file => fsp.stat(file).then(() => true, () => false);
try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  const until = async (expression, label) => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression).catch(() => false)) return; await sleep(100); }
    throw new Error(`timed out: ${label}`);
  };
  const buffer = `window.monaco?.editor.getEditors()[0]?.getValue()`;
  await send('Page.navigate', { url: `${scratch.origin}/#/p/contains-duplicate` });
  await until(`(${buffer} || '').includes('my earlier attempt')`, 'editor shows the saved code');
  check(true, 'the problem opens on the code saved before the round');

  await evaluate(`document.querySelector('.set-settings').click()`);
  await until(`!!document.querySelector('.tracker-reset-all:not(:disabled)')`, 'tracker controls');
  await evaluate(`document.querySelector('.tracker-reset-all').click(); document.querySelector('.tracker-reset-all').click()`);
  await until(`document.querySelector('.set-group[aria-label="Problem tracker"]')?.textContent.includes('Tracker reset.') && !document.querySelector('.tracker-restore-all').disabled`, 'reset applied');
  await until(`!(${buffer} || '').includes('my earlier attempt')`, 'editor follows the reset');
  check((await evaluate(buffer)).includes('return len(nums) != len(set(nums))'), 'the open editor switched to the starter without a reload');
  check(/1 problem now opens on starter code/.test(await evaluate(`document.querySelector('.set-group[aria-label="Problem tracker"]').textContent`)), 'Settings says how many problems were reset');
  check(!(await exists(codeFile)), 'the code file left the problem folder');
  const resetAt = (await (await fetch(`${scratch.origin}/api/tracker`)).json()).resetAt;
  const shelved = path.join(scratch.home, 'archive', 'sprint-code', resetAt.replace(/[:.]/g, '-'), 'contains-duplicate', 'solution.py');
  check(await exists(shelved) && (await fsp.readFile(shelved, 'utf8')) === MINE, 'the code is kept in the archive');
  await sleep(1500); // longer than the save debounce: following the server must not save the starter back
  check(!(await exists(codeFile)), 'the starter was not saved back as typing');

  // An unsynced browser draft from before the round must not reopen over the starter.
  await evaluate(`localStorage.setItem('studio.code.v1.contains-duplicate', JSON.stringify({ code: ${JSON.stringify(MINE)}, savedAt: '2020-01-01T00:00:00.000Z', syncedAt: null }))`);
  await send('Page.reload', { ignoreCache: true });
  await until(`(${buffer} || '').includes('return len(nums) != len(set(nums))')`, 'starter after reload with an old draft');
  check(!(await evaluate(`document.body.textContent.includes('Draft restored')`)), 'an old browser draft does not reopen after a reset');
  check(await evaluate(`(localStorage.getItem('studio.code.set-aside.v1.contains-duplicate') || '').includes('my earlier attempt') && !localStorage.getItem('studio.code.v1.contains-duplicate')?.includes('my earlier attempt')`), 'the old draft is set aside in the browser, not deleted');
  await evaluate(`document.querySelector('.set-settings').click()`);
  await until(`!!document.querySelector('.tracker-restore-all:not(:disabled)')`, 'tracker controls after reload');

  await evaluate(`document.querySelector('.tracker-restore-all').click()`);
  await until(`(${buffer} || '').includes('my earlier attempt')`, 'editor follows the undo');
  check(true, 'Undo reset put the code back in the open editor');
  check(await exists(codeFile) && (await fsp.readFile(codeFile, 'utf8')) === MINE, 'Undo reset moved the file back');

  await send('Page.reload', { ignoreCache: true });
  await until(`(${buffer} || '').includes('my earlier attempt')`, 'code after reload');
  check(true, 'a reload after undo still shows the code');
  close();
} catch (err) {
  problems.push(err.message);
  console.error(`could not finish the check: ${err.message}`);
} finally {
  const chromeExited = chrome.exitCode === null && chrome.signalCode === null
    ? new Promise((resolve) => chrome.once('exit', resolve)) : Promise.resolve();
  chrome.kill();
  await chromeExited;
  await scratch.cleanup();
  await cleanupChrome(chrome, PROFILE);
}

if (problems.length) console.error(`tracker reset: ${problems.length} wrong — ${problems.join('; ')}`);
else console.log('tracker reset ok — a fresh round opens on the starter and Undo brings the code back');
process.exit(problems.length ? 1 : 0);
