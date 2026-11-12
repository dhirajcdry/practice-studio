import { cleanupChrome } from './chrome-cleanup.mjs';
import { problemDir } from '../server/storage-layout.mjs';
// Reload the page while the coach is writing, and see whether the answer survives.
//
//   node scripts/check-coach-reload.mjs
//
// The server tests prove the turn keeps running and can be re-attached to. This proves
// the thing you actually do: refresh mid-answer and find the answer still there, still
// arriving, with the part written before the refresh intact.
//
// Runs against its own server and its own scratch workspace with a fake `claude`, so it
// never touches the real one and never spends a token.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch, requireFreePort } from './check-scratch.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FAKE = path.join(ROOT, 'server', 'coach', 'test', 'bin', 'fake-claude.mjs');
const PORT = 9337;
const SERVER_PORT = Number(process.env.STUDIO_RELOAD_PORT) || 4181;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

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
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

const problems = [];
const ok = (what) => console.log(`  ok   ${what}`);
const bad = (what, detail) => { problems.push(`${what} — ${detail}`); console.log(`  FAIL ${what}: ${detail}`); };

const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-reload-profile-'));

// A coach that writes for eight seconds — long enough to reload in the middle of.
await requireFreePort(PORT);
const { home: HOME, cleanup: cleanupScratch } = await startScratch(SERVER_PORT, 'two-sum', {
  STUDIO_COACH_BINARY: FAKE, FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_DELAY_MS: '8000',
  STUDIO_COACH_PROVIDER: 'claude', STUDIO_CODEX_BINARY: '/nonexistent',
});

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, '--window-size=1500,1000', 'about:blank',
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
    for (let i = 0; i < 150 && !document.querySelector('.coach-compose textarea'); i++) await sleep(100);
  })()`);

  // Ask something, and wait until the first half of the answer is on screen.
  const asked = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // Open it the way a person does. Setting the class by hand skips the app's own
    // setOpen, so the panel is not remembered and comes back closed after the reload —
    // which looks exactly like the answer being lost.
    document.querySelector('.coach-launch')?.click();
    await sleep(100);
    const box = document.querySelector('.coach-compose textarea');
    if (!box) return 'no composer';
    box.value = 'why a hash map?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    for (let i = 0; i < 200; i++) {
      if (document.querySelector('.coach-log')?.textContent.includes('first half')) return 'streaming';
      await sleep(100);
    }
    return 'nothing arrived: '+JSON.stringify({log:document.querySelector('.coach-log')?.textContent,disabled:document.querySelector('.coach-send')?.disabled});
  })()`);
  if (asked !== 'streaming') throw new Error(`the coach never started: ${asked}`);
  ok('the coach is mid-answer');
  const questionCount = await evaluate(`document.querySelectorAll('.coach-log .cmsg.you').length`);
  if (questionCount === 1) ok('one submission renders one question');
  else bad('one submission renders one question', `${questionCount} question cards for one submit`);
  const jumpState = await evaluate(`(() => { const j=document.querySelector('.ui-jump-latest'); return { exists:!!j, hidden:j?.hidden }; })()`);
  if (jumpState.exists && !jumpState.hidden) bad('jump-to-latest starts hidden'); else ok('jump-to-latest starts hidden');

  // The whole point: refresh, right now.
  await send('Page.reload', { ignoreCache: true });
  await sleep(1500);

  const after = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 250; i++) {
      const text = document.querySelector('.coach-log')?.textContent ?? '';
      if (text.includes('second half')) return { state: 'finished', text };
      if (text.includes('first half')) { await sleep(100); continue; }
      await sleep(100);
    }
    return { state: 'lost', text: document.querySelector('.coach-log')?.textContent ?? '' };
  })()`);

  if (after.state === 'finished') {
    ok('after a reload the answer came back and finished on its own');
  } else {
    bad('the answer survives a reload', `the panel never got the rest — "${(after.text || '').slice(0, 120)}"`);
  }

  if ((after.text || '').includes('first half')) ok('...including the half written before the reload');
  else bad('the part written before the reload is still there', 'it is missing');

  // And the workspace has the whole thing, filed once, not as a stopped turn.
  const raw = await fsp.readFile(path.join(problemDir(HOME, 'two-sum'), 'chats.jsonl'), 'utf8').catch(() => '');
  const turns = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (turns.length === 1) ok('filed exactly once');
  else bad('the turn is filed exactly once', `${turns.length} turns in chats.jsonl`);

  if (turns[0]?.answer?.includes('first half') && turns[0]?.answer?.includes('second half')) {
    ok('the transcript has the whole answer');
  } else {
    bad('the transcript has the whole answer', JSON.stringify(turns[0]?.answer ?? null));
  }
  if (turns[0]?.stopped === true) bad('a reload is not a stop', 'the turn was filed as stopped');
  else ok('a reload was not recorded as a stop');

  // Open the problem again once the answer is filed. The next message continues this
  // conversation, so the panel must show it rather than an empty "new chat" screen.
  await send('Page.reload', { ignoreCache: true });
  const reopened = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const read = () => { const log = document.querySelector('.coach-log'); return {
      text: log?.textContent ?? '', questions: log?.querySelectorAll('.cmsg.you').length ?? 0,
      replies: log?.querySelectorAll('.cmsg.reply').length ?? 0, empty: Boolean(log?.querySelector('.coach-empty')) }; };
    for (let i = 0; i < 80; i++) { if (read().text.includes('second half')) break; await sleep(100); }
    await sleep(600); // an adopted finished run must not add a second copy
    return read();
  })()`);
  if (reopened.text.includes('why a hash map?') && reopened.text.includes('second half') && !reopened.empty) ok('reopening the problem shows the conversation it will continue');
  else bad('reopening the problem shows the conversation it will continue', JSON.stringify({ ...reopened, text: reopened.text.slice(0, 120) }));
  if (reopened.questions === 1 && reopened.replies === 1) ok('...drawn once');
  else bad('the restored conversation is drawn once', `${reopened.questions} questions, ${reopened.replies} replies`);

  // Ask again from there: the earlier turn stays above the new one, in the same thread.
  const followUp = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const box = document.querySelector('.coach-compose textarea');
    box.value = 'and the follow-up?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    const log = document.querySelector('.coach-log');
    for (let i = 0; i < 300; i++) {
      if (log.querySelectorAll('.cmsg.reply').length === 2 && (log.textContent.match(/second half/g) || []).length === 2) break;
      await sleep(100);
    }
    await sleep(400);
    return { questions: [...log.querySelectorAll('.cmsg.you')].map(n => n.textContent), replies: log.querySelectorAll('.cmsg.reply').length };
  })()`);
  if (followUp.questions.length === 2 && followUp.questions[0].includes('why a hash map?') && followUp.questions[1].includes('and the follow-up?') && followUp.replies === 2) ok('a follow-up lands under the earlier turn');
  else bad('a follow-up lands under the earlier turn', JSON.stringify(followUp));
  const filed = (await fsp.readFile(path.join(problemDir(HOME, 'two-sum'), 'chats.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (filed.length === 2 && filed[0].sessionId && filed[0].sessionId === filed[1].sessionId) ok('...and both turns are one saved conversation');
  else bad('both turns are one saved conversation', JSON.stringify(filed.map(t => t.sessionId)));

  close();
} finally {
  chrome.kill();
  await cleanupScratch();
  await cleanupChrome(chrome, PROFILE);
}

if (problems.length) {
  console.error(`\ncoach reload check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('coach reload ok — refreshing mid-answer keeps the turn, the text, and the transcript');
