import { cleanupChrome } from './chrome-cleanup.mjs';
// Tutor-mark geometry regression: real Chrome/CDP, scratch home, network disabled.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-tutor-marks-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-tutor-marks-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4227, DEBUG = PORT + 5255;
const ORIGIN = `http://127.0.0.1:${PORT}`, DEBUG_URL = `http://127.0.0.1:${DEBUG}`;
let server, chrome, socket, sequence = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, label) { for (let i = 0; i < 180; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`Timed out: ${label}\n${logs}`); }
async function free(port) { await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); }); }

try {
  await free(PORT); await free(DEBUG); await fs.mkdir(path.join(HOME, 'cache/leetcode'), { recursive: true });
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch=async()=>{throw Error('network disabled')}; (await import('./server/index.mjs')).start();"], { cwd: ROOT, env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(PORT), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'), STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'), STUDIO_TTS_SCRIPT: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_PYTHON:path.join(ROOT,'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL:path.join(ROOT,'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES:path.join(ROOT,'server/tts/test/fake-helper.mjs') }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-3000); });
  await until(async () => (await fetch(ORIGIN + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_REVIEW === '1' ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(DEBUG_URL + '/json/list')).ok, 'chrome');
  const tab = (await (await fetch(DEBUG_URL + '/json/list')).json()).find(x => x.type === 'page'); socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => { const message = JSON.parse(event.data), request = pending.get(message.id); if (request) { clearTimeout(request.timer); pending.delete(message.id); message.error ? request.reject(Error(message.error.message)) : request.resolve(message.result); } });
  await send('Page.enable'); await send('Runtime.enable');
  const issues=[];
  socket.addEventListener('message',event=>{const m=JSON.parse(event.data);if(m.method==='Runtime.exceptionThrown')issues.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);});
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await send('Page.navigate', { url: `${ORIGIN}/#/lld` });
  await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'app');
  await evaluate(`const {mountPythonEditor}=await import('/js/python-editor.js');const host=document.createElement('div');host.id='mark-fixture';Object.assign(host.style,{width:'820px',height:'850px',margin:'20px'});document.querySelector('#app').replaceChildren(host);window.__mounted=mountPythonEditor(host,${JSON.stringify(Array.from({length:90},(_,i)=>`value_${i+1} = ${i+1}`).join('\n'))});await __mounted.ready;window.__editor=__mounted.raw.instance;const {createMonacoTutor}=await import('/js/coach-actions.js');window.__tutor=createMonacoTutor(__editor,monaco);`);
  const long = 'Explain this invariant carefully and keep the explanation readable. '.repeat(9) + '\n\n' + 'TOKEN_'.repeat(50);
  const geometry=()=>evaluate(`const outer=document.querySelector('.tutor-note'),body=outer?.querySelector('.tutor-note-body'),text=outer?.querySelector('.tutor-note-text');if(!body)return null;const r=n=>{const x=n.getBoundingClientRect();return {top:x.top,bottom:x.bottom,left:x.left,right:x.right,height:x.height,width:x.width}};return {outer:r(outer),body:r(body),text:text.hidden?null:r(text),viewport:r(__editor.getDomNode()),height:parseFloat(outer.style.height),next:__editor.getTopForLineNumber(15)-__editor.getScrollTop()+__editor.getDomNode().getBoundingClientRect().top,scroll:body.scrollWidth,width:body.clientWidth};`);
  const fits=g=>g&&g.body.height>0&&g.body.bottom<=g.outer.bottom+1&&(!g.text||g.text.bottom<=g.body.bottom+1)&&g.next>=g.outer.bottom-1&&g.body.right<=g.viewport.right+1&&g.scroll<=g.width+1;
  assert.equal((await evaluate(`return __tutor.markLines({from:12,to:14,note:${JSON.stringify(long)},tone:'bug'});`)).ok,true);
  await until(async()=>fits(await geometry()),'initial measured zone');
  const wide=await geometry();
  await evaluate("document.querySelector('#mark-fixture').style.width='350px';__editor.layout();");
  await until(async()=>{const g=await geometry();return fits(g)&&g.body.height>wide.body.height;},'narrow wrapping grows reserved space');
  const narrow=await geometry();
  await evaluate("document.querySelector('#mark-fixture').style.setProperty('--text-sm','17px');__editor.updateOptions({fontSize:20,lineHeight:30});");
  await until(async()=>{const g=await geometry();return fits(g)&&g.body.height>narrow.body.height;},'font change remeasures note');
  const expanded=await geometry();
  await evaluate("document.querySelector('.tutor-note button[aria-expanded]').click()");
  await until(async()=>{const g=await geometry();return fits(g)&&g.body.height<expanded.body.height&&!g.text;},'collapse reserves header only');
  await evaluate("document.querySelector('.tutor-note button[aria-expanded]').click()");
  await until(async()=>{const g=await geometry();return fits(g)&&g.text&&g.body.height===expanded.body.height;},'expand restores readable note');
  // Re-open the wider editor for both screenshots and the multiple-note controls.
  await evaluate("document.querySelector('#mark-fixture').style.width='820px';document.querySelector('#mark-fixture').style.removeProperty('--text-sm');__editor.updateOptions({fontSize:14,lineHeight:22});__editor.layout();__editor.setScrollTop(160);");
  await until(async()=>fits(await geometry()),'wide layout restored');
  for(const mode of ['light','dark']){
    await evaluate(`const s=await import('/js/settings.js');s.setSetting('theme','dunes');s.setSetting('mode','${mode}');`);
    await sleep(200);const shot=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile(`/tmp/studio-tutor-marks-${mode}.png`,Buffer.from(shot.data,'base64'));
  }
  // Text inserted above a mark moves its zone and label with the original code.
  await evaluate("__editor.executeEdits('fixture',[{range:new monaco.Range(1,1,1,1),text:'# inserted above\\n'}]);");
  await until(()=>evaluate("return document.querySelector('.tutor-note-range')?.textContent==='Lines 13–15'"),'note follows shifted code');
  await evaluate("__editor.executeEdits('fixture',[{range:new monaco.Range(13,1,13,1),text:'# changed '}]);");
  await until(()=>evaluate("return document.querySelectorAll('.tutor-note').length===0"),'editing marked lines clears mark');
  await evaluate("__tutor.markLines({from:20,to:20,note:'A useful invariant.',tone:'good'});__tutor.markLines({from:23,to:23,note:'Try the empty case.',tone:'hint'});__editor.revealLinesInCenter(20,24);");
  await until(()=>evaluate("return document.querySelectorAll('.tutor-note').length===2"),'two note tones');
  assert.equal(await evaluate("return document.querySelectorAll('.tutor-note.tone-good').length"),1);
  await evaluate("document.querySelector('.tutor-note.tone-good button[aria-label^=Dismiss]').click()");
  assert.equal(await evaluate("return __tutor.markCount()"),1);
  assert.equal(await evaluate("return document.querySelectorAll('.tutor-note.tone-hint').length"),1);
  await evaluate("__tutor.dispose();");
  assert.equal(await evaluate("return document.querySelectorAll('.tutor-note').length"),0,'dispose removes note DOM');
  assert.deepEqual(issues,[],'no browser exceptions');
  if(process.env.STUDIO_CHECK_REVIEW==='1'){
    await evaluate("const {createMonacoTutor}=await import('/js/coach-actions.js');window.__tutor=createMonacoTutor(__editor,monaco);__tutor.markLines({from:12,to:14,tone:'bug',note:'The compartment owns expiry policy and reads the wall clock. Pass expires_at in, and inject a clock so expiry can be tested.'});__tutor.markLines({from:20,to:23,tone:'hint',note:'Keep one vocabulary for the station, collection, and compartment. Match the lookup name to the value it actually stores.'});__editor.revealLinesInCenter(12,23);");
    console.log('Manual review ready. Press Enter to clean up.');await new Promise(resolve=>{process.stdin.once('data',resolve);process.once('SIGUSR1',resolve);});process.stdin.pause();
  }
  console.log('ok — long notes, narrow resize, fonts, no overlap, collapse/expand/dismiss, edit tracking, tones, cleanup');

} finally {
  socket?.close(); chrome?.kill('SIGTERM'); server?.kill('SIGTERM');
  for (const request of pending.values()) clearTimeout(request.timer);
  await cleanupChrome(chrome, PROFILE); await fs.rm(HOME, { recursive: true, force: true }).catch(() => {});
}
