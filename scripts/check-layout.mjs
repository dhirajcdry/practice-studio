// Layout regression check for the coach panel.
//
//   node scripts/check-layout.mjs
//
// Optional, and not part of `npm test`: it needs Chrome and a running server. It exists
// because the worst bug in this panel so far was invisible to every other kind of test —
// the log is a flex column that scrolls, its children defaulted to `flex-shrink:1`, and
// once a conversation outgrew the panel every message was squeezed shorter than its own
// text and the lines drew straight through each other. Nothing threw. Nothing failed a
// unit test. It was only visible by looking, and it shipped twice.
//
// So this measures the one thing prose cannot assert about itself: do the boxes overlap.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.STUDIO_ORIGIN || 'http://127.0.0.1:4173';
const PORT = 9333;

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

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TMPDIR || '/tmp'}/studio-layout-check`,
  '--window-size=1600,1000', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();

  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true }); // or you measure yesterday's CSS
  await send('Page.navigate', { url: `${ORIGIN}/#/p/contains-duplicate` });
  await sleep(2500);

  await evaluate(`document.body.classList.add('coach-open')`);
  await sleep(400);

  // A real conversation, built by the panel itself from a stubbed stream — not by hand.
  //
  // The hand-built version wrote `class="cmsg coach"` into the log itself, so it could
  // never catch a wrong class name — it was reproducing the app's markup from memory
  // rather than reading it. Driving the composer means coach.js decides what the DOM is,
  // which is the only version of this check that can disagree with the app.
  //
  // (The clipping this panel actually shipped is caught by check-coach-stream.mjs, which
  // uses a narrow window and a long streamed answer. Both are cheap; keep both.)
  const streamed = await evaluate(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // The composer is built when the panel mounts, which is after Monaco has loaded and
    // well after navigation resolves. Waiting for the element beats guessing at a sleep.
    for (let i = 0; i < 100 && !document.querySelector('.coach-compose textarea'); i++) await sleep(100);
    if (!document.querySelector('.coach-compose textarea')) return 'no composer';
    const line = 'The early return is doing real work here, and it bails the moment it sees a repeat rather than building the whole set first. ';
    const realFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).includes('/api/coach/message')) return realFetch(url, opts);
      const body = new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          for (let n = 0; n < 60; n++) {
            c.enqueue(enc.encode('event: token\\ndata: ' + JSON.stringify({ text: line + (n % 3 === 2 ? '\\n\\n' : '') }) + '\\n\\n'));
          }
          c.enqueue(enc.encode('event: done\\ndata: {}\\n\\n'));
          c.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };
    for (let turn = 0; turn < 3; turn++) {
      const ta = document.querySelector('.coach-compose textarea');
      ta.value = 'question ' + turn;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.coach-send').click();
      // Wait for the turn to *start* before waiting for it to finish; polling 'disabled'
      // straight away reads it before submit() has set it and fires the next question
      // into a panel that is already streaming, which it correctly ignores.
      for (let i = 0; i < 40 && !document.querySelector('.coach-send').disabled; i++) await sleep(50);
      for (let i = 0; i < 80 && document.querySelector('.coach-send').disabled; i++) await sleep(100);
    }
    window.fetch = realFetch;
    return document.querySelectorAll('.coach-log .cmsg').length;
  })()`);
  if (typeof streamed !== 'number') {
    console.error(`could not drive the coach panel: ${streamed ?? 'the page never finished loading'}`);
    process.exit(1);
  }
  await sleep(600);

  const r = await evaluate(`(() => {
    const log = document.querySelector('.coach-log');
    const boxes = [...log.children].map(k => k.getBoundingClientRect());
    let overlaps = 0, worst = 0;
    for (let i = 1; i < boxes.length; i++) {
      const gap = boxes[i].top - boxes[i - 1].bottom;
      if (gap < -0.5) { overlaps++; worst = Math.min(worst, gap); }
    }
    // Nothing inside the log may be shorter than what it contains. Only the log itself
    // is allowed to be overflowed; below it, a box that does not reach the bottom of its
    // own text is text you cannot read — whether it is clipped away or, worse, drawn on
    // top of the message underneath.
    //
    // scrollHeight is NOT the test. A clipped box that is also a flex column reports
    // scrollHeight === clientHeight, because its children shrink instead of overflowing,
    // which is exactly how the two worst bugs in this panel both stayed invisible.
    const clipped = [];
    for (const node of log.querySelectorAll('*')) {
      const parent = node.parentElement;
      if (!parent || parent === log) continue;      // the log is the one that may scroll
      const a = node.getBoundingClientRect();
      const b = parent.getBoundingClientRect();
      if (a.height === 0) continue;                  // hidden on purpose
      const spill = Math.round(a.bottom - b.bottom);
      if (spill > 2) {
        clipped.push((node.className || node.tagName) + ' spills ' + spill + 'px out of ' + (parent.className || parent.tagName));
      }
    }
    log.scrollTop = 1e9;
    return {
      messages: log.children.length,
      overlaps, worst: Math.round(worst),
      clipped: clipped.slice(0, 5),
      scrolls: log.scrollHeight > log.clientHeight + 1,
      reachedBottom: log.scrollTop > 0,
    };
  })()`);

  const problems = [];
  if (r.overlaps > 0) problems.push(`${r.overlaps} messages overlap (worst ${r.worst}px)`);
  if (!r.scrolls) problems.push('the log does not scroll despite overflowing');
  if (!r.reachedBottom) problems.push('the log cannot be scrolled to the bottom');
  if (!r.messages || r.messages < 6) problems.push(`only ${r.messages} messages were rendered — the panel never streamed`);
  for (const c of r.clipped || []) problems.push(`clipped inside the log: ${c}`);

  if (problems.length) {
    failed = true;
    console.error('coach panel FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
  } else {
    console.log('coach panel ok — no overlap, scrolls, reaches bottom');
  }
  close();
} catch (err) {
  failed = true;
  console.error(`could not run the check: ${err.message}`);
  console.error('Chrome and a running studio server are both required.');
} finally {
  chrome.kill();
}

process.exit(failed ? 1 : 0);
