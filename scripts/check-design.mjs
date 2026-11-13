import { cleanupChrome } from './chrome-cleanup.mjs';
import { checkMockTime } from './mock-time-fixture.mjs';
// The design screen mounts, and the whiteboard is really there.
//
//   node scripts/check-design.mjs
//
// The server side is covered by unit tests against a fake CLI. What those cannot see is
// whether 8 MB of vendored Excalidraw actually loads from disk in a browser — the thing
// most likely to be broken by a bad vendoring run, a missing font directory, or a CSP.
// A bundle that imports cleanly in Node and throws in a browser is exactly the failure
// this exists to catch.
//
// It never starts an interview: `?nointerview=1` mounts the screen without a turn, so
// nothing here can reach the `claude` CLI or spend a token.
//
// It also covers the library, resuming and read-only replay, which are the other half
// of this screen and are equally invisible to a unit test: they are a stored interview
// being put back on a real canvas. Those run against seeded interviews in a throwaway
// home, and resuming is safe here for the same reason — reopening an interview replays
// what was already said and asks the model nothing.

import { visualLint } from './visual-lint.js';
import { checkMockVoice } from './mock-voice-fixture.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SERVER_PORT = Number(process.env.STUDIO_CHECK_PORT) || 4187;
const PORT = SERVER_PORT + 5156;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-home-'));
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-profile-'));
// Three interviews that already happened, written straight into the store the way the
// server writes them. The library is a screen about the past, so it cannot be checked on
// an empty disk: the interesting rows are the resumable one and the unfinished one that
// has lost its thread, and neither exists until something has been sat through.
const SEED = [
  {
    id: '2026-07-22T09-15-00-000Z',
    state: {
      prompt: 'Design a URL shortener that serves 100M redirects a day.',
      level: 'L4', minutes: 45, phase: 'bottlenecks',
      startedAt: Date.parse('2026-07-22T09:15:00Z'), endedAt: Date.parse('2026-07-22T10:01:00Z'),
      debriefed: true, claudeSessionId: 'seed-finished',
      turns: [{}, {}, {}],
    },
    turns: [
      { kind: 'opening', asked: 'Design a URL shortener that serves 100M redirects a day.' },
      { kind: 'turn', said: 'I would start with the read path.', asked: 'How do you generate the short code?' },
      { kind: 'debrief', asked: 'Strong on the read path, thin on collisions.' },
    ],
  },
  {
    id: '2026-07-28T18-40-00-000Z',
    state: {
      prompt: 'Design a live leaderboard for a mobile game.',
      level: 'L5', minutes: 45, phase: 'design',
      startedAt: Date.parse('2026-07-28T18:40:00Z'), spentMs: 11 * 60_000,
      pausedAt: Date.parse('2026-07-28T18:51:00Z'),
      debriefed: false, claudeSessionId: 'seed-open',
      turns: [{}, {}],
    },
    turns: [
      { kind: 'opening', asked: 'Design a live leaderboard for a mobile game.' },
      { kind: 'turn', said: 'Top 100 globally, updated in near real time.', asked: 'What is your write volume?' },
    ],
    // A board to come back to: resuming has to put this on the canvas, not an empty one.
    elements: [{
      id: 'seed-rect', type: 'rectangle', x: 120, y: 90, width: 240, height: 110,
      angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
      seed: 1, version: 1, versionNonce: 1, isDeleted: false,
      boundElements: [{ id: 'seed-label', type: 'text' }],
      updated: 1, link: null, locked: false, roundness: null, frameId: null,
    }, {
      id: 'seed-label', type: 'text', x: 160, y: 130, width: 160, height: 25,
      angle: 0, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid',
      strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100, groupIds: [],
      seed: 2, version: 1, versionNonce: 2, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false, roundness: null, frameId: null,
      text: 'Leaderboard', originalText: 'Leaderboard', fontSize: 20, fontFamily: 1,
      textAlign: 'center', verticalAlign: 'middle', containerId: 'seed-rect',
      lineHeight: 1.25, autoResize: true,
    }],
  },
  {
    id: '2026-07-29T21-05-00-000Z',
    state: {
      prompt: 'Design a photo-sharing feed.',
      level: 'L4', minutes: 45, phase: 'requirements',
      startedAt: Date.parse('2026-07-29T21:05:00Z'),
      debriefed: false, claudeSessionId: null,
      turns: [{}],
    },
    turns: [{ kind: 'opening', asked: 'Design a photo-sharing feed.' }],
  },
];

for (const entry of SEED) {
  const dir = path.join(HOME, 'design', entry.id);
  await fsp.mkdir(path.join(dir, 'scenes'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'interview.json'), JSON.stringify(entry.state, null, 2));
  await fsp.writeFile(
    path.join(dir, 'turns.jsonl'),
    entry.turns.map((t) => JSON.stringify({ at: '2026-07-29T21:05:00.000Z', ...t })).join('\n') + '\n',
  );
  if (entry.elements) {
    await fsp.writeFile(
      path.join(dir, 'scenes', '0000.json'),
      JSON.stringify({ at: '2026-07-29T21:05:00.000Z', elements: entry.elements }),
    );
  }
}

const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT,
  env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(SERVER_PORT),
    STUDIO_MIRROR_DIR: '',
    STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'),
    STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'),
    STUDIO_TTS_PYTHON: path.join(ROOT, 'server/tts/test/fake-helper.mjs'),
    STUDIO_TTS_SCRIPT: path.join(ROOT, 'server/tts/test/fake-helper.mjs'),
    STUDIO_TTS_MODEL: path.join(ROOT, 'server/tts/test/fake-helper.mjs'),
    STUDIO_TTS_VOICES: path.join(ROOT, 'server/tts/test/fake-helper.mjs') },
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
  const logs = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(msg.params.exceptionDetails?.exception?.description
        ?? msg.params.exceptionDetails?.text ?? 'exception');
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      logs.push((msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' '));
    }
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
  return { send, evaluate, logs, close: () => ws.close() };
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
  const { send, evaluate, logs, close } = await cdp();
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });

  /* ---- 1. it is reachable from the nav, like every other screen ---- */

  await send('Page.navigate', { url: `${ORIGIN}/#/` });
  await sleep(1200);
  const nav = await evaluate(
    `(() => { const a = document.querySelector('.topnav a[data-route="#/design"]');
       return a ? a.textContent.trim() : null; })()`,
  );
  if (nav) ok(`the nav has a "${nav}" link`);
  else bad('the design screen is reachable from the nav', 'no #/design link in .topnav');

  /* ---- 2. the screen mounts ---- */

  await send('Page.navigate', { url: `${ORIGIN}/?nointerview=1#/design` });
  const mounted = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 200; i++) {
      if (document.querySelector('.dz-view')) return true;
      await sleep(100);
    }
    return false;
  })()`);
  if (mounted) ok('the design screen mounts');
  else bad('the design screen mounts', 'no .dz-view after 20s');

  /* ---- 3. the whiteboard really loaded ---- */

  const board = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 300; i++) {
      const canvas = document.querySelector('.dz-canvas canvas');
      if (canvas) {
        const r = canvas.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height),
                 note: document.querySelector('.dz-loading')?.textContent?.trim() ?? null };
      }
      const failed = document.querySelector('.dz-loading');
      if (failed && /could not be loaded/.test(failed.textContent)) return { failed: failed.textContent.trim() };
      await sleep(100);
    }
    return null;
  })()`);
  if (!board) bad('the whiteboard loads', 'no canvas and no error after 30s');
  else if (board.failed) bad('the whiteboard loads', board.failed.slice(0, 160));
  else if (board.w < 200 || board.h < 150) bad('the whiteboard has room to draw in', `${board.w}x${board.h}`);
  else ok(`Excalidraw is on the page, ${board.w}x${board.h}`);

  const themeMatches = await evaluate(`document.body.classList.contains('is-dark') ===
    Boolean(document.querySelector('.excalidraw.theme--dark'))`);
  if (themeMatches) ok('the whiteboard theme matches the page');
  else bad('the whiteboard theme matches the page', 'light/dark modes disagree');

  /* ---- 4. the pieces of the interview column ---- */

  const parts = await evaluate(`(() => ({
    phases: document.querySelectorAll('.dz-phase').length,
    input: Boolean(document.querySelector('.dz-input')),
    send: Boolean(document.querySelector('.dz-send')),
    done: document.querySelector('.dz-done')?.textContent?.trim() ?? null,
    mic: Boolean(document.querySelector('.dz-mic .vc-talk')),
    logScrolls: (() => {
      const n = document.querySelector('.dz-log');
      if (!n) return null;
      const cs = getComputedStyle(n);
      return { overflow: cs.overflowY, display: cs.display };
    })(),
  }))()`);

  if (parts.phases === 7) ok('all seven interview phases are on the bar');
  else bad('the phase bar is complete', `${parts.phases} chips, expected 7`);

  if (parts.input && parts.send && parts.done) ok(`the answer box, Send and "${parts.done}" are there`);
  else bad('the interview column is complete', JSON.stringify(parts));

  if (parts.mic) ok('dictation is wired in — you can speak your answer');
  else bad('dictation is available', 'no mic control in the compose row');

  // The rule from server/test/css-rules.test.mjs, checked against what the browser
  // actually computed rather than against the stylesheet text.
  if (parts.logScrolls?.overflow === 'auto' && parts.logScrolls.display !== 'flex') {
    ok('the transcript scrolls as block flow, not as a flex column');
  } else {
    bad('the transcript scrolls safely', JSON.stringify(parts.logScrolls));
  }

  /* ---- 5. the library of past interviews ---- */

  await send('Page.navigate', { url: `${ORIGIN}/#/design` });
  const library = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 200; i++) {
      const rows = [...document.querySelectorAll('.th-item')];
      if (rows.length) {
        return {
          rows: rows.length,
          kinds: rows.map((r) => r.querySelector('.th-item-kind')?.textContent.trim()),
          outcomes: rows.map((r) => r.querySelector('.th-pill')?.textContent.trim() ?? null),
          again: rows.filter((r) => r.querySelector('.th-again')).length,
          boxes: [...document.querySelectorAll('.th-pair .th-box h2')].map(n => n.textContent.trim()),
          picks: document.querySelectorAll('.th-box--mock .th-pick[data-slug]').length,
          surprise: document.querySelector('.th-box--mock .th-pick:not([data-slug])')?.getAttribute('aria-pressed'),
          newButton: document.querySelector('.th-box--mock .ci-start')?.textContent.trim() ?? null,
        };
      }
      await sleep(100);
    }
    return { rows: 0, timedOut: true };
  })()`);

  if (library.rows === 3 && library.kinds.every(k => k === 'Mock')) ok('the home lists each saved interview once');
  else bad('the home lists past interviews', JSON.stringify(library).slice(0, 300));

  // Open on an unfinished interview resumes it when it can be resumed (see open()),
  // and reads it back otherwise, so the row promises only that it is unfinished.
  if (library.outcomes.filter(o => o === 'Unfinished').length === 2) ok('each unfinished interview says so');
  else bad('an unfinished interview is marked', JSON.stringify(library));

  if (library.again === 1) ok('only the debriefed interview offers practice from it');
  else bad('the debriefed interview offers practice', JSON.stringify(library));

  if (library.boxes.join() === 'Practise,Mock' && library.picks === 3 && library.surprise === 'true') ok('Practise and Mock each offer a few problems, with "surprise me" chosen');
  else bad('the two boxes render', JSON.stringify(library));

  if (library.newButton) ok(`"${library.newButton}" is one click away`);
  else bad('a new interview can be started from the home', 'no .th-box--mock .ci-start');

  const libShot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.STUDIO_SHOT) {
    await fsp.writeFile(
      process.env.STUDIO_SHOT.replace(/(\.png)?$/i, '-library.png'),
      Buffer.from(libShot.result.data, 'base64'),
    );
  }

  /* ---- 6. resuming restores the board, the transcript and the phase ---- */

  // Reproduce the code-editor → whiteboard path without relying on a cached problem.
  // Monaco's real loader exposes define.amd; UMD dependencies in the Excalidraw bundle
  // must still return their CommonJS exports rather than register with that loader.
  await evaluate(`new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/monaco/vs/loader.js';
    script.onload = () => window.define?.amd ? resolve(true) : reject(new Error('No Monaco AMD loader'));
    script.onerror = () => reject(new Error('Monaco loader failed'));
    document.head.append(script);
  })`);

  // Both unfinished seeds now offer Resume; this row is the one seeded with a live
  // thread and a paused clock, which is what the transcript/phase/clock assertions
  // below actually check. The threadless one is covered separately below.
  await evaluate(`import('/js/drafts.js').then(m => m.saveDraft('design:2026-07-28T18-40-00-000Z', 'Recovered spoken answer'))`);

  const resumed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const live = [...document.querySelectorAll('.th-item')]
      .find((row) => row.querySelector('.th-item-title')?.textContent.includes('live leaderboard'));
    live?.querySelector('.th-item-open')?.click();
    for (let i = 0; i < 300; i++) {
      const canvas = document.querySelector('.dz-view .dz-canvas canvas');
      if (canvas && document.querySelectorAll('.dz-log .dz-entry').length) {
        return {
          entries: document.querySelectorAll('.dz-log .dz-entry').length,
          said: Boolean(document.querySelector('.dz-log .dz-a')),
          phase: document.querySelector('.dz-phase[aria-pressed="true"]')?.textContent.trim() ?? null,
          input: Boolean(document.querySelector('.dz-input')),
          clock: document.querySelector('.dz-clock')?.textContent.trim() ?? null,
        };
      }
      await sleep(100);
    }
    return null;
  })()`);

  if (!resumed) bad('resuming reopens the interview', 'no board and transcript after 30s');
  else {
    if (resumed.entries === 3 && resumed.said) ok('resuming replays the whole transcript, both sides');
    else bad('the transcript comes back', JSON.stringify(resumed));
    if (resumed.phase === 'Design') ok('the phase chip comes back as it was left');
    else bad('the phase is restored', `chip is ${resumed.phase}, expected Design`);
    if (resumed.input) ok('a resumed interview can be carried on');
    else bad('a resumed interview has an answer box', JSON.stringify(resumed));
  }

  // The clock is shifted by the server so time away is not time in the room: this was
  // paused eleven minutes in, and must come back at eleven minutes, not at a day.
  const reading = await evaluate(
    `new Promise(r => setTimeout(() => r(document.querySelector('.dz-clock')?.textContent ?? ''), 1300))`,
  );
  if (/^3[23]:/.test(reading)) ok(`the countdown excludes time away (${reading})`);
  else bad('the resumed countdown excludes time away', `reads ${reading}, expected about 34:00 remaining`);
  console.log('Design mock time controls', await evaluate(`(${checkMockTime.toString()})('design', '/api/design/${SEED[1].id}')`));

  const fontLoaded = await evaluate(`(async () => {
    for (let i = 0; i < 100; i++) {
      if ([...document.fonts].some(font => /Virgil/.test(font.family) && font.status === 'loaded')) return true;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return false;
  })()`);
  if (fontLoaded) ok('the restored text loads its font with Monaco’s AMD loader present');
  else bad('the populated board loads its font', 'Virgil did not load after 10s');

  const resumeShot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.STUDIO_SHOT) {
    await fsp.writeFile(
      process.env.STUDIO_SHOT.replace(/(\.png)?$/i, '-resumed.png'),
      Buffer.from(resumeShot.result.data, 'base64'),
    );
  }

  /* Layout and lifecycle regressions, using only the disposable interview. */
  for (const { id: theme } of (await import('../web/js/themes.js')).THEMES) {
    await evaluate(`import('/js/settings.js').then(m=>m.setSetting('theme', '${theme}'))`);
    await sleep(80);
    const metrics = await evaluate(`(() => {
      const compose=document.querySelector('.dz-compose').getBoundingClientRect();
      const side=document.querySelector('.dz-side').getBoundingClientRect();
      const buttons=[...document.querySelectorAll('.dz-compose .ui-mode-switch')].filter(n=>n.getClientRects().length).map(n=>n.getBoundingClientRect());
      return {fits:buttons.length===1&&buttons.every(b=>b.left>=compose.left&&b.right<=compose.right),bottom:compose.bottom<=side.bottom+1,
        theme:document.body.classList.contains('is-dark')===Boolean(document.querySelector('.excalidraw.theme--dark'))};
    })()`);
    const spacing = await evaluate('(' + visualLint.toString() + ')().filter(x => /^(pane-|workspace-|content-inset)/.test(x.kind))');
    if(spacing.length)bad(theme+': shared pane spacing',JSON.stringify(spacing));
    if(metrics.fits&&metrics.bottom&&metrics.theme)ok(theme+': controls fit, composer stays visible, board theme updates');
    else bad(theme+': layout and live theme',JSON.stringify(metrics));
  }
  for (const width of [1024,768,390]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await sleep(100);
    const fits=await evaluate(`document.documentElement.scrollWidth<=innerWidth && document.querySelector('.dz-input').getBoundingClientRect().width>200 && document.querySelector('.dz-canvas').getBoundingClientRect().height>=300`);
    if(fits)ok(width+'px: board and answer controls remain usable without horizontal overflow');
    else bad(width+'px responsive layout','overflow or undersized controls');
  }
  await send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:1,mobile:false});
  const pauseWorks=await evaluate(`(async()=>{
    document.querySelector('.dz-pause').click();
    for(let i=0;i<100 && document.querySelector('.dz-pause').textContent!=='Resume';i++) await new Promise(r=>setTimeout(r,25));
    const before=document.querySelector('.dz-clock').textContent;
    await new Promise(r=>setTimeout(r,1200));
    const frozen=before===document.querySelector('.dz-clock').textContent;
    const locked=document.querySelector('.dz-input').disabled && document.querySelector('.dz-send').disabled;
    document.querySelector('.dz-pause').click();
    for(let i=0;i<100 && document.querySelector('.dz-pause').textContent!=='Pause';i++) await new Promise(r=>setTimeout(r,25));
    return frozen && locked && !document.querySelector('.dz-input').disabled && document.querySelector('.dz-pause').textContent==='Pause';
  })()`);
  if(pauseWorks)ok('Pause freezes the clock and input; Resume continues the same interview');
  else bad('pause/resume controls','timer or controls did not transition');

  const draftRecovery = await evaluate(`(async () => {
    const original = navigator.mediaDevices.getUserMedia;
    let openings = 0;
    navigator.mediaDevices.getUserMedia = async () => { openings++; throw new Error('Unexpected microphone'); };
    const text = document.querySelector('.dz-input').value;
    document.querySelector('[data-mode="voice"]').click();
    await new Promise(r => setTimeout(r, 100));
    const words = document.querySelector('.dz-voice .voice-transcript');
    const sendVoice = document.querySelector('.dz-voice .dz-voice-send');
    const visible = document.querySelector('.dz-voice .voice-state').textContent === 'Answer not sent' && words.textContent === text && words.getBoundingClientRect().height > 0 && !sendVoice.hidden;
    const micHeld = document.querySelector('.dz-voice .voice-mic').disabled;
    words.click();
    const edited = !document.querySelector('.dz-type').hidden && document.querySelector('.dz-input').value === text;
    document.querySelector('[data-mode="voice"]').click();
    const originalFetch = window.fetch;
    let sent = '';
    window.fetch = (url, options) => String(url) === '/api/design/turn'
      ? (sent = JSON.parse(options.body).said, Promise.resolve(new Response('event: accepted\\ndata: {}\\n\\nevent: done\\ndata: {}\\n\\n', {headers:{'content-type':'text/event-stream'}})))
      : originalFetch(url, options);
    for (let i = 0; i < 100 && sendVoice.disabled; i++) await new Promise(r => setTimeout(r, 25));
    sendVoice.click();
    document.querySelector('[data-mode="type"]').click();
    await new Promise(r => setTimeout(r, 100));
    window.fetch = originalFetch;
    navigator.mediaDevices.getUserMedia = original;
    return text === 'Recovered spoken answer' && visible && micHeld && edited && openings === 0 && sent === text;
  })()`);
  if (draftRecovery) ok('restored voice draft stays in the words, with Send and click-to-edit, and holds the microphone');
  else bad('restored voice draft', 'draft, status, Send/edit, or microphone gate failed');

  const voiceRecovery=await evaluate(`(async()=>{
    const original=navigator.mediaDevices.getUserMedia;
    navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Test permission denied','NotAllowedError');};
    document.querySelector('[data-mode="voice"]').click();
    await new Promise(r=>setTimeout(r,100));
    const panel=document.querySelector('.dz-voice');
    const visible=!panel.hidden && !panel.querySelector('.voice-state').hidden && panel.querySelector('.voice-state').getBoundingClientRect().height>0;
    document.querySelector('[data-mode="type"]').click();
    navigator.mediaDevices.getUserMedia=original;
    return visible && !document.querySelector('.dz-type').hidden;
  })()`);
  if(voiceRecovery)ok('mode switching exposes microphone errors and returns to typing');
  else bad('voice permission recovery','hidden error or inaccessible mode controls');

  const liveModeSwitch=await evaluate(`(async()=>{
    for(let i=0;i<100 && document.querySelector('.dz-done').disabled;i++) await new Promise(r=>setTimeout(r,25));
    const original=window.fetch, encoder=new TextEncoder();
    let chunks=0;
    window.fetch=(url,options)=>String(url)==='/api/design/turn' && JSON.parse(options.body).said==='Switch while replying'
      ?Promise.resolve(new Response(new ReadableStream({async start(controller){
        const emit=(name,data)=>controller.enqueue(encoder.encode('event: '+name+'\\ndata: '+JSON.stringify(data)+'\\n\\n'));
        emit('accepted',{});
        const parts=['Check '+String.fromCharCode(96)+'get_', 'balance'+String.fromCharCode(96)+' and **available', ' funds**.\\n\\n', '- Reject expired holds.\\n\\n'];
        for(let i=0;i<40;i++){emit('token',{text:parts[i%parts.length]});chunks++;await new Promise(r=>setTimeout(r,35));}
        emit('done',{});controller.close();
      }}),{headers:{'content-type':'text/event-stream'}}))
      :original(url,options);
    try {
      const input=document.querySelector('.dz-input');input.value='Switch while replying';input.dispatchEvent(new Event('input'));
      document.querySelector('.dz-actions .dz-send').click();
      for(let i=0;i<100 && chunks<3;i++)await new Promise(r=>setTimeout(r,25));
      document.querySelector('[data-mode="voice"]').click();
      const voiceDuringReply=chunks>0 && chunks<40 && !document.querySelector('.dz-voice').hidden;
      document.querySelector('[data-mode="type"]').click();
      input.value='Unsent next design thought';input.dispatchEvent(new Event('input'));
      for(let i=0;i<150 && (chunks<40 || document.querySelector('.dz-done').disabled);i++)await new Promise(r=>setTimeout(r,25));
      const reply=[...document.querySelectorAll('.dz-q .dz-body')].at(-1);
      const formatted=reply.querySelector('code')?.textContent==='get_balance' && reply.querySelector('strong')?.textContent==='available funds' && reply.querySelectorAll('li').length===10;
      const kept=formatted && voiceDuringReply && !document.querySelector('.dz-type').hidden && input.value==='Unsent next design thought' && !document.querySelector('.dz-done').disabled;
      input.value='';input.dispatchEvent(new Event('input'));return kept;
    } finally {window.fetch=original;}
  })()`);
  if(liveModeSwitch)ok('mode switches during a streamed reply preserve the next unsent draft and finish saving');
  else bad('live mode switching','mode, draft, or saving state did not survive streaming');

  const continuousVoice = await evaluate(`(${checkMockVoice.toString()})('design')`);
  if (continuousVoice) ok('mock continuous microphone, speech interruption, in-flight drafts and mute: ' + JSON.stringify(continuousVoice));
  else bad('mock continuous voice', 'voice fixture did not complete');

  const failedDebrief=await evaluate(`(async()=>{
    for(let i=0;i<100 && document.querySelector('.dz-done').disabled;i++) await new Promise(r=>setTimeout(r,25));
    const original=window.fetch;
    window.fetch=(url,options)=>String(url)==='/api/design/done'
      ?Promise.resolve(new Response(JSON.stringify({error:{message:'Test debrief unavailable'}}),{status:503,headers:{'content-type':'application/json'}}))
      :original(url,options);
    document.querySelector('.dz-done').click();
    await new Promise(r=>setTimeout(r,100));
    window.fetch=original;
    return !document.querySelector('.dz-done').disabled && !document.querySelector('.dz-compose').hidden && [...document.querySelectorAll('.dz-err')].some(node=>node.textContent.includes('Test debrief unavailable'));
  })()`);
  if(failedDebrief)ok('failed debrief leaves the interview open and retryable');
  else bad('failed debrief recovery','interview was incorrectly finalized');
  const complete=await evaluate(`(async()=>{
    const original=window.fetch;
    window.fetch=(url,options)=>String(url)==='/api/design/done'
      ?Promise.resolve(new Response('event: token\\ndata: {"text":"Test debrief"}\\n\\nevent: done\\ndata: {}',{headers:{'content-type':'text/event-stream'}}))
      : String(url).startsWith('/api/design/') ? original(url,options).then(r=>r.json()).then(data=>new Response(JSON.stringify({...data,debriefed:true,report:null}),{headers:{'content-type':'application/json'}})) : original(url,options);
    document.querySelector('.dz-done').click();
    await new Promise(r=>setTimeout(r,300));
    window.fetch=original;
    return document.querySelector('.dz-compose').hidden && document.querySelector('.dz-done').textContent === 'View report';
  })()`);
  if(complete)ok('successful debrief closes the composer, including a final SSE event without a blank line');
  else bad('successful debrief lifecycle','composer still accepts answers');

  if(await evaluate('document.scrollingElement.scrollHeight<=innerHeight+1'))ok('bounded design workspace has no document overflow');
  else bad('workspace scroll ownership','document extends below viewport');

  /* ---- 7. a finished interview opens read-only ---- */

  const review = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.dz-back').click();
    for (let i = 0; i < 200; i++) {
      const open = [...document.querySelectorAll('.th-item')].find(r => r.querySelector('.th-again'))?.querySelector('.th-item-open');
      if (open) { open.click(); break; }
      await sleep(100);
    }
    for (let i = 0; i < 200; i++) {
      if (document.querySelectorAll('.dz-log .dz-entry').length) {
        return {
          entries: document.querySelectorAll('.dz-log .dz-entry').length,
          debrief: Boolean(document.querySelector('.dz-log .dz-d')),
          input: Boolean(document.querySelector('.dz-input')),
          send: Boolean(document.querySelector('.dz-send')),
          board: document.querySelector('.dz-canvas .dz-loading')?.textContent.trim() ?? null,
        };
      }
      await sleep(100);
    }
    return null;
  })()`);

  if (!review) bad('a finished interview opens', 'no transcript after 20s');
  else {
    if (review.entries >= 3 && review.debrief) ok('the finished interview shows its transcript and its debrief');
    else bad('the finished transcript is complete', JSON.stringify(review));
    if (!review.input && !review.send) ok('a debriefed interview is read-only — no answer box');
    else bad('a debriefed interview cannot be added to', JSON.stringify(review));
    if (/board was empty/.test(review.board ?? '')) ok('an interview that drew nothing says the board was empty');
    else bad('an empty board says so', String(review.board).slice(0, 120));
  }

  /* ---- 8. nothing threw ---- */

  const noisy = logs.filter((l) => !/favicon|Failed to load resource/i.test(l));
  if (noisy.length === 0) ok('no uncaught errors while the board loaded');
  else bad('the screen loads clean', noisy.slice(0, 3).join(' | ').slice(0, 300));

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.STUDIO_SHOT) {
    await fsp.writeFile(process.env.STUDIO_SHOT, Buffer.from(shot.result.data, 'base64'));
  }

  close();
} finally {
  chrome.kill();
  server.kill();
  await fsp.rm(HOME, { recursive: true, force: true }).catch(() => {});
  await cleanupChrome(chrome, PROFILE);
}

if (problems.length) {
  console.error(`\ndesign check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('design ok — the board loads from disk and the interview column is wired');
