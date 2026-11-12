import { cleanupChrome } from './chrome-cleanup.mjs';
// LLD layout regression: real Chrome/CDP, scratch home, fake interviewer only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { DesignStore } from '../server/design/store.mjs';
import { problemDir } from '../server/storage-layout.mjs';
import { MAX_TIMER_RUN_MS } from '../server/practice/timer.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-practice-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-practice-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4202, DEBUG = PORT + 5255;
const ORIGIN = `http://127.0.0.1:${PORT}`, DEBUG_URL = `http://127.0.0.1:${DEBUG}`;
let server, chrome, socket, seq = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, label) { for (let i = 0; i < 180; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`Timed out: ${label}\n${logs}`); }
async function reload() {
  const previous = await evaluate('return performance.timeOrigin');
  await send('Page.reload');
  await until(() => evaluate(`return performance.timeOrigin!==${previous} && document.readyState==='complete'`), 'new document loaded');
}
async function free(port) { await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); }); }

try {
  await free(PORT); await free(DEBUG); await fs.mkdir(path.join(HOME, 'cache/leetcode'), { recursive: true });
  await fs.writeFile(path.join(HOME, 'coach-settings.json'), JSON.stringify({provider:'claude',model:'default'}));
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch=async()=>{throw Error('network disabled')}; (await import('./server/index.mjs')).start();"], { cwd: ROOT, env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(PORT), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'), STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'), STUDIO_TTS_PYTHON: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_SCRIPT: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), FAKE_INTERVIEW_TOKEN_MS: '8', FAKE_CLAUDE_MODE: 'slow', FAKE_CLAUDE_ECHO_WHEN: 'Verify package-size tool continuation', FAKE_CLAUDE_TOOLS_WHEN: 'Define my custom practice topic', FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([{tool:'set_practice_problem',arguments:{title:'Inventory repair',statement:'Track replacement parts; reject duplicate reservations.'}}]), FAKE_CLAUDE_DELAY_MS: '4000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + d).slice(-3000); });
  await until(async () => (await fetch(ORIGIN + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_REVIEW === '1' ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(DEBUG_URL + '/json/list')).ok, 'chrome');
  const tab = (await (await fetch(DEBUG_URL + '/json/list')).json()).find(x => x.type === 'page'); socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('No mic','NotAllowedError')}});" });
  const issues = [];
  socket.addEventListener('message', event => { const m = JSON.parse(event.data); if (m.method === 'Runtime.exceptionThrown') issues.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text); });
  async function mode(label) {
    await evaluate(`document.querySelector('.pr-compose .ui-mode-switch[data-mode=${label.toLowerCase()}]').click();`);
  }
  async function shot(name) { const s = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(`/tmp/studio-practice-${name}.png`, Buffer.from(s.data, 'base64')); }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: ORIGIN + '/#/lld' });
  await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'LLD launcher');
  await evaluate("document.querySelector('.th-practice').click()");
  await until(() => evaluate("return !!document.querySelector('.pr-coach') && !!window.monaco?.editor.getModels().length"), 'practice editor');
  // The work/coach split is a real divider: keyboard and pointer resizing must
  // preserve the editor instance and keep both panes usable.
  const split = await evaluate("return document.querySelector('.ui-pane-divider,.split.split-col')?.getAttribute('aria-label') || null");
  assert.ok(split, 'practice exposes an accessible work/coach divider');
  const beforeSplit = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect(),c=s.children[1].getBoundingClientRect();return {work:w.width,coach:c.width,model:window.monaco.editor.getModels()[0]?.uri.toString()}");
  await evaluate("const d=document.querySelector('.ui-pane-divider,.split.split-col');d.focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));");
  await sleep(80);
  const afterKeyboard = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect(),c=s.children[1].getBoundingClientRect();return {work:w.width,coach:c.width,model:window.monaco.editor.getModels()[0]?.uri.toString()}");
  assert.ok(afterKeyboard.work > beforeSplit.work + 20, 'keyboard divider grows work pane');
  assert.ok(afterKeyboard.coach < beforeSplit.coach - 20, 'keyboard divider shrinks coach pane');
  assert.equal(afterKeyboard.model, beforeSplit.model, 'resizing does not recreate Monaco');
  const savedSplit = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect(),c=s.children[1].getBoundingClientRect();return {work:w.width,coach:c.width}");
  await reload();
  await until(() => evaluate("return !!document.querySelector('.pr-coach') && !!window.monaco?.editor.getModels().length"), 'practice split reload');
  const reloadedSplit = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect(),c=s.children[1].getBoundingClientRect();return {work:w.width,coach:c.width}");
  assert.ok(Math.abs(reloadedSplit.work - savedSplit.work) < 8, 'practice split preference survives reload');
  await evaluate("const d=document.querySelector('.ui-pane-divider,.split.split-col');d.focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));");
  await sleep(80);
  const resetSplit = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect(),c=s.children[1].getBoundingClientRect();return {work:w.width,coach:c.width}");
  assert.ok(resetSplit.work < reloadedSplit.work, 'Home returns divider toward minimum work width');
  const grip = await evaluate("return document.querySelector('.ui-pane-divider').getBoundingClientRect().toJSON()");
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: grip.left + grip.width / 2, y: grip.top + 80, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: grip.left + 260, y: grip.top + 80, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: grip.left + 260, y: grip.top + 80, button: 'left', clickCount: 1 });
  assert.ok(await evaluate(`return document.querySelector('.pr-work').getBoundingClientRect().width > ${resetSplit.work} + 200`), 'real pointer drag reallocates workspace');
  assert.equal(await evaluate("return document.body.classList.contains('is-splitting')"), false, 'pointer release clears drag state');
  await evaluate("document.querySelector('.ui-pane-divider').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
  assert.ok(await evaluate(`return Math.abs(document.querySelector('.pr-work').getBoundingClientRect().width-${beforeSplit.work})<3`), 'double click resets default proportions');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate("const d=document.querySelector('.ui-pane-divider');return d.hidden && getComputedStyle(d).display==='none'"), 'stacked practice hides divider');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await sleep(80);
  await until(() => evaluate("const d=document.querySelector('.ui-pane-divider');return !d.hidden && getComputedStyle(d).display!=='none'"), 'desktop practice restores divider');
  const address = await evaluate('return location.hash;');
  assert.ok(address.includes('/practice/'));
  assert.equal(await evaluate("return document.querySelector('.pr-typed').hidden"), true, 'voice is default');
  assert.equal(await evaluate("return document.querySelectorAll('.pr-exchange').length"), 0, 'opening practice makes no model turn');
  assert.equal(await evaluate("return document.querySelector('.pr-timer-label').textContent"), 'Paused', 'new practice starts paused');
  await sleep(1100);
  assert.equal(await evaluate("return document.querySelector('.pr-timer-value').textContent"), '00:00', 'opening practice never starts tracking');
  await evaluate("document.querySelector('[aria-label=\"Start practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Pause practice timer\"]:not(:disabled)')"), 'explicit start');
  const initialTime = await evaluate("return document.querySelector('.pr-timer-value').textContent");
  await until(() => evaluate(`return document.querySelector('.pr-timer-value').textContent!==${JSON.stringify(initialTime)}`), 'practice timer ticks');
  await evaluate("document.querySelector('[aria-label=\"Pause practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Resume practice timer\"]:not(:disabled)')"), 'pause persisted');
  const pausedTime = await evaluate("return document.querySelector('.pr-timer-value').textContent");
  await sleep(1100);
  assert.equal(await evaluate("return document.querySelector('.pr-timer-value').textContent"), pausedTime, 'paused time stays fixed');
  await reload();
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Resume practice timer\"]') && !!window.monaco?.editor.getModels().length"), 'paused timer reload');
  assert.equal(await evaluate("return document.querySelector('.pr-timer-value').textContent"), pausedTime, 'refresh preserves paused total');
  await evaluate("document.querySelector('[aria-label=\"Resume practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Pause practice timer\"]:not(:disabled)')"), 'resume persisted');
  await until(() => evaluate(`return document.querySelector('.pr-timer-value').textContent!==${JSON.stringify(pausedTime)}`), 'resumed timer ticks');
  await evaluate("const original=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).endsWith('/timer')){window.fetch=original;throw Error('Synthetic timer save failure');}return original(...args);};document.querySelector('[aria-label=\"Pause practice timer\"]').click()");
  await until(() => evaluate("return !document.querySelector('.pr-timer-error').hidden && !document.querySelector('.pr-timer button').disabled"), 'timer failure is visible');
  assert.equal(await evaluate("return document.querySelector('.pr-timer-label').textContent"), 'Elapsed', 'failed pause does not pretend to be saved');
  await evaluate("document.querySelector('[aria-label=\"Pause practice timer\"]').click()");
  await until(() => evaluate("return document.querySelector('.pr-timer-label').textContent==='Paused' && document.querySelector('.pr-timer-error').hidden"), 'timer pause can be retried');
  await evaluate("document.querySelector('[aria-label=\"Resume practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Pause practice timer\"]:not(:disabled)')"), 'start before hiding');
  await evaluate("Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));");
  await until(() => evaluate("return document.querySelector('.pr-timer-label').textContent==='Paused'"), 'hidden practice pauses');
  await evaluate("delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));");
  assert.equal(await evaluate("return document.querySelector('.pr-timer-label').textContent"), 'Paused', 'showing page does not resume');
  await evaluate("document.querySelector('[aria-label=\"Resume practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Pause practice timer\"]:not(:disabled)')"), 'start before reload');
  await reload();
  await until(() => evaluate("return document.querySelector('.pr-timer-label')?.textContent==='Paused'"), 'reload stops practice timer');
  assert.equal(await evaluate("const {formatPracticeTime}=await import('/js/practice-timer.js');return formatPracticeTime(3_661_000)"), '1:01:01', 'long sessions show hours');
  // Seed a still-live scratch timer just before its hard limit. Resume reads that
  // existing run without resetting it; the real UI must stop at the server cutoff.
  const [, , , timedSlug, timedId] = address.split('/');
  const timedFile = path.join(problemDir(HOME, timedSlug), 'practice', timedId, 'session.json');
  const nearLimit = JSON.parse(await fs.readFile(timedFile));
  const cutoff = Date.now() + 3000;
  nearLimit.timer = { elapsedMs: 0, runningSince: cutoff - MAX_TIMER_RUN_MS, leaseUntil: cutoff + 30_000 };
  await fs.writeFile(timedFile, JSON.stringify(nearLimit));
  await evaluate("document.querySelector('[aria-label=\"Resume practice timer\"]').click()");
  await until(() => evaluate("return document.querySelector('.pr-timer-label').textContent==='Elapsed'"), 'timer approaching 12 hours');
  await until(() => evaluate("return document.querySelector('.pr-timer-label').textContent==='Paused'"), '12-hour timer cutoff');
  assert.equal(await evaluate("return document.querySelector('.pr-timer-value').textContent"), '12:00:00');
  await sleep(1100);
  assert.equal(await evaluate("return document.querySelector('.pr-timer-value').textContent"), '12:00:00', 'abandoned timer stays stopped');
  const stoppedAtLimit = await (await fetch(`${ORIGIN}/api/practice/${timedSlug}/${timedId}`)).json();
  assert.equal(stoppedAtLimit.session.timer.runningSince, null);
  assert.equal(stoppedAtLimit.session.timer.elapsedMs, MAX_TIMER_RUN_MS);
  assert.deepEqual(stoppedAtLimit.exchanges, [], 'timer cutoff never calls the coach');
  await evaluate(`window.__practiceFetch=window.fetch;window.__failSave=true;window.fetch=(url,options)=>{
    if(window.__failSave&&options?.method==='PUT'&&String(url).startsWith('/api/practice/')){window.__failSave=false;return Promise.reject(new TypeError('Failed to fetch'));}
    return window.__practiceFetch(url,options);
  };monaco.editor.getModels()[0].setValue('print(41)');`);
  await until(() => evaluate("return !document.querySelector('.pr-work-error').hidden && document.querySelector('.pr-save').textContent==='Not saved'"), 'failed save belongs to workspace');
  assert.equal(await evaluate("return document.querySelector('.pr-compose .pr-error').hidden"),true,'save failure is not a coach failure');
  assert.ok(await evaluate("return !!localStorage.getItem('studio.practice.work:'+location.hash.split('/')[4])"),'failed save retains browser recovery');
  await shot('save-error');
  await evaluate("document.querySelector('.pr-work-error button').click()");
  await until(() => evaluate("return document.querySelector('.pr-work-error').hidden && document.querySelector('.pr-save').textContent==='Saved'"), 'explicit save retry clears resolved error');
  await evaluate("window.__failSave=true;monaco.editor.getModels()[0].setValue('print(40)');");
  await until(() => evaluate("return !document.querySelector('.pr-work-error').hidden"),'second transient save failure');
  await evaluate("monaco.editor.getModels()[0].setValue('print(42)');");
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"), 'document save');
  assert.equal(await evaluate("return document.querySelector('.pr-work-error').hidden"),true,'later successful autosave clears its error without a question');
  await evaluate("window.fetch=window.__practiceFetch;delete window.__practiceFetch;");
  await evaluate("document.querySelector('.ui-pane-header .python-run').click()");
  await until(() => evaluate("return document.querySelector('.lld-output').textContent.includes('42')"), 'Python run');
  await mode('Typed');
  await evaluate(`window.__practiceFetch=window.fetch;window.fetch=(url,options)=>{
    if(String(url)==='/api/practice/ask'){window.fetch=window.__practiceFetch;return Promise.reject(new TypeError('Failed to fetch'));}
    return window.__practiceFetch(url,options);
  };`);
  await evaluate("const i=document.querySelector('.pr-typed textarea');i.value='Which race should I test?';i.dispatchEvent(new Event('input'));document.querySelector('.pr-compose .btn--primary').click();");
  await until(() => evaluate("return !document.querySelector('.pr-compose .pr-error').hidden && document.querySelector('.pr-state').textContent==='Ready when you are'"),'failed coach request remains visible');
  await evaluate("monaco.editor.getModels()[0].setValue('print(42)\\n');");
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"),'workspace saves after coach failure');
  assert.equal(await evaluate("return document.querySelector('.pr-compose .pr-error').hidden"),false,'workspace success must not clear failed reply');
  assert.equal(await evaluate("const p=location.hash.split('/'),data=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();return data.exchanges.length"),0,'failed request is not automatically retried');
  await evaluate("monaco.editor.getModels()[0].setValue('print(42)');[...document.querySelectorAll('.pr-actions button')].find(b=>b.textContent==='Retry reply').click();");
  await until(() => evaluate("return document.querySelector('.pr-state').textContent==='Coach is thinking…'"), 'turn in flight');
  await until(() => evaluate("return document.querySelector('.pr-answer')?.textContent.includes('Hello, first half.') && document.querySelector('.pr-state')?.textContent==='Coach is thinking…'"), 'visible typed prefix before completion');
  assert.equal(await evaluate("return document.querySelector('.pr-answer').textContent.includes('second half.')"), false);
  await shot('streaming-prefix');
  await reload();
  await until(() => evaluate("return document.querySelector('.pr-answer')?.textContent.includes('Hello, first half.') && document.querySelector('.pr-state')?.textContent==='Coach is thinking…'"), 'reopened visible prefix before completion');
  await until(() => evaluate("return !!document.querySelector('.pr-answer')?.textContent.includes('second half.') && document.querySelector('.pr-state').textContent==='Ready when you are'"), 'fake answer');
  const saved = await evaluate("const p=location.hash.split('/');return await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();");
  assert.equal(saved.exchanges.length, 1); assert.equal(saved.exchanges[0].status, 'complete'); assert.equal(saved.code, 'print(42)');
  await evaluate("document.querySelector('.pr-exchange button[aria-label=\"Save to notes\"]').click()");
  await until(() => evaluate("return !!document.querySelector('.pr-exchange button[aria-label=\"Saved to notes\"]')"), 'learning note saved');
  await reload(); await sleep(300);
  await until(() => evaluate("return !!document.querySelector('.pr-answer') && !!window.monaco?.editor.getModels().length"), 'reload practice');
  assert.equal(await evaluate('return monaco.editor.getModels()[0].getValue();'), 'print(42)');
  assert.equal(await evaluate("return document.querySelector('.pr-typed').hidden"), false, 'mode persists');
  await evaluate("document.querySelector('.pr-notes').click()");
  await until(() => evaluate("return !!document.querySelector('.ln-sheet[open] .ln-note-text')"), 'notes');
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false });
    const m = await evaluate("const d=document.querySelector('.ln-sheet').getBoundingClientRect(),h=document.querySelector('.ln-sheet .ui-dialog-header').getBoundingClientRect(),c=document.querySelector('.ui-dialog-close').getBoundingClientRect();return {right:d.right-c.right,center:Math.abs((c.top+c.bottom-h.top-h.bottom)/2),height:c.height,inside:c.top>=h.top&&c.bottom<=h.bottom,overflow:document.documentElement.scrollWidth>innerWidth};");
    assert.ok(m.right >= 10 && m.right <= 24 && m.center <= 1 && m.height === 28 && m.inside, 'close anchored to header top right: '+JSON.stringify(m)); assert.equal(m.overflow, false);
    await shot('notes-'+width);
  }
  await evaluate("document.querySelector('.ui-dialog-close').click()");
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await evaluate("const log=document.querySelector('.pr-thread');for(let i=0;i<40;i++){const p=document.createElement('p');p.textContent='Earlier design reasoning and questions.';log.append(p);}log.scrollTop=0;");
  const metrics = await evaluate("const p=document.scrollingElement,l=document.querySelector('.pr-thread'),c=document.querySelector('.pr-compose'),h=document.querySelector('.pr-coach-head');return {range:l.scrollHeight-l.clientHeight,page:p.scrollHeight-innerHeight,bottom:l.getBoundingClientRect().bottom,controls:c.getBoundingClientRect().top,header:h.getBoundingClientRect().bottom,top:l.getBoundingClientRect().top};");
  assert.ok(metrics.range>200 && metrics.page<=1 && metrics.bottom<=metrics.controls+1 && metrics.top>=metrics.header-1, JSON.stringify(metrics));
  const lint = await fs.readFile(path.join(ROOT,'scripts/visual-lint.js'),'utf8');
  const findings = await evaluate(`const lint = await import('data:text/javascript;base64,${Buffer.from(lint).toString('base64')}');return lint.visualLint();`);
  assert.deepEqual(findings, [], 'practice visual contracts');
  await evaluate("const i=document.querySelector('.pr-typed textarea');i.value='Show my new reply while I was reading history';i.dispatchEvent(new Event('input'));document.querySelector('.pr-compose .btn--primary').click()");
  await until(()=>evaluate("return [...document.querySelectorAll('.pr-answer')].at(-1)?.textContent.includes('first half.') && document.querySelector('.pr-state')?.textContent==='Coach is thinking…'"),'long-history live reply');
  assert.ok(await evaluate("const log=document.querySelector('.pr-thread'),a=[...document.querySelectorAll('.pr-answer')].at(-1).getBoundingClientRect(),r=log.getBoundingClientRect();return a.bottom<=r.bottom+1 && a.top>=r.top && log.scrollHeight-log.scrollTop-log.clientHeight<2"),'new question follows visible streaming text');
  await evaluate("const log=document.querySelector('.pr-thread');log.scrollTop=0;log.dispatchEvent(new Event('scroll'))");
  await until(()=>evaluate("return document.querySelector('.pr-state')?.textContent==='Ready when you are'"),'long-history reply completes');
  assert.equal(await evaluate("return document.querySelector('.pr-thread').scrollTop"),0,'reading older content during streaming is preserved');
  for (const dark of [true, false]) {
    await evaluate(`const s=await import('/js/settings.js');s.setSetting('theme','desk');s.setSetting('mode',${dark}?'dark':'light');`);
    await sleep(150); await shot(dark?'dark':'light');
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('.pr-coach').scrollIntoView({block:'center'})");
  assert.equal(await evaluate('return document.documentElement.scrollWidth<=innerWidth'), true); await shot('narrow');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: ORIGIN+'/#/design' });
  await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'design launcher');
  await evaluate("document.querySelector('.th-practice').click()");
  await until(() => evaluate("return !!document.querySelector('.pr-board .excalidraw')"), 'practice whiteboard');
  const boardRoute = await evaluate('return location.hash');
  // An unfenced text field/portal used to be treated as the catalog search box.
  const keyOwnership = await evaluate(`const field=document.createElement('textarea');document.body.append(field);field.focus();
    const keys=['Enter','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','j','k','/','Escape'];
    const results=keys.map(key=>{const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});field.dispatchEvent(e);return {key,prevented:e.defaultPrevented,hash:location.hash}});
    field.remove();const originalBoard=document.querySelector('.pr-board');const canvas=document.querySelector('.excalidraw canvas');canvas.focus();
    for(const key of keys){const e=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});document.body.dispatchEvent(e);results.push({key:'canvas-route:'+key,prevented:e.defaultPrevented,hash:location.hash});}
    if(document.querySelector('.pr-board')!==originalBoard||document.activeElement===document.querySelector('#q'))throw Error('Catalog shortcut replaced board or stole focus');
    for(const [code,key] of [['KeyB','b'],['KeyJ','j'],['Backslash','\\\\']]){const e=new KeyboardEvent('keydown',{key,code,metaKey:true,bubbles:true,cancelable:true});document.body.dispatchEvent(e);results.push({key:code,prevented:e.defaultPrevented,hash:location.hash});}
    return results;`);
  assert.ok(keyOwnership.every(r => r.hash === boardRoute && !r.prevented), 'catalog/pane shortcuts do not claim design keys: '+JSON.stringify(keyOwnership));
  const designDivider = await evaluate("return !!document.querySelector('.ui-pane-divider,.split.split-col')");
  assert.equal(designDivider, true, 'system-design practice exposes the shared divider');
  const designBefore = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect().width,c=s.children[1].getBoundingClientRect().width;return {w,c}");
  await evaluate("const d=document.querySelector('.ui-pane-divider,.split.split-col');d.focus();d.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));");
  await sleep(80);
  const designAfter = await evaluate("const s=document.querySelector('.pr-split'),w=s.children[0].getBoundingClientRect().width,c=s.children[1].getBoundingClientRect().width;return {w,c}");
  assert.ok(designAfter.w < designBefore.w - 10 && designAfter.c > designBefore.c + 10, 'system-design divider reallocates space');
  await evaluate("document.querySelector('[aria-label=\"Start practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Pause practice timer\"]:not(:disabled)')"), 'design timer explicit start');
  await evaluate("document.querySelector('[aria-label=\"Pause practice timer\"]').click()");
  await until(() => evaluate("return !!document.querySelector('[aria-label=\"Resume practice timer\"]:not(:disabled)')"), 'system-design timer pauses');
  assert.equal(await evaluate("return document.querySelectorAll('.pr-exchange').length"), 0);
  const board = await evaluate("return document.querySelector('.pr-board').getBoundingClientRect().toJSON()");
  const x=board.left+board.width*.4, y=board.top+board.height*.4;
  await send('Input.dispatchMouseEvent', { type:'mouseMoved', x,y });
  await evaluate("const tool=[...document.querySelectorAll('.pr-board input, .pr-board button')].find(n=>/rectangle/i.test(n.getAttribute('aria-label')||''));if(!tool)throw Error('Rectangle control missing: '+[...document.querySelectorAll('.pr-board input')].map(n=>n.outerHTML).join(''));tool.click();");
  await send('Input.dispatchMouseEvent', { type:'mousePressed',x,y,button:'left',clickCount:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseMoved',x:x+130,y:y+90,button:'left',buttons:1 });
  await send('Input.dispatchMouseEvent', { type:'mouseReleased',x:x+130,y:y+90,button:'left',clickCount:1 });
  await until(() => evaluate("const p=location.hash.split('/'),data=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();return data.elements.some(e=>e.type==='rectangle');"), 'whiteboard autosave');
  // Real Excalidraw selection: arrows move the shape, Enter edits its label,
  // and Escape finishes editing without a catalog navigation or screen rebuild.
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'ArrowDown', code:'ArrowDown', windowsVirtualKeyCode:40});
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
  assert.equal(await evaluate('return location.hash'), boardRoute, 'Enter on the whiteboard never opens LeetCode');
  await until(() => evaluate("return document.activeElement?.tagName==='TEXTAREA'"), 'Enter edits selected shape text');
  await send('Input.insertText', {text:'Reservation service'});
  await until(() => evaluate("return document.activeElement?.value==='Reservation service'"), 'whiteboard text input');
  // Excalidraw's originalText is unwrapped; text contains visual line breaks.
  await until(() => evaluate("const p=location.hash.split('/'),data=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();return data.elements.some(e=>!e.isDeleted && e.originalText==='Reservation service');"), 'initial text autosaved while editing');
  // Editing the same element after its first save must invalidate the snapshot.
  await send('Input.insertText', {text:' updated'});
  await send('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent', {type:'keyUp', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
  assert.equal(await evaluate('return location.hash'), boardRoute, 'Escape preserves design route');
  await until(() => evaluate("const p=location.hash.split('/'),data=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();return data.elements.some(e=>!e.isDeleted && e.originalText==='Reservation service updated');"), 'whiteboard label saved');
  await reload(); await sleep(300);
  await until(() => evaluate("return !!document.querySelector('.pr-board .excalidraw')"), 'whiteboard reload');
  // Rehydrating Excalidraw normalizes its element records and autosaves them.
  await sleep(700);
  await until(() => evaluate("return document.querySelector('.pr-save').textContent==='Saved'"), 'rehydrated board saved');
  await shot('design');
  const designSnapshot = await evaluate("const p=location.hash.split('/');return await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();");
  assert.ok(designSnapshot.elements.some(e=>!e.isDeleted && e.originalText==='Reservation service updated'), 'typed board text survives reload');
  const boardEdit = await evaluate(`const p=location.hash.split('/'),saved=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();
    const before=saved.elements, after=structuredClone(before); after[0].strokeColor='#ff0000';
    const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const {applyAction,undoAction}=await import('/js/coach-actions.js');
    const action={id:'board-check-'+crypto.randomUUID(),tool:'edit_board',slug:p[3],target:'practice:'+p[3]+':'+p[4],status:'pending',needsAck:true,args:{expected:await hash(before),elements:after,why:'Fixture colour change'}};
    const result=await applyAction(action);
    const changed=await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();
    const stale=await applyAction({...action,id:crypto.randomUUID(),args:{...action.args,elements:before}});
    const undo=await undoAction({...action,status:'done'});
    return {result,stale,undo,changed:changed.elements};`);
  assert.equal(boardEdit.result.ok,true,'board tool edits and saves: '+JSON.stringify(boardEdit));
  assert.equal(boardEdit.changed[0].strokeColor,'#ff0000');
  assert.equal(boardEdit.stale.ok,false,'stale board edit cannot overwrite newer work');
  assert.equal(boardEdit.undo.ok,true,'board edit undo works');
  const safeUndo=await evaluate(`const {bindBoardTools}=await import('/js/workspace-tools.js'),{applyAction,undoAction}=await import('/js/coach-actions.js');
    let elements=[{id:'a',type:'rectangle',x:0,y:0,width:20,height:20}], release, saving;
    const begun=new Promise(r=>saving=r), api={updateScene:({elements:next})=>{elements=next},getSceneElements:()=>elements};
    const dispose=bindBoardTools({target:'undo-isolation',getApi:()=>api,getElements:()=>elements,setElements:next=>{elements=next},save:async()=>{saving();await new Promise(r=>release=r)}});
    const expected=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(elements))))].map(b=>b.toString(16).padStart(2,'0')).join('');
    const action={id:crypto.randomUUID(),slug:'unused',target:'undo-isolation',tool:'edit_board',needsAck:true,status:'pending',args:{expected,elements:[{...elements[0],x:100}],why:'Fixture'}};
    const pending=applyAction(action);await begun;elements=[...elements,{id:'learner-new-stroke'}];release();await pending;
    const result=await undoAction({...action,status:'done'});dispose();return {result,preserved:elements.some(e=>e.id==='learner-new-stroke')};`);
  assert.equal(safeUndo.result.ok,false,'Undo refuses to overwrite learner changes during save');
  assert.equal(safeUndo.preserved,true,'learner stroke retained');


  const sourceId = '2026-10-31T18-00-00-000Z', designStore = new DesignStore({root:HOME});
  await designStore.create(sourceId,{prompt:'Design a URL-shortening service.',topicSlug:'design-url-shortener',startedAt:Date.now()-60000,endedAt:Date.now(),debriefed:true,phase:'wrapup',level:'L4',minutes:45});
  await designStore.writeScene(sourceId,0,designSnapshot.elements);
  await designStore.appendTurn(sourceId,{kind:'debrief',asked:'Review reservation atomicity.'});
  await evaluate("location.hash='#/design'"); await until(()=>evaluate("return !!document.querySelector('.th-item[data-slug=design-url-shortener] .th-again')"),'design source mock');
  await evaluate(`document.querySelector('.th-item[data-slug=design-url-shortener] .th-again').click();`);
  await until(()=>evaluate("return !!document.querySelector('.pr-board .excalidraw') && !!document.querySelector('.pr-source-link')"),'practice from design mock');
  const designBranch = await evaluate("const p=location.hash.split('/');return await(await fetch('/api/practice/'+p[3]+'/'+p[4])).json();");
  assert.deepEqual(designBranch.elements,designSnapshot.elements,'copied whiteboard retains every element');
  assert.match(designBranch.sourceSnapshot.feedback,/reservation atomicity/);
  assert.equal(designBranch.session.source.interviewId,sourceId);
  await evaluate("document.querySelector('.pr-problem').open=true;");
  await shot('branch');
  // This request was produced by the fake provider above, through the real central
  // assembly path. The inspector must show that payload, not reconstructed UI state.
  const inspection=await evaluate("return await(await fetch('/api/coach/context')).json();");
  assert.ok(inspection.requests.length>0,'practice requests are centrally inspected');
  const latest=inspection.requests.at(-1);
  const exact=await evaluate(`return (await(await fetch('/api/coach/context?id=${latest.id}')).json()).request;`);
  assert.equal(exact.input.promptCharacters,exact.prompt.length);
  assert.match(exact.systemPrompt,/untimed practice/);
  await evaluate("(await import('/js/settings.js')).openSettings();[...document.querySelectorAll('.settings button')].find(b=>b.textContent==='What was sent?').click();");
  await until(()=>evaluate("return !!document.querySelector('.ci-request')"),'context inspector list');
  await evaluate("document.querySelector('.ci-request').click()");
  await until(()=>evaluate("return !!document.querySelector('.ci-source')"),'context inspector detail');
  assert.equal(await evaluate("return document.querySelector('.ci-source pre').textContent"),exact.prompt);
  for(const appearance of ['light','dark']){
    await evaluate(`const s=await import('/js/settings.js');s.setSetting('theme','studio');s.setSetting('mode','${appearance}');`);
    await sleep(300);await shot('context-'+appearance);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  const bounds=await evaluate("const s=document.querySelector('.ci-sheet'),b=s.querySelector('.ci-body'),c=s.querySelector('.ui-dialog-close'),r=s.getBoundingClientRect(),x=c.getBoundingClientRect();b.scrollTop=b.scrollHeight;return {overflow:s.scrollWidth>s.clientWidth+1,closeRight:r.right-x.right,canScroll:b.scrollTop>0,dialogs:document.querySelectorAll('.ci-sheet[open]').length};");
  assert.equal(bounds.overflow,false,JSON.stringify(bounds));assert.ok(bounds.closeRight>=0 && bounds.closeRight<40);assert.equal(bounds.canScroll,true);assert.equal(bounds.dialogs,1);
  await shot('context-narrow');
  await evaluate("document.querySelector('.ci-sheet .ui-dialog-close').click()");
  await until(()=>evaluate("return !document.querySelector('.ci-sheet')"),'inspector close cleanup');
  await evaluate("await(await import('/js/context-inspector.js')).openContextInspector();document.querySelector('.ci-sheet button').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
  await until(()=>evaluate("return !document.querySelector('.ci-sheet')"),'inspector Escape cleanup');
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await evaluate("location.hash='#/lld'");
  await until(()=>evaluate("return !!document.querySelector('.th-practice')"),'practice launcher');
  assert.equal(await evaluate("return document.querySelector('.th-practice').textContent.trim()"),'Start practising');
  await evaluate("document.querySelector('.th-practice').click()");
  await until(()=>evaluate("return !!document.querySelector('.pr-empty') && !!window.monaco?.editor.getModels().length"),'blank practice');
  assert.match(await evaluate("return document.querySelector('.pr-empty').textContent"),/What would you like to work on/);
  assert.equal(await evaluate("return document.querySelectorAll('.pr-exchange').length"),0);
  await evaluate("monaco.editor.getModels()[0].setValue('custom_work = 42')");
  await mode('Typed');
  await evaluate("const i=document.querySelector('.pr-typed textarea');i.value='Define my custom practice topic: inventory repair with duplicate reservation checks';i.dispatchEvent(new Event('input'));document.querySelector('.pr-compose .btn--primary').click()");
  await until(()=>evaluate("return document.querySelector('.ui-workspace-identity h1')?.textContent==='Inventory repair' && document.querySelector('.pr-state')?.textContent==='Ready when you are'"),'coach saves custom topic');
  assert.equal(await evaluate('return monaco.editor.getModels()[0].getValue()'),'custom_work = 42');
  assert.match(await evaluate("return document.querySelector('.pr-problem').textContent"),/reject duplicate reservations/);
  await shot('custom-topic');
  await reload();
  await until(()=>evaluate("return document.querySelector('.ui-workspace-identity h1')?.textContent==='Inventory repair' && !!window.monaco?.editor.getModels().length"),'custom topic reload');
  assert.equal(await evaluate('return monaco.editor.getModels()[0].getValue()'),'custom_work = 42');
  await evaluate("const i=document.querySelector('.pr-typed textarea');i.value='Verify package-size tool continuation';i.dispatchEvent(new Event('input'));document.querySelector('.pr-compose .btn--primary').click()");
  await until(()=>evaluate("return document.querySelectorAll('.pr-answer').length===2 && document.querySelector('.pr-state')?.textContent==='Ready when you are'"),'tool continuation finished');
  const expectedEchoAnswer = 'Yes, size matters. Each package is small, medium or large.';
  assert.equal(await evaluate("return [...document.querySelectorAll('.pr-answer')].at(-1).textContent.trim()"), expectedEchoAnswer, 'tool continuation is rendered once');
  await reload();
  await until(()=>evaluate("return document.querySelectorAll('.pr-answer').length===2"),'tool continuation reload');
  assert.equal(await evaluate("return [...document.querySelectorAll('.pr-answer')].at(-1).textContent.trim()"), expectedEchoAnswer, 'saved answer is also rendered once');
  await shot('tool-continuation');
  assert.deepEqual(issues, [], 'no browser exceptions');
  console.log('ok — practice question/reply, Python, reload, notes, mode persistence, independent scrolling, narrow layout, real whiteboard');
  if(process.env.STUDIO_CHECK_REVIEW==='1'){console.log('Manual review ready. Press Enter to clean up.');await new Promise(resolve=>{process.stdin.once('data',resolve);process.once('SIGUSR1',resolve);});process.stdin.pause();}
} finally {
  socket?.close(); for (const p of [chrome, server]) if (p && p.exitCode === null) p.kill();
  for (const p of pending.values()) clearTimeout(p.timer);
  await fs.rm(HOME, { recursive:true, force:true }); await cleanupChrome(chrome, PROFILE);
}
