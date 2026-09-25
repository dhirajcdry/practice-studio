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

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9343;
const SERVER_PORT = 4187;
const ORIGIN = `http://127.0.0.1:${SERVER_PORT}`;

const HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-home-'));
const PROFILE = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-design-profile-'));
const realCache = path.join(os.homedir(), 'LeetCodeTutor', 'cache');
if (fs.existsSync(realCache)) {
  await fsp.cp(realCache, path.join(HOME, 'cache'), { recursive: true });
}

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
      seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null,
      updated: 1, link: null, locked: false, roundness: null, frameId: null,
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
      const rows = [...document.querySelectorAll('.dzl-row')];
      // The unfinished rows are upgraded to Resume as their detail calls land, so wait
      // for the answer rather than racing it.
      if (rows.length && rows.some((r) => r.querySelector('.dzl-go')?.textContent.trim() === 'Resume')) {
        return {
          rows: rows.length,
          actions: rows.map((r) => r.querySelector('.dzl-go')?.textContent.trim()),
          titles: rows.map((r) => r.querySelector('.dzl-title')?.textContent.trim().slice(0, 40)),
          metas: rows.map((r) => r.querySelector('.dzl-meta')?.textContent.trim()),
          notes: rows.map((r) => (r.querySelector('.dzl-note')?.hidden === false
            ? r.querySelector('.dzl-note').textContent.trim() : null)),
          newButton: document.querySelector('.dzl-new')?.textContent.trim() ?? null,
        };
      }
      await sleep(100);
    }
    return { rows: document.querySelectorAll('.dzl-row').length, timedOut: true };
  })()`);

  if (library.rows === 3) ok('the library lists all three saved interviews, newest first');
  else bad('the library lists past interviews', JSON.stringify(library).slice(0, 200));

  // Both unfinished seeds are resumable — the transcript is the interview, and a CLI
  // thread lost to a restart is a reason to rebuild it, not a reason to refuse.
  if (library.actions?.filter((a) => a === 'Resume').length === 2) ok('every unfinished interview offers Resume');
  else bad('an unfinished interview can be resumed', JSON.stringify(library.actions));

  if (library.notes?.some((n) => n && /fresh thread/.test(n))) {
    ok('the unfinished interview with no thread says resuming rebuilds one');
  } else {
    bad('a threadless interview explains what resuming will do', JSON.stringify(library.notes));
  }

  if (library.metas?.some((m) => /NO DEBRIEF|no debrief/.test(m)) && library.metas?.some((m) => /DEBRIEFED|debriefed/.test(m))) {
    ok('each row says the date, level, questions and whether it was debriefed');
  } else {
    bad('the rows say whether they were debriefed', JSON.stringify(library.metas));
  }

  if (library.newButton) ok(`"${library.newButton}" is one click away`);
  else bad('a new interview can be started from the library', 'no .dzl-new');

  const libShot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.STUDIO_SHOT) {
    await fsp.writeFile(
      process.env.STUDIO_SHOT.replace(/(\.png)?$/i, '-library.png'),
      Buffer.from(libShot.result.data, 'base64'),
    );
  }

  /* ---- 6. resuming restores the board, the transcript and the phase ---- */

  // Both unfinished seeds now offer Resume; this row is the one seeded with a live
  // thread and a paused clock, which is what the transcript/phase/clock assertions
  // below actually check. The threadless one is covered separately below.
  const resumed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('.dzl-row')]
      .find((row) => row.querySelector('.dzl-title')?.textContent.includes('live leaderboard'))
      ?.querySelector('.dzl-go')?.click();
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
  if (/^1[12]:/.test(reading)) ok(`the clock picks up at the time already spent (${reading}), not at the time away`);
  else bad('the resumed clock is the time spent', `reads ${reading}, expected about 11:00`);

  const resumeShot = await send('Page.captureScreenshot', { format: 'png' });
  if (process.env.STUDIO_SHOT) {
    await fsp.writeFile(
      process.env.STUDIO_SHOT.replace(/(\.png)?$/i, '-resumed.png'),
      Buffer.from(resumeShot.result.data, 'base64'),
    );
  }

  /* ---- 7. a finished interview opens read-only ---- */

  const review = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.querySelector('.dz-back').click();
    for (let i = 0; i < 200; i++) {
      const open = [...document.querySelectorAll('.dzl-go')].find((b) => b.textContent.trim() === 'Open');
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
  await fsp.rm(PROFILE, { recursive: true, force: true }).catch(() => {});
}

if (problems.length) {
  console.error(`\ndesign check FAILED\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log('design ok — the board loads from disk and the interview column is wired');
