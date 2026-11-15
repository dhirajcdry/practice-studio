import { cleanupChrome } from './chrome-cleanup.mjs';
// The Video tab, checked in a real browser against a local fake player.
//
//   node scripts/check-video.mjs        (STUDIO_CHECK_PORT picks the scratch server port)
//
// The fake (scripts/fake-youtube.mjs) speaks YouTube's embed postMessage protocol from its
// own loopback port, so the player is a real cross-origin frame and nothing reaches the
// network: every https request and YouTube's hosts are blocked, and the check fails if the
// page even asks for one. The scratch workspace keeps the learner's real one out of reach.

import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { startScratch, requireFreePort } from './check-scratch.mjs';
import { startFakeYouTube } from './fake-youtube.mjs';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_PORT = Number(process.env.STUDIO_CHECK_PORT) || 4183;
const PORT = SERVER_PORT + 5300;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;
const SLUG = 'contains-duplicate';
const VIDEO = '3OamzN90kPg'; // the catalog's video id for contains-duplicate

await requireFreePort(PORT);
const fake = await startFakeYouTube();
// A learner-added problem has no walkthrough video; every catalog problem has one.
const { cleanup: cleanupScratch } = await startScratch(SERVER_PORT, SLUG, {}, { beforeStart: home => fsp.writeFile(path.join(home, 'added-problems.json'),
  JSON.stringify([{ leetcodeSlug: 'demo-no-video', leetcodeProblemNumber: null, title: 'Demo Without Video', pattern: null, difficulty: 'Easy', lists: { added: true } }])) });
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-video-profile-'));
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  '--autoplay-policy=user-gesture-required', '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });

const problems = [];
const ok = what => console.log(`  ok   ${what}`);
const bad = (what, detail) => { problems.push(`${what} — ${detail}`); console.log(`  FAIL ${what}: ${detail}`); };
const expect = (what, good, detail = '') => (good ? ok(what) : bad(what, typeof detail === 'string' ? detail : JSON.stringify(detail)));

try {
  let targets = [];
  for (let i = 0; i < 50 && !targets.some(t => t.type === 'page'); i++) {
    await sleep(200);
    try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { /* starting */ }
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise(r => ws.addEventListener('open', r, { once: true }));
  let id = 0;
  const waiting = new Map();
  const requests = [];
  ws.addEventListener('message', e => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Network.requestWillBeSent') requests.push(msg.params.request.url);
  });
  const send = (method, params = {}) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); });
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluate threw');
    return r.result?.result?.value;
  };
  const until = async (expression, label, tries = 100) => {
    for (let i = 0; i < tries; i++) { if (await evaluate(`!!(${expression})`)) return true; await sleep(100); }
    bad(`waited for ${label}`, 'timed out'); return false;
  };
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const center = async selector => evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const clickOn = async selector => { const p = await center(selector); await click(p.x, p.y); };
  const tab = kind => `.problem-tabs [role=tab][data-panel="${kind}"]`;
  // Messages from the player, as the page receives them, and the reveal events it logs.
  const SPY = `(() => { window.__msgs = []; window.__reveals = 0;
    addEventListener('message', e => { try { const d = JSON.parse(e.data); if (d && d.event) window.__msgs.push(d); } catch {} });
    const f = window.fetch; window.fetch = (url, init) => { if (String(url).includes('/api/sessions/event') && JSON.parse(init?.body || '{}').type === 'revealed_video') window.__reveals++; return f(url, init); }; })()`;
  const lastState = `(window.__msgs.filter(m => m.info && Number.isInteger(m.info.playerState)).at(-1)?.info.playerState ?? null)`;
  const stored = `JSON.parse(localStorage.getItem('studio.video.v1:${SLUG}') || 'null')`;

  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Network.setBlockedURLs', { urls: ['https://*', 'http://*.youtube.com/*', 'http://*.youtube-nocookie.com/*', 'http://*.ytimg.com/*', 'http://leetcode.com/*', 'http://neetcode.io/*'] });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: fake.inject({ readyMs: 2500 }) });
  const open = async (hash = `#/p/${SLUG}`) => {
    // Through a blank page, so the same address is a real reload, not a same-document hop.
    await send('Page.navigate', { url: 'about:blank' });
    await sleep(200);
    await send('Page.navigate', { url: `${ORIGIN}/${hash}` });
    await until(`window.monaco?.editor?.getEditors?.().length && document.querySelector('.problem-tabs')`, 'the problem page', 150);
    await evaluate(SPY);
  };
  await open();

  /* ---- 1. before the tab is opened: a tab, and nothing asked of YouTube ---- */
  const labels = await evaluate(`[...document.querySelectorAll('.problem-tabs [role=tab]')].map(n => n.firstChild.textContent.trim())`);
  expect('the tabs are Problem · Solution · Article · Video · Notes', labels.join('|') === 'Problem|Solution|Article|Video|Notes', labels);
  const links = await evaluate(`[...document.querySelectorAll('.pcol .pane-links a')].map(a => a.textContent.trim())`);
  expect('the links row keeps NeetCode and LeetCode and drops the Video link', links.join('|') === 'NeetCode|LeetCode', links);
  await sleep(500);
  const early = requests.filter(u => /youtube|ytimg|googlevideo/.test(u) || u.startsWith(fake.origin));
  expect('nothing is requested from YouTube (or the fake) before the tab is opened', !early.length && !fake.requests.length && !(await evaluate(`document.querySelector('iframe')`)), early.concat(fake.requests));

  /* ---- 2. opening mounts one player, at 16:9, inside the pane ---- */
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-player.is-ready')`, 'the player to answer');
  const mounted = await evaluate(`(() => {
    const frames = document.querySelectorAll('iframe'), f = frames[0], u = new URL(f.src), r = f.getBoundingClientRect(), pane = document.querySelector('.pcol').getBoundingClientRect();
    window.__iframe = f;
    return { count: frames.length, origin: u.origin, path: u.pathname, params: Object.fromEntries(u.searchParams), allow: f.getAttribute('allow'), referrer: f.referrerPolicy, title: f.title,
      ratio: r.width / r.height, inside: r.left >= pane.left - 0.5 && r.right <= pane.right + 0.5 && r.top >= pane.top - 0.5 && r.bottom <= pane.bottom + 0.5,
      statement: !!document.querySelector('#ref-problem')?.isConnected && !document.querySelector('#ref-problem').getClientRects().length,
      selected: document.querySelector('${tab('video')}').getAttribute('aria-selected') };
  })()`);
  expect('one player is mounted from the embed origin with the JS API on', mounted.count === 1 && mounted.origin === fake.origin && mounted.path === `/embed/${VIDEO}`
    && mounted.params.enablejsapi === '1' && mounted.params.origin === ORIGIN && mounted.params.playsinline === '1' && mounted.params.rel === '0' && !('start' in mounted.params), mounted);
  expect('the iframe has a title, a minimal allow list and a referrer policy YouTube accepts', /walkthrough/i.test(mounted.title) && mounted.allow === 'fullscreen; picture-in-picture; encrypted-media' && mounted.referrer === 'strict-origin-when-cross-origin', mounted);
  expect('the player is 16:9, inside the problem pane, and the statement stays in the DOM hidden', Math.abs(mounted.ratio - 16 / 9) < 0.02 && mounted.inside && mounted.statement && mounted.selected === 'true', mounted);
  await sleep(900);
  expect('opening the tab logs one revealed_video once the player is on screen', await evaluate('window.__reveals') === 1, await evaluate('window.__reveals'));
  expect('opening the tab does not start playback', await evaluate(lastState) !== 1, await evaluate(lastState));

  /* ---- 3. the learner plays; focus inside the player is stated ---- */
  await clickOn('.video-player');
  await sleep(1600);
  const playing = await evaluate(`({ state: ${lastState}, active: document.activeElement?.tagName, note: document.querySelector('.video-focus-note')?.textContent || '' })`);
  expect('a click in the player plays it, and the player then has the keyboard', playing.state === 1 && playing.active === 'IFRAME', playing);
  expect('while the player has the keyboard, the tab says so', /Click outside it to use Studio shortcuts/.test(playing.note) && await evaluate(`document.querySelector('.video-focus-note').getClientRects().length > 0`), playing);

  /* ---- 4. switching tabs pauses, keeps the same iframe, saves the place, takes focus back ---- */
  await clickOn(tab('solution'));
  await sleep(700);
  const left = await evaluate(`({ state: ${lastState}, same: document.querySelector('iframe') === window.__iframe, connected: window.__iframe.isConnected,
    hidden: !window.__iframe.getClientRects().length, active: document.activeElement?.tagName, saved: ${stored} })`);
  expect('switching to Solution pauses the player and keeps the same iframe, hidden', left.state === 2 && left.same && left.connected && left.hidden, left);
  expect('...and Studio has the keyboard again', left.active !== 'IFRAME', left);
  expect('...and the position is saved', left.saved && left.saved.t >= 1 && left.saved.d === 300, left.saved);
  await clickOn(tab('video'));
  await sleep(1200);
  const back = await evaluate(`({ state: ${lastState}, same: document.querySelector('iframe') === window.__iframe, reveals: window.__reveals })`);
  expect('coming back resumes the video it paused, in the same iframe', back.state === 1 && back.same, back);
  expect('each open of the tab logs one event (2 so far)', back.reveals === 2, back);
  // Escape steps back to Problem from the Video tab like the other reference tabs (focus is
  // on the tab button here, so Studio hears it), and that pauses the player.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await sleep(700);
  const escaped = await evaluate(`({ tab: document.querySelector('.problem-tabs [aria-selected=true]')?.dataset.panel, state: ${lastState}, hash: location.hash })`);
  expect('Escape on the Video tab returns to Problem, pausing the player', escaped.tab === 'problem' && escaped.state === 2 && escaped.hash === `#/p/${SLUG}`, escaped);
  await clickOn(tab('video'));
  await sleep(1000);

  /* ---- 5. a tab switch made while the player has focus (the coach's open_panel) ---- */
  await clickOn('.video-player'); // pauses (toggle) and focuses the player
  await sleep(400);
  await clickOn('.video-player'); // plays again, focus still inside
  await sleep(600);
  const before5 = await evaluate(`document.activeElement?.tagName`);
  await evaluate(`(async () => { const m = await import('/js/coach-actions.js'); return m.applyAction({ id: 'video-open-panel-' + Date.now(), needsAck: true, tool: 'open_panel', slug: '${SLUG}', args: { panel: 'article' } }); })()`);
  await sleep(700);
  const after5 = await evaluate(`({ active: document.activeElement?.tagName, state: ${lastState}, tab: document.querySelector('.problem-tabs [aria-selected=true]')?.dataset.panel })`);
  expect('a switch made while the player had focus pauses it and gives Studio the keyboard back', before5 === 'IFRAME' && after5.active !== 'IFRAME' && after5.state === 2 && after5.tab === 'article', { before5, ...after5 });

  /* ---- 6. a click outside the player restores shortcuts ---- */
  await clickOn(tab('video'));
  await sleep(900);
  await clickOn('.video-player');
  await sleep(400);
  const inside = await evaluate(`document.activeElement?.tagName`);
  await clickOn('.video-meta');
  await sleep(200);
  const outside = await evaluate(`({ active: document.activeElement?.tagName, focus: document.hasFocus(), note: document.querySelector('.video-focus-note').textContent })`);
  expect('clicking outside the player returns the keyboard to Studio and clears the note', inside === 'IFRAME' && outside.active !== 'IFRAME' && outside.focus && !outside.note, { inside, ...outside });
  // ⌘B now reaches Studio: collapsing the pane pauses, reopening resumes.
  if (await evaluate(lastState) !== 1) { await clickOn('.video-player'); await sleep(500); await clickOn('.video-meta'); await sleep(200); }
  const chord = async () => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 4 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66, modifiers: 4 });
    await sleep(700);
  };
  await chord();
  const collapsed = await evaluate(`({ hidden: document.body.classList.contains('hide-problem'), state: ${lastState}, same: document.querySelector('iframe') === window.__iframe })`);
  expect('collapsing the problem pane (⌘B) pauses the player', collapsed.hidden && collapsed.state === 2 && collapsed.same, collapsed);
  await chord();
  const expanded = await evaluate(`({ hidden: document.body.classList.contains('hide-problem'), state: ${lastState} })`);
  expect('showing the pane again resumes it', !expanded.hidden && expanded.state === 1, expanded);

  /* ---- 7. the learner changes the speed in the player; it is remembered ---- */
  await clickOn('.video-player'); // pause, focus inside
  await sleep(300);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '>', code: 'Period', text: '>', modifiers: 8 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '>', code: 'Period', modifiers: 8 });
  await sleep(400);
  expect('a speed change made in the player is saved for every video', await evaluate(`localStorage.getItem('studio.video.rate.v1')`) === '1.25', await evaluate(`localStorage.getItem('studio.video.rate.v1')`));
  await clickOn('.video-meta');
  const savedBefore = await evaluate(stored);

  /* ---- 8. after a reload: same place, same speed, and still nothing until opened ---- */
  const fakeBefore = fake.requests.length;
  await open();
  await sleep(400);
  expect('after a reload nothing is requested until the tab is opened again', fake.requests.length === fakeBefore && !(await evaluate(`document.querySelector('iframe')`)), fake.requests.slice(fakeBefore));
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-player.is-ready')`, 'the player after reload');
  await sleep(500);
  const resumed = await evaluate(`({ start: new URL(document.querySelector('iframe').src).searchParams.get('start'), time: window.__msgs.find(m => m.event === 'initialDelivery')?.info.currentTime,
    rate: window.__msgs.filter(m => m.info && Number.isFinite(m.info.playbackRate)).at(-1)?.info.playbackRate, state: ${lastState} })`);
  expect('the player resumes at the saved second after a reload', savedBefore && Number(resumed.start) === Math.floor(savedBefore.t) && resumed.time === Math.floor(savedBefore.t), { savedBefore, ...resumed });
  expect('the saved speed is restored', resumed.rate === 1.25, resumed);
  expect('and it waits for a click to play', resumed.state !== 1, resumed);

  /* ---- 9. a finished video starts from the beginning ---- */
  await open();
  await evaluate(`localStorage.setItem('studio.video.v1:${SLUG}', JSON.stringify({ t: 298, d: 300, at: Date.now() }))`);
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-player.is-ready')`, 'the player for a finished video');
  expect('a video watched to the end starts again from the beginning', await evaluate(`new URL(document.querySelector('iframe').src).searchParams.get('start')`) === null, await evaluate(`document.querySelector('iframe').src`));

  /* ---- 10. refused, unavailable, and a player that never loads ---- */
  for (const [code, head] of [[150, 'This video only plays on YouTube'], [101, 'This video only plays on YouTube'], [100, 'This video is no longer available']]) {
    await open();
    await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/error/${code}/'`);
    await clickOn(tab('video'));
    await until(`document.querySelector('.video-fallback')`, `the error ${code} fallback`);
    await sleep(800);
    const shown = await evaluate(`({ head: document.querySelector('.video-fallback h3').textContent, link: document.querySelector('.video-fallback a')?.href || '', iframe: !!document.querySelector('iframe'), reveals: window.__reveals, bar: !!document.querySelector('.video-bar')?.getClientRects().length })`);
    expect(`error ${code}: the tab says so plainly, links to YouTube, and logs nothing`, shown.head === head && shown.link.startsWith(`https://www.youtube.com/watch?v=${VIDEO}`) && !shown.iframe && shown.reveals === 0 && !shown.bar, shown);
  }
  await open();
  await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/silent/'`);
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-fallback')`, 'the load-failure fallback', 60);
  const silent = await evaluate(`({ head: document.querySelector('.video-fallback h3').textContent, retry: [...document.querySelectorAll('.video-fallback button')].map(b => b.textContent).join(), reveals: window.__reveals })`);
  expect('a player that never answers: "The player did not load", with Try again and the YouTube link', silent.head === 'The player did not load' && silent.retry === 'Try again' && silent.reveals === 0, silent);
  await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/embed/'`);
  await evaluate(`document.querySelector('.video-fallback button').click()`);
  await until(`document.querySelector('.video-player.is-ready')`, 'Try again to load the player');
  expect('Try again loads the player', await evaluate(`!!document.querySelector('.video-player.is-ready') && !document.querySelector('.video-fallback')`));
  // Blocked outright (offline, a filter): the same honest fallback.
  await open();
  await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/refuse/'`);
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-fallback')`, 'the blocked fallback', 60);
  expect('an embed whose connection fails (offline, blocked) shows the load-failure fallback', await evaluate(`document.querySelector('.video-fallback h3')?.textContent`) === 'The player did not load');

  /* ---- 11. a pause that never takes: the player is unloaded rather than heard out of sight ---- */
  await open();
  await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/stubborn/'`);
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-player.is-ready')`, 'the stubborn player');
  await clickOn('.video-player');
  await sleep(1200);
  await clickOn(tab('problem'));
  await sleep(2200);
  const stubborn = await evaluate(`({ iframe: !!document.querySelector('iframe'), saved: ${stored} })`);
  expect('a hidden player that keeps playing is unloaded, its place saved', !stubborn.iframe && stubborn.saved?.t >= 1, stubborn);
  await evaluate(`window.__STUDIO_VIDEO_EMBED__.path = '/embed/'`);
  await clickOn(tab('video'));
  await until(`document.querySelector('.video-player.is-ready')`, 'the remounted player');
  expect('...and opening the tab again remounts it at that place', Number(await evaluate(`new URL(document.querySelector('iframe').src).searchParams.get('start')`)) === Math.floor(stubborn.saved.t));

  /* ---- 12. leaving the problem while it plays keeps the place ---- */
  await clickOn('.video-player');
  await sleep(2600);
  const playingAt = await evaluate(`window.__msgs.filter(m => m.info && Number.isFinite(m.info.currentTime)).at(-1)?.info.currentTime`);
  await evaluate(`location.hash = '#/'`);
  await sleep(500);
  const gone = await evaluate(`({ iframe: !!document.querySelector('iframe'), saved: ${stored} })`);
  expect('leaving the problem unloads the player and saves where it was', !gone.iframe && gone.saved && Math.abs(gone.saved.t - playingAt) < 0.6, { playingAt, ...gone });

  /* ---- 13. a problem without a video has no Video tab ---- */
  const plainSlug = await evaluate(`(async () => { const data = await (await fetch('/api/problems')).json(); const list = Array.isArray(data) ? data : data.problems; return list.find(p => !p.youtubeVideoId)?.slug ?? null; })()`);
  if (!plainSlug) bad('the catalog has a problem without a video to check', 'none found');
  await send('Page.navigate', { url: `${ORIGIN}/#/p/${plainSlug}` });
  await until(`document.querySelector('.problem-tabs [role=tab]')`, 'a problem without a video', 150);
  const plain = await evaluate(`[...document.querySelectorAll('.problem-tabs [role=tab]')].map(n => n.firstChild.textContent.trim()).join('|')`);
  expect('a problem without a video has no Video tab', !plain.includes('Video') && plain.startsWith('Problem|Solution|Article'), plain);

  const reached = requests.filter(u => /youtube|ytimg|googlevideo/.test(u));
  expect('no request was ever made to YouTube itself', !reached.length, reached);
  ws.close();
} catch (error) {
  bad('the check ran to the end', error.stack || error.message);
} finally {
  chrome.kill();
  await cleanupScratch();
  await fake.close();
  await cleanupChrome(chrome, PROFILE);
}

if (problems.length) {
  console.error(`\nvideo check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('video ok — lazy embed, one kept player, pause when hidden, remembered place and speed, honest fallbacks');
