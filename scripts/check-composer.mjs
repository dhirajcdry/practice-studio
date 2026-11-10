// Composer geometry and behavior in real Chrome, with a disposable workspace.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { checkModelPicker } from './check-model-picker.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-composer-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-composer-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4210, DEBUG = PORT + 5255;
const ORIGIN = `http://127.0.0.1:${PORT}`, DEBUG_URL = `http://127.0.0.1:${DEBUG}`;
let server, chrome, socket, sequence = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer });
  socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(code) {
  const result = await send('Runtime.evaluate', {
    expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true,
  });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(check, label) {
  for (let i = 0; i < 180; i++) {
    try { if (await check()) return; } catch {}
    await sleep(100);
  }
  throw Error(`Timed out: ${label}\n${logs}`);
}
async function free(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}
async function viewport(width, height = 900) {
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
}
async function shot(name) {
  const screenshot = await send('Page.captureScreenshot', { format: 'png' });
  await fs.writeFile(`/tmp/studio-composer-${name}.png`, Buffer.from(screenshot.data, 'base64'));
}
async function checkPractice(route, name) {
  await viewport(1440);
  await send('Page.navigate', { url: ORIGIN + route });
  await until(() => evaluate("return !!document.querySelector('.pr-launch')"), `${name} launcher`);
  await evaluate("document.querySelector('.pr-launch button.btn').click()");
  await until(() => evaluate("return !!document.querySelector('.ui-composer')"), `${name} composer`);
  await evaluate(`
    document.querySelector('.pr-compose .ui-mode-switch[data-mode=typed]').click();
  `);
  await until(() => evaluate(`return !document.querySelector('.pr-typed').hidden
    && !document.querySelector('.coach-model-select button')?.disabled`), `${name} typed`);
  const metrics = await evaluate(`
    const rect = s => document.querySelector(s).getBoundingClientRect().toJSON();
    return { header:rect('.ui-workspace-header'), bar:rect('.python-document-bar'),
      shell:rect('.ui-composer'), input:rect('.ui-composer-input'), footer:rect('.ui-composer-footer'),
      overflow:document.scrollingElement.scrollHeight-innerHeight };
  `);
  await shot(`${name}-1440`);
  assert.ok(metrics.header.height <= 52 && metrics.bar.height <= 52, JSON.stringify(metrics));
  assert.ok(metrics.input.top >= metrics.shell.top && metrics.footer.bottom <= metrics.shell.bottom + 1, JSON.stringify(metrics));
  assert.ok(metrics.overflow <= 1, JSON.stringify(metrics));
  const idle = metrics.shell.height;
  assert.ok(idle <= 132, `${name}: idle composer ${idle}px`);
  console.log(name, JSON.stringify({ header:metrics.header.height, bar:metrics.bar.height, idle }));

  await evaluate(`
    const input = document.querySelector('.ui-composer-input'); input.focus();
    input.value = 'one\\ntwo\\nthree\\nfour\\nfive\\nsix\\nseven';
    input.dispatchEvent(new Event('input', { bubbles:true }));
  `);
  const grown = await evaluate("return document.querySelector('.ui-composer').getBoundingClientRect().height");
  assert.ok(grown > idle && grown <= 270, `${name}: grown=${grown}, idle=${idle}`);
  await evaluate(`const input=document.querySelector('.ui-composer-input');input.value='';input.dispatchEvent(new Event('input'));`);
  const cleared = await evaluate("return document.querySelector('.ui-composer').getBoundingClientRect().height");
  assert.ok(cleared <= idle + 4, `${name}: cleared=${cleared}, idle=${idle}`);

  // Exercise the real input handler and fake provider, not a direct endpoint call.
  await evaluate(`
    const input=document.querySelector('.ui-composer-input'); input.value='Which edge case should I verify?';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', ctrlKey:true, bubbles:true }));
  `);
  await until(() => evaluate(`return !!document.querySelector('.pr-answer')?.textContent.trim()
    && document.querySelector('.pr-state').textContent==='Ready when you are'`), `${name} shortcut reply`);
  await evaluate(`
    const thread=document.querySelector('.pr-thread');
    for(let i=0;i<60;i++){const p=document.createElement('p');p.textContent='Earlier reasoning about requirements and ownership.';thread.append(p)}
    thread.scrollTop=100;
  `);
  // Let the real scroll listener mark this as reading history before resizing input.
  await sleep(100);
  await evaluate(`const i=document.querySelector('.ui-composer-input');i.value='A long draft. '.repeat(120);i.dispatchEvent(new Event('input'));`);
  const scroll = await evaluate(`
    const t=document.querySelector('.pr-thread'),c=document.querySelector('.ui-composer');
    return {top:t.scrollTop,range:t.scrollHeight-t.clientHeight,bottom:t.getBoundingClientRect().bottom,
      composer:c.getBoundingClientRect().top,page:document.scrollingElement.scrollHeight-innerHeight};
  `);
  assert.ok(scroll.top === 100 && scroll.range > 100 && scroll.bottom <= scroll.composer + 1 && scroll.page <= 1, JSON.stringify(scroll));
  await evaluate(`const i=document.querySelector('.ui-composer-input');i.value='';i.dispatchEvent(new Event('input'));`);
  await viewport(375, 844);
  await evaluate("document.querySelector('.ui-composer').scrollIntoView({block:'center'})");
  const narrow = await evaluate(`
    const c=document.querySelector('.ui-composer').getBoundingClientRect();
    return {overflow:document.scrollingElement.scrollWidth-innerWidth,right:c.right,
      controls:[...document.querySelectorAll('.ui-composer button')].filter(b=>b.getClientRects().length).every(b=>{
        const r=b.getBoundingClientRect();return r.left>=c.left-1&&r.right<=c.right+1;
      })};
  `);
  await shot(`${name}-375`);
  assert.ok(narrow.overflow <= 1 && narrow.right <= 376 && narrow.controls, JSON.stringify(narrow));
}
try {
  await free(PORT); await free(DEBUG);
  await fs.mkdir(path.join(HOME, 'cache/leetcode'), { recursive: true });
  await fs.writeFile(path.join(HOME, 'coach-settings.json'), JSON.stringify({ provider:'claude', model:'default' }));
  const helper = path.join(ROOT, 'server/tts/test/fake-helper.mjs');
  server = spawn(process.execPath, ['--input-type=module', '--eval',
    "globalThis.fetch=async()=>{throw Error('network disabled')};(await import('./server/index.mjs')).start()"], {
    cwd:ROOT, env:{ ...process.env, STUDIO_HOME:HOME, STUDIO_PORT:String(PORT), STUDIO_MIRROR_DIR:'',
      STUDIO_COACH_BINARY:path.join(ROOT,'server/coach/test/bin/fake-claude.mjs'),
      STUDIO_CODEX_BINARY:path.join(ROOT,'server/coach/test/bin/fake-codex.mjs'),
      STUDIO_TTS_PYTHON:helper, STUDIO_TTS_SCRIPT:helper, STUDIO_TTS_MODEL:helper, STUDIO_TTS_VOICES:helper },
    stdio:['ignore','pipe','pipe'],
  });
  for (const stream of [server.stdout,server.stderr]) stream.on('data', d => { logs=(logs+d).slice(-3000); });
  await until(async () => (await fetch(ORIGIN+'/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new','--disable-background-networking','--no-first-run','--no-default-browser-check',
    `--remote-debugging-port=${DEBUG}`,`--user-data-dir=${PROFILE}`,'about:blank',
  ], { stdio:'ignore' });
  await until(async () => (await fetch(DEBUG_URL+'/json/list')).ok, 'chrome');
  const tab=(await (await fetch(DEBUG_URL+'/json/list')).json()).find(t=>t.type==='page');
  socket=new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));
  socket.addEventListener('message', event => {
    const message=JSON.parse(event.data), waiter=pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);pending.delete(message.id);
    message.error ? waiter.reject(Error(message.error.message)) : waiter.resolve(message.result);
  });
  await send('Page.enable');await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source:
    "Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('No mic','NotAllowedError')}})" });
  await checkPractice('/#/lld','lld');await checkPractice('/#/design','design');
  await checkModelPicker(evaluate, until);
  console.log('ok — composer density, growth/contraction, keyboard send, reading position and narrow containment');
} finally {
  socket?.close();
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  for (const process of [chrome,server]) if (process?.exitCode === null) {
    process.kill();await Promise.race([new Promise(resolve=>process.once('exit',resolve)),sleep(2000)]);
  }
  await fs.rm(HOME,{recursive:true,force:true});await fs.rm(PROFILE,{recursive:true,force:true});
}
