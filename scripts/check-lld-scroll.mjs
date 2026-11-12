import { cleanupChrome } from './chrome-cleanup.mjs';
// LLD layout regression: real Chrome/CDP, scratch home, fake interviewer only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-lld-scroll-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-lld-scroll-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4199, DEBUG = PORT + 5255;
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
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch=async()=>{throw Error('network disabled')}; (await import('./server/index.mjs')).start();"], { cwd: ROOT, env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(PORT), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'), STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'), STUDIO_TTS_PYTHON: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_SCRIPT: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES: path.join(ROOT, 'server/tts/test/fake-helper.mjs'), FAKE_INTERVIEW_TOKEN_MS: '8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + d).slice(-3000); });
  await until(async () => (await fetch(ORIGIN + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_REVIEW === '1' ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(DEBUG_URL + '/json/list')).ok, 'chrome');
  const tab = (await (await fetch(DEBUG_URL + '/json/list')).json()).find(x => x.type === 'page'); socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(m.error.message)) : p.resolve(m.result); } });
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async()=>{throw new DOMException('No mic','NotAllowedError')}});" });
  await send('Page.navigate', { url: ORIGIN + '/#/lld' }); await until(() => evaluate("return !!document.querySelector('[data-slug=lld-locker]')"), 'LLD library');
  await evaluate("document.querySelector('.th-box--mock [data-slug=lld-locker]').click(); document.querySelector('.th-box--mock .ci-start').click()"); await until(() => evaluate("return !!document.querySelector('.ci-log') && !!window.monaco?.editor.getModels().length"), 'LLD live');
  // Seed a long transcript through the rendered DOM: this exercises the same scroll owner
  // and keeps the check deterministic without a model, microphone, or fabricated API data.
  await evaluate("const log=document.querySelector('.ci-log'); log.insertAdjacentHTML('beforeend', '<div class=ci-msg>'+('<p>Earlier interviewer context and constraints. </p>'.repeat(260))+'</div>'); log.scrollTop=log.scrollHeight;");
  for (const [width, height] of [[2000,780],[1440,900],[1024,650],[390,844]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await sleep(120);
    const metrics = await evaluate("const q=s=>document.querySelector(s), log=q('.ci-log'), page=document.scrollingElement, h=q('.ci-live-header')||q('.ci-header'), c=q('.ci-composer'); log.scrollTop=log.scrollHeight; return { w:innerWidth,h:innerHeight, page:page.scrollTop, logRange:log.scrollHeight-log.clientHeight, logRect:log.getBoundingClientRect().toJSON(), head:h?.getBoundingClientRect().toJSON(), comp:c?.getBoundingClientRect().toJSON(), last:log.lastElementChild?.getBoundingClientRect().toJSON() };");
    assert.ok(metrics.logRange > 100, `transcript must scroll at ${width}`); assert.ok(await evaluate("const l=document.querySelector('.ci-log'); return l.scrollTop >= l.scrollHeight-l.clientHeight-1"), `last message reachable at ${width}`);
    if (width >= 600) { assert.ok(metrics.head.bottom <= metrics.logRect.top + 2, 'header overlaps transcript'); assert.ok(metrics.comp.top >= metrics.logRect.bottom - 2, 'composer overlays transcript'); }
    if (width < 901) await evaluate("document.querySelector('.lld-interviewer').scrollIntoView({block:'center'});");
    const before = await evaluate("return {p:document.scrollingElement.scrollTop,l:document.querySelector('.ci-log').scrollTop}"); await evaluate("document.querySelector('.ci-log').scrollTop=0");
    const pt = await evaluate("const r=document.querySelector('.ci-log').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}"); await send('Input.dispatchMouseEvent', { type:'mouseWheel', ...pt, deltaX:0, deltaY:160 }); await sleep(100);
    const after = await evaluate("return {p:document.scrollingElement.scrollTop,l:document.querySelector('.ci-log').scrollTop}"); assert.equal(after.p, before.p, `page moved while transcript scrolled at ${width}`); assert.ok(after.l > 0, `transcript wheel did not scroll at ${width}`);
    const editor = await evaluate("const e=document.querySelector('.monaco-editor')?.getBoundingClientRect(), l=document.querySelector('.ci-log').getBoundingClientRect(); const box=r=>r&&{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; return {e:box(e),l:box(l),body:document.scrollingElement.scrollHeight-innerHeight}");
    assert.ok(editor.e && editor.e.width > 0 && editor.e.right <= width + 1, `editor geometry at ${width}: ${JSON.stringify(editor)}`);
    if (width >= 901) assert.ok(editor.body <= 1, `desktop document overflow at ${width}`);
    
    const shot = await send('Page.captureScreenshot', { format:'png' }); await fs.writeFile(`/tmp/studio-lld-scroll-${width}.png`, Buffer.from(shot.data, 'base64'));
  }

  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  async function mode(value) {
    await evaluate(`document.querySelector('.ci-composer .ui-mode-switch[data-mode=${value.toLowerCase()}]').click();`);
  }
  await mode('Typed');
  await until(()=>evaluate("return !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled"),'typed ready');
  await evaluate(String.raw`
    monaco.editor.getModels()[0].setValue('# Candidate implementation\n'.repeat(200)+'print("execution output\\n"*60)');
    window.originalFetch=window.fetch; window.scrollChunks=0;
    window.fetch=(url,options)=>{
      if(url!=='/api/interview/turn')return window.originalFetch(url,options);
      return Promise.resolve(new Response(new ReadableStream({async start(controller){
        const emit=(name,data)=>controller.enqueue(new TextEncoder().encode('event: '+name+'\ndata: '+JSON.stringify(data)+'\n\n'));
        emit('accepted',{said:JSON.parse(options.body).said});
        for(let i=0;i<120;i++){emit('token',{text:'What happens if two reservations overlap at the same time?\n'}); window.scrollChunks++;await new Promise(r=>setTimeout(r,30));}
        emit('done',{});controller.close();
      }}),{headers:{'content-type':'text/event-stream'}}));
    };
    const input=document.querySelector('.ci-input');input.value='Discuss reservation ownership';input.dispatchEvent(new Event('input'));document.querySelector('.ci-send').click();
  `);
  await until(()=>evaluate('return window.scrollChunks>8'),'streaming');
  const rect=await evaluate("const r=document.querySelector('.ci-log').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}");
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...rect,deltaX:0,deltaY:-240});await sleep(150);
  const held=await evaluate("return {top:document.querySelector('.ci-log').scrollTop,chunk:window.scrollChunks,editor:document.querySelector('.lld-document').getBoundingClientRect().toJSON()}");
  await mode('Voice'); await mode('Typed');
  await until(()=>evaluate(`return window.scrollChunks>${held.chunk+20}`),'tokens while reading');
  assert.ok(Math.abs(await evaluate("return document.querySelector('.ci-log').scrollTop")-held.top)<=1,'reader position held through tokens and voice/type status');
  assert.deepEqual(await evaluate("return document.querySelector('.lld-document').getBoundingClientRect().toJSON()"),held.editor,'editor does not jump with transcript/composer changes');
  await until(()=>evaluate("return window.scrollChunks===120 && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled"),'stream settled');
  await evaluate("document.querySelector('.ci-log').focus({preventScroll:true});");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End',windowsVirtualKeyCode:35});
  assert.ok(await evaluate("const l=document.querySelector('.ci-log');return l.scrollHeight-l.scrollTop-l.clientHeight<=1"),'End restores following');
  const editorPoint=await evaluate("const r=document.querySelector('.monaco-editor').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2}");
  const logTop=await evaluate("return document.querySelector('.ci-log').scrollTop");
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',...editorPoint,deltaX:0,deltaY:440});await sleep(150);
  assert.ok(await evaluate('return monaco.editor.getEditors()[0].getScrollTop()>0'),'editor independently scrolls');
  assert.equal(await evaluate("return document.querySelector('.ci-log').scrollTop"),logTop,'editor scrolling leaves transcript alone');
  await evaluate("document.querySelector('.ui-pane-header .python-run').click();");
  await until(()=>evaluate("return document.querySelector('.lld-output').textContent.includes('Exit 0')"),'Python output');
  await evaluate("const input=document.querySelector('.ci-input');input.value='A long unsent candidate explanation. '.repeat(150);input.dispatchEvent(new Event('input'));");
  await mode('Voice');await sleep(150);
  const bounded=await evaluate("const q=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {page:document.scrollingElement.scrollHeight-innerHeight,log:q('.ci-log'),editor:q('.lld-code'),controls:q('.ci-composer'),panel:q('.ci-panel'),words:document.querySelector('.ci-live-words').scrollHeight>document.querySelector('.ci-live-words').clientHeight};");
  assert.ok(bounded.page<=1 && bounded.log.height>=80 && bounded.editor.height>=80 && bounded.controls.bottom<=bounded.panel.bottom+1 && bounded.words,'large voice draft/output stay bounded: '+JSON.stringify(bounded));
  await mode('Typed');await until(()=>evaluate("return document.querySelector('.ci-mode-status').hidden"),'saved typed mode');
  await evaluate("window.fetch=window.originalFetch;const input=document.querySelector('.ci-input');input.value='';input.dispatchEvent(new Event('input'));monaco.editor.getEditors()[0].setScrollTop(0);");
  const screenshot=await send('Page.captureScreenshot',{format:'png'});await fs.writeFile('/tmp/studio-lld-scroll-final.png',Buffer.from(screenshot.data,'base64'));
  console.log('ok — bounded LLD, independent editor/transcript, user scroll during streamed replies and mode changes, large drafts/output, desktop/mobile');
  if(process.env.STUDIO_CHECK_REVIEW==='1'){console.log('Manual review ready. Press Enter to clean up.');await new Promise(resolve=>{process.stdin.once('data',resolve);process.once('SIGUSR1',resolve);});}

} finally {
  socket?.close(); for (const p of [chrome, server]) if (p) { if (p.exitCode === null) p.kill(); }
  for (const p of pending.values()) clearTimeout(p.timer);
  await cleanupChrome(chrome, PROFILE);
  await fs.rm(HOME, { recursive:true, force:true, maxRetries:5, retryDelay:200 });
}
