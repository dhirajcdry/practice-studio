import { cleanupChrome } from './chrome-cleanup.mjs';
// Real Chrome voice-mode regression with browser-only microphone/ASR fakes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-voice-'));
const PROFILE = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-voice-chrome-'));
const PORT = Number(process.env.STUDIO_CHECK_PORT) || 4221, DEBUG = PORT + 5255;
const ORIGIN = `http://127.0.0.1:${PORT}`, DEBUG_URL = `http://127.0.0.1:${DEBUG}`;
let server, chrome, socket, seq = 0, logs = '';
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => reject(Error(`CDP timeout: ${method}`)), 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); });
const evaluate = async code => { const r = await send('Runtime.evaluate', { expression: `(async()=>{${code}})()`, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, label) { for (let i = 0; i < 180; i++) { try { if (await fn()) return; } catch {} await sleep(100); } throw Error(`Timed out: ${label}\n${JSON.stringify(await evaluate("return {fixture:window.voiceFixture&&{captures:voiceFixture.captures,asks:voiceFixture.asks.length,plays:voiceFixture.plays.length,asr:voiceFixture.asr},hidden:document.hidden,focus:document.hasFocus(),voice:document.querySelector('.voice-panel')?.textContent,error:document.querySelector('.pr-error')?.textContent}").catch(()=>null))}\n${logs}`); }
async function free(port) { await new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => s.close(resolve)); }); }
async function shot(name) { const s = await send('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(`/tmp/studio-voice-${name}.png`, Buffer.from(s.data, 'base64')); }
const browserFakes = `
  const RealFetch=window.fetch;
  const f=window.voiceFixture={level:.08,asr:[],asks:[],plays:[],captures:0,stops:0,pauses:0,audio:[],ttsReady:0,autoEnd:false,previewDelay:1400,finalDelay:2000,turns:0,events:0,said:[],finalText:'',contexts:0,closedContexts:0};
  const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  f.finish=(index,extra='More useful detail follows. ')=>{
    const ask=f.asks[index]; ask.emit('token',{text:extra}); ask.answer+=extra;
    ask.emit('done',{answer:ask.answer}); ask.closed=true; ask.closedAt=performance.now(); ask.controller.close();
  };
  f.drainAudio=()=>{f.autoEnd=true;for(const audio of f.audio.splice(0))audio.onended?.()};
  window.fetch=async (...a)=>{
    const url=String(a[0]);
    if(url.includes('/api/interview/turn')){f.turns++;f.said.push(JSON.parse(a[1].body).said)}
    if(url.includes('/api/interview/event'))f.events++;
    if(url.includes('/api/asr')){
      const preview=a[1].body.get('preview')==='true';f.asr.push({preview,at:performance.now()});
      await delay(preview?f.previewDelay:f.finalDelay);
      return new Response(JSON.stringify({text:preview?'Would two callers':f.finalText||'Would two callers reserve the same room?'}),{headers:{'content-type':'application/json'}});
    }
    if(url.includes('/api/practice/ask')){
      const ask={...JSON.parse(a[1].body),answer:'Good question. ',closed:false};f.asks.push(ask);
      const stream=new ReadableStream({start(controller){
        ask.controller=controller;
        ask.emit=(name,data)=>controller.enqueue(new TextEncoder().encode('event: '+name+'\\ndata: '+JSON.stringify(data)+'\\n\\n'));
        ask.emit('accepted',{requestId:ask.requestId});ask.emit('token',{text:ask.answer});
        // Pause with more than ten words available: speech must wait for the
        // sentence ending, even past the old timed-fragment budget.
        setTimeout(()=>{if(ask.closed)return;const text='**Here is the direct answer** when two callers reserve the ';ask.answer+=text;ask.emit('token',{text})},40);
        setTimeout(()=>{if(ask.closed)return;const text='same room. ';ask.answer+=text;ask.emit('token',{text})},650);
      }});
      return new Response(stream,{headers:{'content-type':'text/event-stream'}});
    }
    if(url==='/api/tts'){
      // Exercise the real route and fake synthesis helper before replacing its WAV
      // with inspectable text. A rejected grouped phrase must fail this check.
      const response=await RealFetch(...a);if(!response.ok)return response;
      await response.arrayBuffer();f.ttsReady++;
      return new Response(JSON.parse(a[1].body).text,{headers:{'content-type':'audio/wav'}});
    }
    return RealFetch(...a);
  };
  navigator.mediaDevices.getUserMedia=async()=>{f.captures++;return {getTracks:()=>[{stop(){f.stops++},addEventListener(){}}]}};
  class FakeRecorder extends EventTarget{
    constructor(){super();this.mimeType='audio/webm'}
    start(){} requestData(){const e=new Event('dataavailable');e.data=new Blob(['voice fixture']);this.dispatchEvent(e)}
    stop(){queueMicrotask(()=>{this.requestData();this.dispatchEvent(new Event('stop'))})}
    static isTypeSupported(){return true}
  }
  window.MediaRecorder=FakeRecorder;
  window.AudioContext=class {
    constructor(){this.state='running';f.contexts++} createMediaStreamSource(){return {connect(){}}}
    createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(a){a.fill(f.level)}}} close(){if(this.state!=='closed')f.closedContexts++;this.state='closed'}
  };
  const blobs=new Map();let blobId=0;
  URL.createObjectURL=blob=>{const url='blob:voice-check-'+(++blobId);blobs.set(url,blob);return url};
  URL.revokeObjectURL=url=>blobs.delete(url);
  window.Audio=class {
    async play(){const text=await blobs.get(this.src).text();f.plays.push({text,at:performance.now(),open:f.asks.some(a=>!a.closed)});f.audio.push(this);if(f.autoEnd)setTimeout(()=>this.onended?.(),0)}
    pause(){f.pauses++;f.audio=f.audio.filter(a=>a!==this)} removeAttribute(){this.src=''}
  };
`;

// Away: the page hidden or another window in front. Presence is driven through the
// real blur/focus/visibilitychange events with the page's focus/visibility reported
// as the browser would; capture, ASR and the model are the fixture's fakes.
const AWAY = 'Mic off while you’re away';
const live = "voiceFixture.captures-voiceFixture.stops", liveContexts = "voiceFixture.contexts-voiceFixture.closedContexts";
const leave = how => evaluate(how === 'hidden'
  ? "Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>'hidden'});Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('blur'));return "+live
  : "Object.defineProperty(document,'hasFocus',{configurable:true,value:()=>false});window.dispatchEvent(new Event('blur'));return "+live);
const comeBack = () => evaluate("delete document.visibilityState;delete document.hidden;delete document.hasFocus;document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'))");
async function awayCycles(name, panel, draftOf, words) {
  const state = `document.querySelector('${panel} .voice-state')?.textContent`;
  for (let i = 0; i < 5; i++) {
    const how = i % 2 ? 'hidden' : 'blur';
    assert.equal(await leave(how), 0, `${name}: ${how} #${i + 1} releases every track at once`);
    await until(() => evaluate(`return ${state}===${JSON.stringify(AWAY)}`), `${name}: away status after ${how} #${i + 1}`);
    await comeBack();
    await until(() => evaluate(`return ${live}===1 && document.querySelector('${panel}').dataset.capture==='recording'`), `${name}: listening again after ${how} #${i + 1}`);
  }
  assert.deepEqual(await evaluate(`return {streams:${live},contexts:${liveContexts}}`), { streams: 1, contexts: 1 }, `${name}: five away/return cycles leave exactly one live stream and meter`);
  assert.equal(await evaluate(`return ${draftOf}`), words, `${name}: earlier words survive the cycles`);
}
async function checkAway() {
  const words = 'Would two callers reserve the same room?';
  // Practice (LLD) — the shared voice loop.
  await send('Page.navigate', { url: 'about:blank' });
  await until(() => evaluate("return location.href==='about:blank' && document.readyState==='complete'"), 'blank');
  await send('Page.navigate', { url: ORIGIN + '/#/lld' });
  await until(() => evaluate("return !!document.querySelector('.th-practice')"), 'away: lld launcher');
  await evaluate("if(!document.querySelector('.th-problem[aria-pressed=true]'))document.querySelector('.th-problem')?.click();document.querySelector('.th-practice').click()");  // a catalog problem: the fake model prepares none
  await until(() => evaluate("return voiceFixture.captures===1 && document.querySelector('.pr-voice .voice-panel')?.dataset.capture==='recording'"), 'away: practice listening');
  const practiceState = "document.querySelector('.pr-voice .voice-state').textContent";
  await sleep(700);  // mid-phrase: words are being heard when you leave
  assert.equal(await leave('blur'), 0, 'practice: blur releases the microphone at once');
  await evaluate('voiceFixture.level=0');
  await until(() => evaluate(`return document.querySelector('.pr-typed textarea').value===${JSON.stringify(words)} && ${practiceState}===${JSON.stringify(AWAY)}`), 'practice: heard words drain into the draft and the status says away');
  await sleep(3000);  // longer than the going-quiet fuse
  assert.deepEqual(await evaluate(`return {asks:voiceFixture.asks.length,captures:voiceFixture.captures,live:${live}}`), { asks: 0, captures: 1, live: 0 }, 'practice: nothing is sent or reacquired while away');
  await comeBack();
  await until(() => evaluate(`return ${live}===1 && ${practiceState}==='Listening'`), 'practice: listening again on return, no click');
  assert.equal(await evaluate("return document.querySelector('.pr-voice .voice-confirmed').textContent"), words, 'practice: earlier words still pending');
  await sleep(3000);  // past the going-quiet fuse with no new speech
  assert.equal(await evaluate('return voiceFixture.asks.length'), 0, 'practice: returning and staying quiet does not send the leftover words');
  await awayCycles('practice', '.pr-voice .voice-panel', "document.querySelector('.pr-typed textarea').value", words);
  // Coding mock interview (coach sidebar, Interviews tab) — its own mic gate, same rule.
  await send('Page.navigate', { url: 'about:blank' });
  await until(() => evaluate("return location.href==='about:blank' && document.readyState==='complete'"), 'blank');
  await send('Page.navigate', { url: ORIGIN + '/#/p/two-sum' });
  await until(() => evaluate("return !!document.querySelector('.coach-tabs') && !!document.querySelector('.ws-host')"), 'away: problem');
  await evaluate("voiceFixture.autoEnd=true;voiceFixture.previewDelay=0;voiceFixture.finalDelay=300;voiceFixture.level=0;(await import('/js/coach.js')).setOpen(true);[...document.querySelectorAll('.coach-tab')].find(n=>n.textContent.startsWith('Interviews')).click();document.querySelector('.interview-back')?.click()");
  await until(() => evaluate("return !!document.querySelector('.ci-setup form')"), 'away: mock setup');
  await evaluate("document.querySelector('.ci-setup [aria-label^=\"Answer mode\"]')?.click();[...document.querySelectorAll('.ui-menu-item')].find(n=>n.textContent.includes('Voice'))?.click();document.querySelector('.ci-setup form').requestSubmit()");
  const mock = '.ci-voice .voice-panel', mockState = `document.querySelector('${mock} .voice-state').textContent`, mockDraft = "document.querySelector('.ci-input').value";
  await until(() => evaluate(`return voiceFixture.captures===1 && document.querySelector('${mock}')?.dataset.capture==='recording'`), 'away: mock listening');
  await until(() => evaluate(`return voiceFixture.plays.length>0 && document.querySelector('${mock}').dataset.state==='recording' && ${mockState}==='Listening'`), 'away: opening question spoken');
  await evaluate('voiceFixture.level=.08'); await sleep(700);
  const interviewerTurns = "document.querySelectorAll('.ci-log .ci-entry:not(.ci-candidate)').length";
  assert.equal(await leave('blur'), 0, 'mock: another app in front releases the microphone at once');
  const awayAt = await evaluate(`return {events:voiceFixture.events,replies:${interviewerTurns}}`);
  await evaluate('voiceFixture.level=0');
  await until(() => evaluate(`return ${mockDraft}===${JSON.stringify(words)} && ${mockState}===${JSON.stringify(AWAY)}`), 'mock: heard words kept as the draft and the status says away');
  // The idle tick asks the interviewer every five seconds; it used to reopen the mic.
  await sleep(6500);
  assert.deepEqual(await evaluate(`return {turns:voiceFixture.turns,captures:voiceFixture.captures,live:${live},state:${mockState}}`), { turns: 0, captures: 1, live: 0, state: AWAY }, 'mock: no answer submitted and no microphone while away');
  assert.deepEqual(await evaluate(`return {events:voiceFixture.events,replies:${interviewerTurns}}`), awayAt, 'mock: no idle poll and no interviewer turn while away');
  await comeBack();
  await until(() => evaluate(`return ${live}===1 && document.querySelector('${mock}').dataset.capture==='recording'`), 'mock: listening again on return, no click');
  assert.equal(await evaluate(`return document.querySelector('${mock} .voice-confirmed').textContent`), words, 'mock: earlier words still pending');
  await sleep(3000);  // past the going-quiet fuse with no new speech
  assert.deepEqual(await evaluate(`return {turns:voiceFixture.turns,events:voiceFixture.events,draft:${mockDraft}}`), { turns: 0, events: awayAt.events, draft: words }, 'mock: returning and staying quiet sends nothing, and the skipped polls do not fire in a burst');
  await until(() => evaluate(`return voiceFixture.events>${awayAt.events}`), 'mock: idle polling resumes after return');
  assert.equal(await evaluate('return voiceFixture.turns'), 0);
  await awayCycles('mock', mock, mockDraft, words);
  // Another sidebar tab hides the mock: mic off, and back on with no click.
  await evaluate("[...document.querySelectorAll('.coach-tab')].find(n=>n.textContent.startsWith('Chat')).click()");
  await until(() => evaluate(`return ${live}===0`), 'mock: switching sidebar tab releases the microphone');
  await evaluate("[...document.querySelectorAll('.coach-tab')].find(n=>n.textContent.startsWith('Interviews')).click()");
  await until(() => evaluate(`return ${live}===1 && document.querySelector('${mock}').dataset.capture==='recording'`), 'mock: back on the Interviews tab resumes listening');
  assert.equal(await evaluate(`return {turns:voiceFixture.turns,draft:${mockDraft}}`).then(r => r.turns === 0 && r.draft === words), true, 'mock: tab switch neither sends nor loses the draft');
  // Reload mid-mock: listening again with no click, the draft restored and still pending.
  const beforeReload = await evaluate('return voiceFixture.captures');
  assert.ok(beforeReload > 0);
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`return voiceFixture.captures===1 && ${live}===1 && document.querySelector('${mock}')?.dataset.capture==='recording' && ${mockDraft}===${JSON.stringify(words)}`), 'mock: after reload, listening with no click and the draft restored');
  await evaluate('voiceFixture.autoEnd=true;voiceFixture.previewDelay=0;voiceFixture.finalDelay=300;voiceFixture.level=0');
  await sleep(3000);
  assert.deepEqual(await evaluate(`return {turns:voiceFixture.turns,draft:${mockDraft}}`), { turns: 0, draft: words }, 'mock: a restored draft is not sent by staying quiet after reload');
  // Away once more, then new speech: the countdown arms and one turn carries both parts.
  assert.equal(await leave('blur'), 0); await comeBack();
  await until(() => evaluate(`return ${live}===1 && document.querySelector('${mock}').dataset.capture==='recording'`), 'mock: listening after the last return');
  await sleep(3000);
  assert.deepEqual(await evaluate(`return {turns:voiceFixture.turns,draft:${mockDraft}}`), { turns: 0, draft: words }, 'mock: blur and focus then quiet sends nothing');
  const more = 'And what if the room is released?';
  await evaluate(`voiceFixture.finalText=${JSON.stringify(more)};voiceFixture.level=.08`); await sleep(1100); await evaluate('voiceFixture.level=0');
  await until(() => evaluate('return voiceFixture.turns===1'), 'mock: new speech then quiet sends');
  await sleep(2600);
  assert.deepEqual(await evaluate('return {turns:voiceFixture.turns,said:voiceFixture.said}'), { turns: 1, said: [`${words} ${more}`] }, 'mock: sent once, both parts in order');
  console.log('away', JSON.stringify(await evaluate(`return {captures:voiceFixture.captures,stops:voiceFixture.stops,live:${live},contexts:${liveContexts},turns:voiceFixture.turns}`)));
}

try {
  await free(PORT); await free(DEBUG); await fs.mkdir(path.join(HOME, 'cache/leetcode'), { recursive: true });
  await fs.writeFile(path.join(HOME, 'cache/leetcode/two-sum.json'), JSON.stringify({ question: { title: 'Two Sum', titleSlug: 'two-sum', questionId: '1', difficulty: 'Easy', content: '<p>Find two numbers whose sum is the target.</p>', metaData: JSON.stringify({ name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]' } }), exampleTestcases: '[2,7,11,15]\n9', codeSnippets: [{ langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n' }] } }));
  await fs.writeFile(path.join(HOME, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  const helper = path.join(ROOT, 'server/tts/test/fake-helper.mjs');
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch=async()=>{throw Error('network disabled')};(await import('./server/index.mjs')).start()"], { cwd: ROOT, env: { ...process.env, STUDIO_HOME: HOME, STUDIO_PORT: String(PORT), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'), STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'), STUDIO_TTS_PYTHON: helper, STUDIO_TTS_SCRIPT: helper, STUDIO_TTS_MODEL: helper, STUDIO_TTS_VOICES: helper }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [server.stdout, server.stderr]) s.on('data', d => { logs = (logs + d).slice(-3000); });
  await until(async () => (await fetch(ORIGIN + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_HEADED ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${DEBUG}`, `--user-data-dir=${PROFILE}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(DEBUG_URL + '/json/list')).ok, 'chrome'); const tab = (await (await fetch(DEBUG_URL + '/json/list')).json()).find(t => t.type === 'page');
  socket = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => socket.addEventListener('open', r, { once: true })); socket.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.method === 'Page.javascriptDialogOpening') { socket.send(JSON.stringify({ id: ++seq, method: 'Page.handleJavaScriptDialog', params: { accept: true } })); return; } const w = pending.get(m.id); if (!w) return; clearTimeout(w.timer); pending.delete(m.id); m.error ? w.reject(Error(m.error.message)) : w.resolve(m.result); });
  await send('Page.enable'); await send('Runtime.enable'); await send('Emulation.setFocusEmulationEnabled',{enabled:true}); await send('Page.addScriptToEvaluateOnNewDocument', { source: browserFakes });
  for (const route of ['/#/lld', '/#/design']) {
    const name=route.includes('design')?'design':'lld';
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await send('Page.navigate', {url:'about:blank'});
    await until(()=>evaluate("return location.href==='about:blank' && document.readyState==='complete'"),'blank');
    await send('Page.navigate', {url:ORIGIN+route});
    await until(()=>evaluate("return !!document.querySelector('.th-practice')"), name+' launcher');
    await evaluate("if(!document.querySelector('.th-problem[aria-pressed=true]'))document.querySelector('.th-problem')?.click();document.querySelector('.th-practice').click()");  // a catalog problem: the fake model prepares none
    await until(()=>evaluate("return !!document.querySelector('.pr-actions')"), name+' composer');
    await until(()=>evaluate("return voiceFixture.captures===1 && document.querySelector('.voice-panel').textContent.includes('Listening')"), name+' Start practice joins voice');
    await sleep(1100); await evaluate("voiceFixture.level=0");
    await until(()=>evaluate("return voiceFixture.asr.some(r=>!r.preview) && document.querySelector('.voice-partial').textContent==='Would two callers'"), name+' delayed preview survives phrase cut');
    assert.equal(await evaluate("return document.querySelector('.voice-confirmed').textContent"),'');
    assert.equal(await evaluate("return document.querySelector('.pr-typed textarea').value"),'','preview cannot enter saved draft');
    await shot(name+'-listening');
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
    await evaluate("document.querySelector('.voice-panel').scrollIntoView({block:'center'})");
    await shot(name+'-listening-narrow');
    await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await until(()=>evaluate("return voiceFixture.plays.length>0"),name+' first actual playback');
    assert.equal(await evaluate("return voiceFixture.asks.length"),1);
    assert.equal(await evaluate("return voiceFixture.asks[0].closed"),false,'first audio precedes SSE completion');
    assert.equal(await evaluate("return voiceFixture.plays[0].text"),'Good question. Here is the direct answer when two callers reserve the same room.','the short opener and full sentence must share one clip despite delayed tokens');
    assert.equal(await evaluate("return voiceFixture.plays[0].open"),true);
    assert.equal(await evaluate("return voiceFixture.asks[0].question"),'Would two callers reserve the same room?');
    assert.ok(await evaluate("return document.querySelector('.pr-exchange .ui-question')?.dataset.question==='Would two callers reserve the same room?'"),'the sent answer is in the conversation');
    await shot(name+'-speaking');
    const firstCapture=await evaluate("return voiceFixture.captures");
    await evaluate("const panel=document.querySelector('.voice-panel');voiceFixture.phases=[];voiceFixture.observer=new MutationObserver(records=>voiceFixture.phases.push(...records.map(r=>r.oldValue),panel.dataset.state));voiceFixture.observer.observe(panel,{attributes:true,attributeFilter:['data-state'],attributeOldValue:true});voiceFixture.finish(0)");
    await until(()=>evaluate('return voiceFixture.ttsReady===2'),name+' next clip prefetched');
    await evaluate('voiceFixture.drainAudio()');
    await until(()=>evaluate(`return voiceFixture.captures===${firstCapture} && document.querySelector('.voice-panel').textContent.includes('Listening')`),name+' automatically listens after playback');
    assert.ok(await evaluate("voiceFixture.observer.disconnect();return !voiceFixture.phases.includes('preparing')"),'ready audio must not flash Preparing voice between clips');
    assert.equal(await evaluate("return voiceFixture.stops"),0,'playback must not stop the physical microphone');
    assert.ok(await evaluate("return voiceFixture.plays[0].at<voiceFixture.asks[0].closedAt"));
    await evaluate("voiceFixture.autoEnd=false;voiceFixture.previewDelay=0;voiceFixture.finalDelay=0;voiceFixture.level=.08");
    await sleep(1100); await evaluate("voiceFixture.level=0");
    await until(()=>evaluate("return voiceFixture.asks.length===2 && voiceFixture.plays.length>=3"),name+' second question auto-sent without click');
    assert.equal(await evaluate("return voiceFixture.asks[1].closed"),false);
    const beforeInterrupt=await evaluate("return {captures:voiceFixture.captures,plays:voiceFixture.plays.length,pauses:voiceFixture.pauses}");
    // Barge in through the speech level, as a user does; do not use the manual
    // Interrupt button, which bypasses the continuous-mic path under test.
    await evaluate("voiceFixture.level=.08");
    await until(()=>evaluate(`return voiceFixture.pauses>${beforeInterrupt.pauses} && document.querySelector('.voice-panel').textContent.includes('Listening')`),name+' VAD interruption stops playback');
    assert.equal(await evaluate("return voiceFixture.captures"),beforeInterrupt.captures,'VAD interruption reuses the physical microphone');
    assert.equal(await evaluate("return voiceFixture.stops"),0,'VAD interruption must not stop the physical microphone');
    await evaluate("voiceFixture.level=.08"); await sleep(1100); await evaluate("voiceFixture.level=0");
    await until(()=>evaluate("return document.querySelector('.voice-confirmed').textContent==='Would two callers reserve the same room?'"),name+' interrupted follow-up retained');
    await sleep(2400);
    assert.equal(await evaluate("return voiceFixture.asks.length"),2,'busy reply prevents overlapping asks');
    assert.equal(await evaluate("return document.querySelector('.pr-typed textarea').value"),'Would two callers reserve the same room?');
    await evaluate("voiceFixture.asks[1].emit('token',{text:'This sentence must remain silent. '})");
    await sleep(450);
    assert.equal(await evaluate("return voiceFixture.plays.length"),beforeInterrupt.plays,'interrupt suppresses future streamed audio');
    await evaluate("voiceFixture.finish(1)");
    await until(()=>evaluate("return voiceFixture.asks.length===3 && voiceFixture.plays.length>0 && ![...document.querySelectorAll('.pr-voice button')].find(b=>b.textContent==='Interrupt · Esc').hidden"),name+' retained question submits once generation finishes');
    const pausedCapture=await evaluate("return voiceFixture.captures");
    await evaluate("document.querySelector('.pr-voice .voice-mic').click();voiceFixture.finish(2);voiceFixture.drainAudio()");
    await sleep(600);
    assert.equal(await evaluate("return voiceFixture.captures"),pausedCapture,'pause prevents playback completion from reopening microphone');
    assert.ok(await evaluate("return document.querySelector('.voice-panel').textContent.includes('Voice paused')"));
    // Mode selection is a voice join gesture, and switching never erases an unsent draft.
    await evaluate("document.querySelector('.ui-mode-switch[data-mode=typed]').click();const input=document.querySelector('.pr-typed textarea');input.value='Keep this unfinished question';input.dispatchEvent(new Event('input'))");
    await evaluate("document.querySelector('.ui-mode-switch[data-mode=voice]').click()");
    await until(()=>evaluate(`return voiceFixture.captures>${pausedCapture} && document.querySelector('.voice-panel').textContent.includes('Listening')`),name+' selecting voice rejoins');
    assert.equal(await evaluate("return document.querySelector('.voice-confirmed').textContent"),'Keep this unfinished question');
    await evaluate("document.querySelector('.pr-voice .voice-mic').click()");
    assert.equal(await evaluate("return voiceFixture.asks.length"),3,'mode changes preserve draft without submitting');
    await evaluate("const input=document.querySelector('.pr-typed textarea');input.value='A longer unsent answer about reservation ownership and validation. '.repeat(50);input.dispatchEvent(new Event('input'))");
    for(const width of [1440,390]){
      await send('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:false});
      await evaluate("document.querySelector('.voice-panel').scrollIntoView({block:'center'})");
      const m=await evaluate("const t=document.querySelector('.voice-transcript').getBoundingClientRect(),p=document.querySelector('.voice-panel').getBoundingClientRect();return {overflow:document.scrollingElement.scrollWidth-innerWidth,height:t.height,left:t.left-p.left,right:p.right-t.right}");
      assert.ok(m.overflow<=1&&m.height>0&&m.height<=145&&m.left>=0&&m.right>=-1,JSON.stringify(m));
      await shot(name+'-'+width);
    }
    console.log(name, JSON.stringify(await evaluate("return {firstPlayMs:voiceFixture.plays[0].at,firstDoneMs:voiceFixture.asks[0].closedAt,firstPlayBeforeDone:voiceFixture.plays[0].at<voiceFixture.asks[0].closedAt,acceptedTurns:voiceFixture.asks.length,captures:voiceFixture.captures}")));
  }
  await checkAway();
  console.log('ok — streamed playback before completion, continuous voice, interrupt/pause, delayed previews, drafts, responsive geometry, and the mic released while away');
} finally { socket?.close(); for (const w of pending.values()) clearTimeout(w.timer); for (const p of [chrome, server]) if (p?.exitCode === null) { p.kill(); await Promise.race([new Promise(r => p.once('exit', r)), sleep(1000)]); } await fs.rm(HOME, { recursive: true, force: true }); await cleanupChrome(chrome, PROFILE); }
