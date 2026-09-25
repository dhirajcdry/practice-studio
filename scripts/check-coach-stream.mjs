// Reading a long answer while it is still being written.
//
//   node scripts/check-coach-stream.mjs
//
// Two bugs live here, and both were invisible to every other check.
//
// 1. The answer was CLIPPED. A message was `<div class="cmsg coach">`, and the panel
//    around it is `<div class="card coach">` — so every message also matched `.coach`,
//    which is `height:100%; overflow:hidden`. Each answer was pinned to exactly the
//    height of the log and cut off there. Nothing overflowed, so the log had nothing to
//    scroll: the text simply stopped mid-sentence and the wheel did nothing.
//
// 2. The view was DRAGGED BACK. Scroll up mid-stream and the next paint returned you to
//    the bottom, because the re-render briefly emptied the box, the browser clamped
//    scrollTop and fired a scroll event, and the panel read that synthetic scroll as
//    "he is at the bottom, keep following".
//
// Both are only reachable with a real streaming answer several screens tall, so this
// stubs the SSE endpoint and drives the actual composer. It spends no tokens and never
// touches the workspace.

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ORIGIN = process.env.STUDIO_ORIGIN || 'http://127.0.0.1:4173';
const PORT = 9335;

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
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close() };
}

// 1280 wide, not 1600: the coach column has to be narrow enough that a real answer is
// several screens tall. At 1600 the same answer fits and the bug hides.
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TMPDIR || '/tmp'}/studio-stream-check`,
  '--window-size=1280,1000', 'about:blank',
], { stdio: 'ignore' });

let failed = false;
try {
  await sleep(2500);
  const { send, evaluate, close } = await cdp();
  await send('Page.enable');
  await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Page.navigate', { url: `${ORIGIN}/#/p/contains-duplicate` });
  await sleep(2800);

  const r = await evaluate(String.raw`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    document.body.classList.add('coach-open');
    for (let i = 0; i < 100 && !document.querySelector('.coach-compose textarea'); i++) await sleep(100);
    const ta = document.querySelector('.coach-compose textarea');
    if (!ta) return { error: 'the coach panel never mounted' };

    // A long answer, arriving a token at a time over a couple of seconds.
    const LINE = 'The interviewer would stop you here, because the second pass is doing work the first one already paid for. ';
    const realFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (!String(url).includes('/api/coach/message')) return realFetch(url, opts);
      const body = new ReadableStream({
        async start(c) {
          const enc = new TextEncoder();
          for (let n = 0; n < 400; n++) {
            await sleep(8);
            c.enqueue(enc.encode('event: token\ndata: ' + JSON.stringify({ text: LINE + (n % 4 === 3 ? '\n\n' : '') }) + '\n\n'));
          }
          c.enqueue(enc.encode('event: done\ndata: {}\n\n'));
          c.close();
        },
      });
      return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    };

    ta.value = 'why is this two passes?';
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('.coach-send').click();

    const log = document.querySelector('.coach-log');
    await sleep(2400);
    const tall = log.scrollHeight;

    // Scroll up, the way a trackpad does it: a wheel event, then the scroll itself.
    log.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, bubbles: true }));
    log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - 400);
    const placed = log.scrollTop;
    await sleep(1400);                       // several more paints land in here
    const held = log.scrollTop;

    // Back to the bottom by hand: following must resume, or the panel is dead weight.
    log.dispatchEvent(new WheelEvent('wheel', { deltaY: 4000, bubbles: true }));
    log.scrollTop = log.scrollHeight;
    await sleep(900);
    const fromBottom = log.scrollHeight - log.scrollTop - log.clientHeight;

    window.fetch = realFetch;
    return {
      chars: log.innerText.length,
      screens: +(tall / log.clientHeight).toFixed(1),
      placed: Math.round(placed),
      drift: Math.round(held - placed),
      fromBottom: Math.round(fromBottom),
    };
  })()`);

  const problems = [];
  if (r?.error) problems.push(r.error);
  else {
    if (r.chars < 8000) problems.push(`only ${r.chars} characters streamed — the stub never ran`);
    // The clipping bug shows up exactly here: 20k characters that occupy one screen are
    // 20k characters you cannot reach.
    if (r.screens < 3) problems.push(`${r.chars} characters occupy only ${r.screens} screens — the answer is being clipped, not scrolled`);
    if (r.placed <= 0) problems.push('could not scroll up at all');
    if (Math.abs(r.drift) > 40) problems.push(`scrolling up was undone by ${r.drift}px while the answer kept streaming`);
    if (r.fromBottom > 120) problems.push('scrolling back to the bottom did not resume following the stream');
  }

  if (problems.length) {
    failed = true;
    console.error('coach stream FAILED:');
    for (const p of problems) console.error(`  - ${p}`);
  } else {
    console.log(`coach stream ok — ${r.chars} chars over ${r.screens} screens, scroll held, following resumed`);
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
