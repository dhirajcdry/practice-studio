import { cleanupChrome } from './chrome-cleanup.mjs';
import { problemDir } from '../server/storage-layout.mjs';
import { conversationDir } from '../server/coach/native-sessions.mjs';
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
  // One message asks the fake coach to name its chat through the real Studio tool.
  FAKE_CLAUDE_TOOLS_WHEN: 'please name this chat',
  FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{ tool: 'name_chat', arguments: { title: 'Hash map lookups' } }]),
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
  if (!await evaluate(`Boolean(document.querySelector('.coach-log .ui-turn') && document.querySelector('.ui-thread-strip'))`)) throw Error('Missing shared turn or thread strip');
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

  // Reload once the answer is filed and seen. An idle chat is not reopened: the panel
  // lands on the new-chat screen, with that chat first in Recent chats.
  await send('Page.reload', { ignoreCache: true });
  const landing = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.coach-log .recent-chat'); i++) await sleep(100);
    await sleep(600); // nothing late (an adopted run, a restore) may replace it
    const log = document.querySelector('.coach-log');
    const first = log?.querySelector('.recent-chat');
    return { empty: Boolean(log?.querySelector('.coach-empty')), questions: log?.querySelectorAll('.cmsg').length ?? -1,
      first: first?.querySelector('.recent-title')?.textContent ?? null, meta: first?.querySelector('.recent-meta')?.textContent ?? null,
      current: Boolean(log?.querySelector('.recent-chat[aria-current]')), strip: Boolean(document.querySelector('.ui-thread-strip:not([hidden])')) };
  })()`);
  if (landing.empty && landing.questions === 0 && !landing.strip) ok('reloading with an idle chat lands on the new-chat screen');
  else bad('reloading with an idle chat lands on the new-chat screen', JSON.stringify(landing));
  if (landing.first === 'Why a hash map?' && /1 turn/.test(landing.meta || '')) ok('...with that chat first in Recent chats, by its cleaned first question');
  else bad('the idle chat is first in Recent chats', JSON.stringify(landing));
  if (!landing.current) ok('...and no row claims to be current, since the next message starts a new chat');
  else bad('the landing marks no chat current', 'a row is marked current');

  // An unsent draft survives a reload and is shown on the landing screen.
  await evaluate(`(() => { const box = document.querySelector('.coach-compose textarea'); box.value = 'half a thought'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await send('Page.reload', { ignoreCache: true });
  const drafted = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.coach-log .recent-chat'); i++) await sleep(100);
    return { draft: document.querySelector('.coach-compose textarea')?.value ?? null, empty: Boolean(document.querySelector('.coach-empty')) };
  })()`);
  if (drafted.draft === 'half a thought' && drafted.empty) ok('a draft survives the reload, on the landing screen');
  else bad('a draft survives the reload', JSON.stringify(drafted));
  await evaluate(`(() => { const box = document.querySelector('.coach-compose textarea'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);

  // Resuming it from Recent chats shows the whole chat, once, and continues it.
  const resumed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.coach-log .recent-chat').click();
    for (let i = 0; i < 40 && !document.querySelector('.coach-log .cmsg.reply'); i++) await sleep(50);
    const log = document.querySelector('.coach-log');
    return { text: log.textContent, questions: log.querySelectorAll('.cmsg.you').length, replies: log.querySelectorAll('.cmsg.reply').length,
      strip: document.querySelector('.ui-thread-strip strong')?.textContent ?? null };
  })()`);
  if (resumed.text.includes('why a hash map?') && resumed.text.includes('second half') && resumed.questions === 1 && resumed.replies === 1) ok('resuming it from Recent chats shows it, drawn once');
  else bad('resuming from Recent chats shows the chat once', JSON.stringify({ ...resumed, text: resumed.text.slice(0, 120) }));
  if (resumed.strip === 'Why a hash map?') ok('...titled in the strip by the same name');
  else bad('the strip names the resumed chat', JSON.stringify(resumed.strip));

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
  // The same Studio conversation key resumed the same native segment: no new one for a reload.
  const state = JSON.parse(await fsp.readFile(path.join(conversationDir(HOME, `coding:two-sum:${filed[0].sessionId}`), 'state.json'), 'utf8'));
  if (state.segments.length === 1) ok('...in one native segment, not a new one after the reload');
  else bad('the reload does not start a new native segment', JSON.stringify(state.segments.map(x => x.reason)));

  // Back on the landing screen, a message starts a new chat rather than continuing the old one.
  await send('Page.reload', { ignoreCache: true });
  const fresh = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.coach-log .recent-chat'); i++) await sleep(100);
    const box = document.querySelector('.coach-compose textarea');
    box.value = 'a different question';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    for (let i = 0; i < 200 && !document.querySelector('.coach-log')?.textContent.includes('second half'); i++) await sleep(100);
    await sleep(300);
    return { questions: [...document.querySelectorAll('.coach-log .cmsg.you')].map(n => n.textContent) };
  })()`);
  const afterFresh = (await fsp.readFile(path.join(problemDir(HOME, 'two-sum'), 'chats.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (fresh.questions.length === 1 && afterFresh.length === 3 && afterFresh[2].sessionId !== afterFresh[0].sessionId) ok('a message from the landing screen starts a separate chat');
  else bad('a message from the landing screen starts a separate chat', JSON.stringify({ fresh, ids: afterFresh.map(t => t.sessionId) }));
  await send('Page.reload', { ignoreCache: true });
  await evaluate(`(async () => { const sleep = (ms) => new Promise(r => setTimeout(r, ms)); for (let i = 0; i < 80 && document.querySelectorAll('.coach-log .recent-chat').length < 2; i++) await sleep(100); })()`);

  // A reply that finished while no page was open is shown on return, inside its own
  // chat — here an older chat resumed from Recent chats, not the server's latest one.
  const resumedOld = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const row = [...document.querySelectorAll('.coach-log .recent-chat')].find(n => n.textContent.includes('Why a hash map?'));
    if (!row) return 'no row';
    row.click();
    await sleep(200);
    const box = document.querySelector('.coach-compose textarea');
    box.value = 'one more?';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    for (let i = 0; i < 200; i++) { if ((document.querySelector('.coach-log')?.textContent.match(/first half/g) || []).length === 3) return 'streaming'; await sleep(100); }
    return 'never streamed: ' + JSON.stringify({ text: document.querySelector('.coach-log')?.textContent.slice(-300), q: document.querySelectorAll('.coach-log .cmsg.you').length });
  })()`);
  if (resumedOld !== 'streaming') bad('an older chat resumes', resumedOld);
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(9500);
  await send('Page.navigate', { url: `${ORIGIN}/#/p/two-sum` });
  const unseen = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 100; i++) { if (document.querySelectorAll('.coach-log .cmsg.you').length >= 3) break; await sleep(100); }
    await sleep(600);
    const log = document.querySelector('.coach-log');
    return { questions: [...log.querySelectorAll('.cmsg.you')].map(n => n.textContent), empty: Boolean(log.querySelector('.coach-empty')),
      strip: document.querySelector('.ui-thread-strip strong')?.textContent ?? null };
  })()`);
  if (!unseen.empty && unseen.questions.length === 3 && unseen.questions[0].includes('why a hash map?') && unseen.questions[2].includes('one more?') && unseen.strip === 'Why a hash map?') ok('a reply that finished unseen reopens inside its own chat');
  else bad('a reply that finished unseen reopens inside its own chat', JSON.stringify(unseen));

  // Back on the landing screen, a message starts a new chat; the coach names it during
  // that ordinary turn, and the strip and Recent chats show the name.
  await send('Page.navigate', { url: 'about:blank' });
  await sleep(300);
  await send('Page.navigate', { url: `${ORIGIN}/#/p/two-sum` });
  const named = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && !document.querySelector('.coach-log .recent-chat'); i++) await sleep(100);
    const box = document.querySelector('.coach-compose textarea');
    box.value = 'please name this chat';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }));
    let strip = null;
    for (let i = 0; i < 200; i++) {
      strip = document.querySelector('.ui-thread-strip strong')?.textContent ?? null;
      if (strip === 'Hash map lookups' && document.querySelector('.coach-log')?.textContent.includes('Tools said')) break;
      await sleep(100);
    }
    await sleep(300);
    const log = document.querySelector('.coach-log');
    return { strip, questions: log.querySelectorAll('.cmsg.you').length, cards: log.querySelectorAll('.ui-turn-change').length,
      activity: [...log.querySelectorAll('.ui-turn-activity')].map(n => n.hidden ? '' : n.textContent).join('|') };
  })()`);
  if (named.strip === 'Hash map lookups' && named.questions === 1) ok('a message from the landing screen starts a new chat, and the coach names it live');
  else bad('the coach names the new chat live', JSON.stringify(named));
  if (named.cards === 0 && !/note/i.test(named.activity)) ok('...quietly: no receipt card, no activity claim');
  else bad('naming a chat leaves no receipt', JSON.stringify(named));
  const all = (await fsp.readFile(path.join(problemDir(HOME, 'two-sum'), 'chats.jsonl'), 'utf8')).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  if (all.length === 5 && all[4].sessionId && !all.slice(0, 4).some(t => t.sessionId === all[4].sessionId)) ok('...filed as a separate conversation, not a continuation of the old chat');
  else bad('a landing message starts a separate conversation', JSON.stringify(all.map(t => t.sessionId)));

  await send('Page.reload', { ignoreCache: true });
  const listed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 80 && document.querySelectorAll('.coach-log .recent-chat').length < 2; i++) await sleep(100);
    return [...document.querySelectorAll('.coach-log .recent-chat .recent-title')].map(n => n.textContent);
  })()`);
  if (listed[0] === 'Hash map lookups' && listed.includes('Why a hash map?') && listed.includes('A different question')) ok('Recent chats lists the named chat by its name, above the older one');
  else bad('Recent chats shows the coach-given name', JSON.stringify(listed));

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
console.log('coach reload ok — mid-answer reloads keep the reply; idle reloads land on a new chat with the old one in Recent chats');
