// Actual app screenshots with original fixtures, real Python runs, and scripted coaching.
// --serve keeps a disposable demo open for manual exploration. Default captures and exits.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import crypto from 'node:crypto';
import { SLUG, WRONG_CODE, CODE, EXPLANATION, seedDemo } from './demo/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.STUDIO_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const serve = process.argv.includes('--serve');
const port = Number(process.env.STUDIO_DEMO_PORT || 4196);
let debugPort = Number(process.env.STUDIO_DEMO_CDP_PORT || 0);
const demoToken = crypto.randomUUID();
const origin = `http://127.0.0.1:${port}`;
const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-demo-'));
const demoRoot = path.join(work, 'workspace');
const output = path.join(ROOT, 'docs', 'images');
let server, chrome, ws;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(100);
  }
  throw new Error(message);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), sleep(2000)]);
  if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
}
async function cleanup() {
  ws?.close();
  await stop(chrome);
  await stop(server);
  await fsp.rm(work, { recursive: true, force: true });
}
let interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { interrupted = true; cleanup().then(() => process.exit(0)); });

try {
  const { id } = await seedDemo(demoRoot);
  server = spawn(process.execPath, ['scripts/demo/server.mjs'], {
    cwd: ROOT, env: { ...process.env, STUDIO_HOME: demoRoot, STUDIO_PORT: String(port),
      STUDIO_COACH_BINARY: path.join(ROOT, 'scripts', 'demo', 'coach.mjs'), STUDIO_MIRROR_DIR: '', STUDIO_DEMO_TOKEN: demoToken },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => { serverError = (serverError + chunk).slice(-3000); });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(serverError || 'Demo server exited');
    try { return (await (await fetch(`${origin}/api/demo`)).json()).token === demoToken; } catch { return false; }
  }, 'Demo server did not start');
  if (serve) {
    console.log(`Illustrative demo · scripted coach · disposable workspace\n${origin}/#/p/${SLUG}\n${origin}/#/design/${id}\nPress Ctrl-C to stop and remove demo data.`);
    await once(server, 'exit');
    if (!interrupted) throw new Error('Demo server stopped unexpectedly');
  } else {
    await fsp.access(CHROME);
    chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debugPort}`,
      `--user-data-dir=${path.join(work, 'chrome')}`, '--window-size=1280,800', 'about:blank'], { stdio: 'ignore' });
    chrome.on('error', (error) => console.error(error.message));
    // Trust only the DevTools endpoint written by our fresh, unique Chrome profile.
    await until(async () => {
      try {
        const active = await fsp.readFile(path.join(work, 'chrome', 'DevToolsActivePort'), 'utf8');
        debugPort = Number(active.split('\n')[0]);
        return debugPort > 0;
      } catch { return false; }
    }, 'Our Chrome profile did not expose a DevTools endpoint');
    let target;
    await until(async () => {
      try {
        target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page');
        return Boolean(target);
      } catch { return false; }
    }, 'Chrome did not expose a capture target');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    let seq = 0;
    const pending = new Map();
    const errors = [];
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (pending.has(msg.id)) {
        const { resolve, reject, timer } = pending.get(msg.id);
        clearTimeout(timer); pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails?.exception?.description || JSON.stringify(msg.params.exceptionDetails));
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result?.value;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
    // Demo capture must not fetch live content, submit, or transcribe. Browser fixture
    // navigation is confined to this server; the scripted CLI never uses the network.
    await send('Network.setBlockedURLs', { urls: ['https://*', 'http://leetcode.com/*',
      `${origin}/api/submit*`, `${origin}/api/asr*`] });
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: `
      localStorage.setItem('studio.settings.v1', JSON.stringify({ theme:'slate', codeSize:18, motion:false }));
    ` });
    await send('Page.navigate', { url: `${origin}/#/p/${SLUG}` });
    await until(() => evaluate(`Boolean(window.monaco?.editor.getModels().length && document.querySelector('.ws-run'))`), 'Editor did not mount');
    await evaluate(`document.body.classList.add('coach-open'); document.body.classList.remove('hide-problem');`);
    await fsp.mkdir(output, { recursive: true });
    const frames = [];
    async function shot(name) {
      await evaluate('document.fonts.ready'); await sleep(250);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(output, name);
      await fsp.writeFile(file, Buffer.from(data, 'base64'));
      return file;
    }
    async function frame(label) {
      // Caption is documentation-only, added to capture pages; app code is unmodified.
      await evaluate(`(() => {
        let badge = document.getElementById('demo-disclosure');
        if (!badge) {
          badge = document.createElement('div'); badge.id = 'demo-disclosure';
          badge.style.cssText = 'position:fixed;bottom:12px;left:24px;z-index:10000;padding:10px 16px;background:#e8eaed;color:#131518;border:1px solid #68717d;border-radius:6px;font:13px ui-monospace,monospace;pointer-events:none;box-shadow:0 2px 12px #0004';
          document.body.append(badge);
        }
        badge.textContent = ${JSON.stringify(`ILLUSTRATIVE DEMO · SCRIPTED COACH  /  ${label}`)};
      })()`);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      const file = path.join(work, `frame-${String(frames.length).padStart(2, '0')}.png`);
      await fsp.writeFile(file, Buffer.from(data, 'base64')); frames.push(file);
    }
    await frame('01  Open a problem');
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(WRONG_CODE)})`);
    await frame('02  Write a first approach');
    await evaluate(`document.querySelector('.ws-run').click()`);
    await until(() => evaluate(`!document.querySelector('.ws-run').disabled && document.querySelectorAll('.rr-case').length === 2 && document.querySelectorAll('.rr-case')[0].classList.contains('k-pass') && document.querySelectorAll('.rr-case')[1].classList.contains('k-fail')`), 'First run did not report the intended failure');
    await frame('03  An all-distinct case exposes the bug');
    await evaluate(`window.monaco.editor.getModels()[0].setValue(${JSON.stringify(CODE)})`);
    await evaluate(`document.querySelector('.ws-run').click()`);
    await until(() => evaluate(`!document.querySelector('.ws-run').disabled && /All 2 cases passed/.test(document.body.innerText)`), 'Corrected code did not pass both actual local cases');
    await frame('04  Check before adding · run again');
    await evaluate(`document.getElementById('demo-disclosure').hidden = true`);
    await shot('local-run.png');
    await evaluate(`document.getElementById('demo-disclosure').hidden = false`);
    await until(() => evaluate(`Boolean(document.querySelector('.coach-compose textarea'))`), 'Coach composer did not mount');
    await evaluate(`(() => {
      const input = document.querySelector('.coach-compose textarea');
      input.value = ${JSON.stringify(EXPLANATION)};
      input.dispatchEvent(new Event('input', { bubbles:true }));
    })()`);
    await frame('05  Explain the invariant');
    await evaluate(`document.querySelector('.coach-send').click()`);
    await until(() => evaluate(`/Your next explanation/.test(document.querySelector('.coach-log')?.innerText || '') && !document.querySelector('.coach-send').disabled`), 'Scripted coach did not finish');
    const asks = await evaluate(`document.querySelectorAll('.coach-log .cmsg.you').length`);
    if (asks !== 1) throw new Error(`One submitted question rendered ${asks} times`);
    await evaluate(`document.body.classList.add('hide-problem'); document.querySelector('.coach-log').scrollTop = 0`);
    await frame('06  Get a specific follow-up after passing');
    await evaluate(`document.getElementById('demo-disclosure')?.remove()`);
    await shot('coach.png');
    await send('Page.navigate', { url: `${origin}/#/design/${id}` });
    await until(() => evaluate(`Boolean(document.querySelector('.dz-canvas canvas') && /Where does that cache write/.test(document.querySelector('.dz-log')?.innerText || ''))`), 'Design replay did not mount');
    await sleep(1200);
    await shot('system-design.png');
    // Six deliberate frames, each held long enough to read. No personal recordings.
    const list = path.join(work, 'frames.txt');
    await fsp.writeFile(list, frames.map((file) => `file '${file}'\nduration 3\n`).join('') + `file '${frames.at(-1)}'\n`);
    const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list,
      '-filter_complex', '[0:v]fps=5,scale=1120:-1:flags=lanczos,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer',
      '-loop', '0', path.join(output, 'demo.gif')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let ffmpegError = ''; ffmpeg.stderr.on('data', (chunk) => { ffmpegError += chunk; });
    const [code] = await once(ffmpeg, 'exit');
    if (code !== 0) throw new Error(ffmpegError || 'ffmpeg failed');
    if (errors.length) throw new Error(errors.join('\n'));
    console.log('Captured actual app: coach.png, local-run.png, system-design.png, demo.gif. Both corrected local cases passed. Coaching is scripted.');
  }
} finally {
  await cleanup();
}
