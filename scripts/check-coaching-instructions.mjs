import { cleanupChrome } from './chrome-cleanup.mjs';
// LLD layout regression: real Chrome/CDP, scratch home, fake interviewer only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { DesignStore } from '../server/design/store.mjs';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guidance-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guidance-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4205, DEBUG = PORT + 5255;
const ORIGIN = `http://127.0.0.1:${PORT}`, DEBUG_URL = `http://127.0.0.1:${DEBUG}`;
let server, chrome, socket, seq = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, label) { for (let i = 0; i < 180; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`Timed out: ${label}\n${logs}`); }
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
  async function shot(name) { const s = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(`/tmp/studio-guidance-${name}.png`, Buffer.from(s.data, 'base64')); }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: ORIGIN + '/#/lld' });
  await until(()=>evaluate("return !!document.querySelector('.th-practice')"),'page');
  await evaluate("(await import('/js/settings.js')).openSettings();[...document.querySelectorAll('.settings button')].find(b=>b.textContent==='Coaching instructions').click();");
  await until(()=>evaluate("return document.querySelector('.gi-body')?.textContent.includes('No saved coaching instructions')"),'empty instructions');
  const click = async text => evaluate(`const b=[...document.querySelectorAll('.gi-sheet button')].find(b=>b.textContent===${JSON.stringify(text)});if(!b)throw Error('Missing button');b.click();`);
  await click('Add instruction');
  await evaluate("document.querySelector('[aria-label=\"Coaching instruction\"]').value='Explain intuition before code.';");
  await click('Save instruction');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('Explain intuition before code.')"),'saved instruction');
  await click('Disable');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('Disabled')"),'disabled');
  await click('Undo latest change');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('Active')"),'undo');
  await click('Edit');
  await evaluate("document.querySelector('[aria-label=\"Coaching instruction\"]').value='Start with a concrete example.';");
  await click('Save instruction');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('Start with a concrete example.')"),'edited');
  await evaluate("document.querySelector('.gi-history summary').click()");
  assert.match(await evaluate("return document.querySelector('.gi-history').textContent"),/Explain intuition before code/);
  for (const appearance of ['light','dark']) {
    await evaluate(`const s=await import('/js/settings.js');s.setSetting('mode','${appearance}');`);
    await sleep(300);await shot('instructions-'+appearance);
  }
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
  const bounds=await evaluate("const d=document.querySelector('.gi-sheet').getBoundingClientRect();return {left:d.left,right:d.right,scroll:document.querySelector('.gi-body').scrollWidth,width:document.querySelector('.gi-body').clientWidth};");
  assert.ok(bounds.left>=0&&bounds.right<=391&&bounds.scroll<=bounds.width+1,JSON.stringify(bounds));
  await shot('instructions-narrow');
  await evaluate("document.querySelector('.gi-sheet').close()");
  await send('Page.reload');
  await until(()=>evaluate("return !!document.querySelector('.th-practice')"),'reload');
  await evaluate("await(await import('/js/coaching-instructions.js')).openCoachingInstructions();");
  assert.match(await evaluate("return document.querySelector('.gi-rule').textContent"),/Start with a concrete example/);
  await click('Edit');
  await evaluate("const state=await(await fetch('/api/coach/instructions')).json();await fetch('/api/coach/instructions',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expectedRevision:state.revision,mutationId:'concurrent-browser-edit',operation:'upsert',rule:{...state.rules[0],text:'External current instruction.'},reason:'Simulated concurrent edit.'})});");
  await click('Save instruction');
  await until(()=>evaluate("return document.querySelector('.gi-body [role=status]')?.textContent.includes('stale')"),'stale edit rejection');
  await click('Refresh');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('External current instruction.')"),'latest state');
  await click('Remove');
  await until(()=>evaluate("return document.querySelector('.gi-body')?.textContent.includes('No saved coaching instructions')"),'removed');
  await click('Undo latest change');
  await until(()=>evaluate("return document.querySelector('.gi-rule')?.textContent.includes('External current instruction.')"),'restored removed rule');
  assert.deepEqual(issues,[],'no browser exceptions');
  console.log('ok — instructions create/edit/disable/history/undo/reload/conflict; desktop and narrow bounds');
} finally {
  socket?.close();
  await Promise.all([chrome, server].filter(Boolean).map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  await cleanupChrome(chrome, PROFILE);
  for (const p of pending.values()) clearTimeout(p.timer);
  await fs.rm(HOME, { recursive:true, force:true, maxRetries: 5, retryDelay: 200 });
}
