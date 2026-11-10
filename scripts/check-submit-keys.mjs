// ⌘↵ sends code to a real judge, so it must only ever do that from the workspace.
//
//   node scripts/check-submit-keys.mjs
//
// Written after ⌘↵ in the interview report's question box asked the question and also
// submitted the buffer: the workspace listened on document, the sheet sits on top of a
// still-mounted workspace, and every earlier check drove the report by clicking.
//
// Real key events through CDP, because synthetic ones cannot show where focus lands when
// a sheet is open. The controls prove the key can fire, so a quiet result means something.
//
// It never submits anything. `?simsubmit=accepted` is api.js's canned verdict, rendered in
// the browser against a scratch workspace, in a profile with no Connector.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch } from './check-scratch.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9347;
const scratch = await startScratch(4197);
const PROFILE = await fsp.mkdtemp(`${os.tmpdir()}/studio-submit-keys-profile-`);
const URL_UNDER_TEST = `${scratch.origin}/?simsubmit=accepted&simrun=pass#/p/contains-duplicate`;

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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw');
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// The real sheet with a real question box; the id names no interview, so nothing can ask.
const OPEN_REPORT = `(async () => {
  const { openReport } = await import('/js/interview-report.js');
  openReport({
    title: 'Contains Duplicate',
    record: { id: 'check-submit-keys', discipline: 'coding', slug: 'contains-duplicate' },
    report: { judgement: null, facts: { durationMs: 60000, phases: [], hints: 0, runs: [], verdicts: [], candidateTurns: 0, candidateWords: 0 } },
    followups: { load: async () => [], send: async (body, emit) => {
      window.reportQuestions = (window.reportQuestions || 0) + 1;
      emit('accepted', {}); emit('token', { text: 'Synthetic report answer.' });
    } },
  });
})()`;

const blur = 'document.activeElement?.blur?.()';
const focus = (selector) => `document.querySelector(${JSON.stringify(selector)}).focus()`;
const active = (selector) => `document.activeElement.matches(${JSON.stringify(selector)})`;
const openSettings = `document.querySelector('.set-settings').click()`;
const openDrawer = `import('/js/problem.js').then(m => m.openPanel({ slug: 'contains-duplicate', title: 'Contains Duplicate' }, 'solution', { instant: true }))`;
const openCoach = `window.dispatchEvent(new Event('studio:open-coach'))`;

// `expect` says the state really is what the case names: a sheet that never opened, or a
// box in a closed panel that leaves focus on the page, would otherwise pass or fail by accident.
const CASES = [
  // Controls: the shortcut the toolbar advertises.
  { what: 'the editor', fires: true, setup: `window.monaco.editor.getEditors()[0].focus()`, expect: `window.monaco.editor.getEditors()[0].hasTextFocus()` },
  { what: 'nothing focused', fires: true, setup: blur, expect: `document.activeElement === document.body` },
  { what: 'a workspace toolbar button', fires: true, setup: focus('.ws-submit'), expect: active('.ws-submit') },
  { what: 'a button beside the statement', fires: true, setup: focus('.pcol button:not(:disabled)'), expect: active('.pcol button') },
  // The bug.
  { what: 'the report question box', fires: false, setup: `${OPEN_REPORT}.then(() => ${focus('.rp-ask-input')})`, expect: active('.rp-sheet[open] .rp-ask-input') },
  { what: 'the report, clicked on its text', fires: false, setup: `${OPEN_REPORT}.then(() => ${blur})`, expect: `Boolean(document.querySelector('.rp-sheet[open]')) && document.activeElement === document.body` },
  // Everything else that sits over or beside a mounted workspace.
  { what: 'the reference drawer', fires: false, setup: `${openDrawer}.then(() => ${blur})`, expect: `!document.querySelector('#drawer').hidden` },
  { what: 'the settings panel', fires: false, setup: `${openSettings}; ${blur}`, expect: `Boolean(document.querySelector('aside.settings'))` },
  { what: 'the header search box', fires: false, setup: focus('#q'), expect: active('#q') },
  { what: 'the coach composer', fires: false, setup: `${openCoach}; ${focus('.coach-input')}`, expect: active('.coach-input') },
  { what: 'a test-case field', fires: false, setup: focus('.tc-input'), expect: active('.tc-input') },
  { what: 'Monaco Find', fires: false, setup: `window.monaco.editor.getEditors()[0].getAction('actions.find').run()`, expect: `!!document.activeElement.closest('.find-widget')` },
  { what: 'a held key in the editor', fires: false, repeat: true, setup: `window.monaco.editor.getEditors()[0].focus()`, expect: `window.monaco.editor.getEditors()[0].hasTextFocus()` },
  { what: 'a held key on Submit', fires: false, repeat: true, setup: focus('.ws-submit'), expect: active('.ws-submit') },
  { what: 'a held key with nothing focused', fires: false, repeat: true, setup: blur, expect: `document.activeElement === document.body` },
  { what: 'Settings with focus left on the editor', fires: false, setup: `${openSettings}; window.monaco.editor.getEditors()[0].focus()`, expect: `!!document.querySelector('aside.settings') && window.monaco.editor.getEditors()[0].hasTextFocus()` },
  { what: 'an already-handled key on Submit', fires: false, setup: `${focus('.ws-submit')}; document.querySelector('.ws-submit').addEventListener('keydown', e => e.preventDefault())`, expect: active('.ws-submit') },
  { what: 'held plain Enter on Submit', fires: false, repeat: true, plain: true, setup: focus('.ws-submit'), expect: active('.ws-submit') },
];

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-background-networking', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

const problems = [];
try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['https://*'] });
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  const pressActionKey = async (action, repeat, modifiers) => {
    const key = action === 'submit'
      ? { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers }
      : { key: "'", code: 'Quote', windowsVirtualKeyCode: 222, modifiers };
    await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key, autoRepeat: !!repeat });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  };
  // By what is on screen: the verdict panel, or the button saying it is judging.
  const acted = action => evaluate(`(() => {
    if (${JSON.stringify(action)} === 'run') return window.keyRuns > 0 || document.querySelector('.ws-run')?.classList.contains('busy');
    const panel = document.querySelector('.sub');
    return Boolean(panel && !panel.hidden && panel.getClientRects().length)
      || document.querySelector('.ws-submit')?.classList.contains('busy');
  })()`);

  for (const action of ['submit', 'run']) for (const modifiers of [4, 2]) for (const { what, fires, setup, expect, repeat, plain } of CASES) {
    if (plain && (action !== 'submit' || modifiers !== 4)) continue;
    await send('Page.navigate', { url: 'about:blank' });
    await send('Page.navigate', { url: URL_UNDER_TEST });
    const ready = await evaluate(`(async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 150; i++) {
        if (window.monaco?.editor?.getEditors?.().length && !document.querySelector('.ws-submit')?.disabled) return true;
        await sleep(100);
      }
      return false;
    })()`);
    if (!ready) throw new Error('the editor never became ready to submit');
    await evaluate(`window.keyRuns = 0; window.addEventListener('studio-interview-work', e => { if (e.detail.type === 'run_result') window.keyRuns++; })`);
    await evaluate(setup);
    await sleep(150);
    if (!(await evaluate(expect))) throw new Error(`could not set up: ${what}`);
    if (await acted(action)) throw new Error(`already acted before pressing anything: ${what}`);
    await pressActionKey(action, repeat, plain ? 0 : modifiers);
    await sleep(600);
    const did = await acted(action);
    const pass = did === fires;
    console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${modifiers === 4 ? '⌘' : 'Ctrl+'}${action === 'submit' ? '↵' : "'"} from ${what}: ${did ? action : 'no action'}`);
    if (!pass) problems.push(`${action}: ${what}`);
  }
  // The report still owns Send; preventing accidental judge actions must not turn
  // it into a dead shortcut. A repeated key must preserve the next unsent draft.
  for (const modifiers of [4, 2]) {
    await evaluate(OPEN_REPORT);
    await evaluate(`(() => { window.reportQuestions = 0; const input=document.querySelector('.rp-sheet[open] .rp-ask-input');
      input.value='Explain the report'; input.dispatchEvent(new Event('input')); input.focus(); })()`);
    await pressActionKey('submit', false, modifiers);
    await sleep(100);
    if (await evaluate('window.reportQuestions') !== 1) problems.push('report shortcut did not send exactly once');
    await evaluate(`(() => { const input=document.querySelector('.rp-sheet[open] .rp-ask-input'); input.value='Unsent next question'; input.dispatchEvent(new Event('input')); input.focus(); })()`);
    await pressActionKey('submit', true, modifiers);
    if (await evaluate('window.reportQuestions') !== 1 || await evaluate("document.querySelector('.rp-sheet[open] .rp-ask-input').value") !== 'Unsent next question') problems.push('held report shortcut sent another question');
    if (await acted('submit')) problems.push('report question also submitted code');
    // Native close events are queued: let the old sheet dispose before opening the next one.
    await evaluate("document.querySelector('.rp-sheet[open]').close()");
    await evaluate("(async()=>{ for(let i=0;i<50;i++){if(!document.querySelector('.rp-sheet'))return;await new Promise(r=>setTimeout(r,20));}throw Error('Previous report did not dispose');})()");
  }
  close();
} catch (err) {
  problems.push(err.message);
  console.error(`could not finish the check: ${err.message}`);
} finally {
  // Chrome keeps writing its profile while it shuts down; deleting it underneath fails ENOTEMPTY.
  const chromeExited = chrome.exitCode === null && chrome.signalCode === null
    ? new Promise((resolve) => chrome.once('exit', resolve)) : Promise.resolve();
  chrome.kill();
  await chromeExited;
  await scratch.cleanup();
  await fsp.rm(PROFILE, { recursive: true, force: true, maxRetries: 5 });
}

if (problems.length) console.error(`submit keys: ${problems.length} wrong — ${problems.join('; ')}`);
else console.log('action keys ok — Cmd/Ctrl Submit and Run stay in their owning workspace');
process.exit(problems.length ? 1 : 0);
