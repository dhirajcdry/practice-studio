import { cleanupChrome } from './chrome-cleanup.mjs';
import { checkMockTime } from './mock-time-fixture.mjs';
import { problemDir } from '../server/storage-layout.mjs';
// Real browser wiring, fake interviewer, synthetic cached statement, scratch home.
// No mic and no actual judge submission; verdicts enter through the same event API.
import { checkSidebar } from './check-sidebar.mjs';
import { checkMockVoice } from './mock-voice-fixture.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
const root = path.resolve(new URL('..', import.meta.url).pathname);
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-interview-home-'));
const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-interview-chrome-'));
const serverPort = Number(process.env.STUDIO_CHECK_PORT) || 4193, debugPort = serverPort + 5255;
const origin = `http://127.0.0.1:${serverPort}`, debug = `http://127.0.0.1:${debugPort}`;
let server, chrome, socket, logs = '', sequence = 0;
const pending = new Map();
async function free(port) {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.on('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* starting */ } await sleep(100); }
  const detail = await evaluate("return { chunks:window.streamChunks,modeChunks:window.modeChunks,mode:document.querySelector('.ci-panel')?.dataset.mode, input:document.querySelector('.ci-input')?.value,disabled:document.querySelector('.ci-send')?.disabled,notice:document.querySelector('.ci-notice')?.textContent }; ").catch(() => null);
  throw Error(`Timed out: ${label}\n${JSON.stringify(detail)}\n${logs}`);
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 20000);
  pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
});
async function evaluate(code) {
  const result = await send('Runtime.evaluate', { expression: `(async () => { ${code} })()`, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
try {
  await free(serverPort); await free(debugPort);
  await fs.mkdir(path.join(home, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(home, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  await fs.writeFile(path.join(home, 'cache', 'leetcode', 'two-sum.json'), JSON.stringify({ question: {
    title: 'Two Sum', titleSlug: 'two-sum', questionId: '1', difficulty: 'Easy',
    content: '<p>Find two numbers whose sum is the target.</p>',
    metaData: JSON.stringify({ name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]' } }),
    exampleTestcases: '[2,7,11,15]\n9', codeSnippets: [{ langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n' }],
  } }));
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch = async () => { throw Error('Network disabled in interview check'); }; (await import('./server/index.mjs')).start();"], {
    cwd: root, env: { ...process.env, STUDIO_TTS_PYTHON: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_SCRIPT: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES: path.join(root, 'server/tts/test/fake-helper.mjs'), FAKE_INTERVIEW_TOKEN_MS: '8', FAKE_INTERVIEW_PROMPT: path.join(home, 'provider-calls.jsonl'), STUDIO_HOME: home, STUDIO_PORT: String(serverPort), STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(root, 'server/interview/test/fake-interviewer.mjs'), STUDIO_CODEX_BINARY: path.join(root, 'server/coach/test/bin/fake-codex.mjs') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-4000); });
  await until(async () => (await fetch(origin + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_HEADED === '1' ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(debug + '/json/list')).ok, 'Chrome');
  const tab = (await (await fetch(debug + '/json/list')).json()).find(item => item.type === 'page');
  socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data), task = pending.get(message.id);
    if (task) { clearTimeout(task.timer); pending.delete(message.id); message.error ? task.reject(Error(message.error.message)) : task.resolve(message.result); }
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params;
      const allowed = request.url.startsWith(origin + '/') || /^(about:|data:|blob:)/.test(request.url);
      send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}) }).catch(() => {});
    }
  });
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  // Reject capture rather than fabricating audio. Typed mode remains fully usable.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { window.micAttempts = (window.micAttempts || 0) + 1; throw new DOMException('No mic in check', 'NotAllowedError'); }, configurable: true });" });
  await send('Page.navigate', { url: origin + '/#/p/two-sum' });
  await until(() => evaluate("return !!document.querySelector('.coach-tabs') && !!document.querySelector('.ws-host');"), 'problem');
  // Keep playback deterministic while exercising real fetches and the fake server helper.
  await evaluate(`
    window.ttsRequests = 0; window.systemUtterances = 0; window.audioPlays = 0;
    const originalFetch = window.fetch.bind(window);
    window.fetch = (...args) => { if (args[0] === '/api/tts') window.ttsRequests++; return originalFetch(...args); };
    window.Audio = class { play() { window.audioPlays++; setTimeout(() => this.onended?.(), 20); return Promise.resolve(); } pause() {} removeAttribute() {} };
    window.speechSynthesis.speak = utterance => { window.systemUtterances++; setTimeout(() => utterance.onend?.(), 20); };
    const { createSpeaker } = await import('/js/speech.js');
    window.checkSpeaker = createSpeaker(); window.checkSpeaker.say('Natural speech check.');
  `);
  await until(() => evaluate('return window.audioPlays === 1 && !window.checkSpeaker.speaking;'), 'natural speech');
  assert.equal(await evaluate('return window.ttsRequests;'), 1);
  assert.equal(await evaluate('return window.systemUtterances;'), 0);
  await evaluate(`
    window.checkSpeaker.dispose();
    const priorFetch = window.fetch;
    window.fetch = (...args) => args[0] === '/api/tts/status'
      ? Promise.resolve(new Response(JSON.stringify({ available: false, voices: [], reason: 'Not installed' }))) : priorFetch(...args);
    window.checkSpeaker = (await import('/js/speech.js')).createSpeaker();
    window.checkSpeaker.say('System speech check.');
  `);
  await until(() => evaluate('return window.systemUtterances === 1 && !window.checkSpeaker.speaking;'), 'system speech fallback');
  assert.equal(await evaluate('return window.ttsRequests;'), 1);
  await evaluate('window.checkSpeaker.dispose();');
  await evaluate("(await import('/js/coach.js')).setOpen(true); [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews').click(); document.querySelector('.interview-back')?.click();");
  await until(() => evaluate("return !!document.querySelector('.ci-setup');"), 'start choices');
  // The page is already open, but a missing statement must fail before voice capture.
  const statementFile = path.join(home, 'cache', 'leetcode', 'two-sum.json');
  const statementRecord = await fs.readFile(statementFile, 'utf8');
  const withoutStatement = JSON.parse(statementRecord);
  withoutStatement.question.content = null;
  await fs.writeFile(statementFile, JSON.stringify(withoutStatement));
  await evaluate("window.micAttempts = 0; document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate("return document.querySelector('.ci-notice')?.textContent.includes('cached statement') && [...document.querySelectorAll('.ci-panel button')].some(b=>b.textContent === 'Retry start' && !b.hidden);"), 'missing statement recovery');
  assert.equal(await evaluate('return window.micAttempts;'), 0, 'failed startup must never request the microphone');
  assert.equal(await evaluate("return document.querySelector('.ci-state').textContent;"), 'Interview not started');
  assert.equal(await evaluate("return document.querySelector('.ci-clock').textContent;"), '45:00');
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;"), '');
  if (process.env.STUDIO_CHECK_STARTUP_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(process.env.STUDIO_CHECK_STARTUP_SHOT, Buffer.from(shot.data, 'base64'));
  }
  await fs.writeFile(statementFile, statementRecord);
  await evaluate("[...document.querySelectorAll('.ci-panel button')].find(b=>b.textContent === 'Retry start').click();");
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('Find two numbers') && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'opening');
  await evaluate("document.querySelector('.ci-composer .ui-mode-switch[data-mode=typed]').click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.mode === 'typed' && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'typing after recovered start');
  assert.equal(await evaluate("return document.querySelector('.ci-send').disabled;"), true, 'empty typed draft disables Send');
  const dock = await evaluate("const v=document.querySelector('.interviews-view').getBoundingClientRect(),c=document.querySelector('.ci-composer').getBoundingClientRect();return {gap:v.bottom-c.bottom,bottom:c.bottom,viewport:v.bottom};");
  assert.ok(dock.gap>=-1 && dock.gap<=32, 'Short interviews keep the composer at the bottom: '+JSON.stringify(dock));

  assert.equal(await evaluate("return !!document.querySelector('.coach-bar');"), true, 'shared sidebar stays mounted');
  assert.equal(await evaluate("return !!document.querySelector('.ws .rec-toggle');"), false, 'interview controls leave the editor toolbar');
  const identity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1')); ");
  const callsBeforeNoise = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = '[typing] (keyboard clacking) (clicking) [TAPPING]'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();");
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === '' && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'noise rejected');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), callsBeforeNoise, 'noise must not call provider');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-candidate').length;"), 0, 'noise must not appear in transcript');
  const noiseRecord = await fs.readFile(path.join(problemDir(home,'two-sum'), 'interviews', identity.id, 'turns.jsonl'), 'utf8');
  assert.ok(noiseRecord.includes('skipped_noise'), 'noise retained as a separate audit event');
  // A nested interview composer must never also send the hidden Chat draft.
  // Block unexpected chat requests here even though the scratch provider is fake.
  await evaluate(`
    const draft = document.querySelector('.coach-compose .coach-input');
    draft.value = 'Unsent private chat draft'; draft.dispatchEvent(new Event('input'));
    window.accidentalChatRequests = 0;
    const fetchBeforeKeys = window.fetch;
    window.fetch = (...args) => {
      if (String(args[0]) === '/api/coach/message' && args[1]?.method === 'POST') {
        window.accidentalChatRequests++;
        return Promise.resolve(new Response(JSON.stringify({error:'Unexpected chat send'}), {status:503}));
      }
      return fetchBeforeKeys(...args);
    };
    const input = document.querySelector('.ci-input'); input.value = 'I will use a map.';
    input.dispatchEvent(new Event('input')); input.focus();
  `);
  await send('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, modifiers:4 });
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, modifiers:4 });
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('What will you keep');"), 'reply');
  assert.equal(await evaluate('return window.accidentalChatRequests'), 0, 'interview shortcut must not send hidden Chat');
  assert.equal(await evaluate("return document.querySelector('.coach-compose .coach-input').value"), 'Unsent private chat draft', 'hidden draft preserved');
  // Ctrl+Enter on the Interviews tab itself must not submit that hidden draft either.
  await evaluate("document.querySelector('.coach-tabs [aria-selected=true]').focus()");
  await send('Input.dispatchKeyEvent', { type:'rawKeyDown', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, modifiers:2 });
  await send('Input.dispatchKeyEvent', { type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13, modifiers:2 });
  assert.equal(await evaluate('return window.accidentalChatRequests'), 0, 'sidebar tab does not send hidden Chat');
  await evaluate("const draft=document.querySelector('.coach-compose .coach-input'); draft.value=''; draft.dispatchEvent(new Event('input'))");
  // A deliberately long incremental reply exercises real layout growth while
  // speech is enabled, without calling a model or real audio service.
  await until(() => evaluate("return !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'ready to stream');
  await evaluate(String.raw`
    const prior = window.fetch;
    window.fetch = (url, opts) => {
      if (url !== '/api/interview/turn' || !JSON.parse(opts.body).said.includes('scroll regression')) return prior(url, opts);
      const encoder = new TextEncoder();
      window.streamChunks = 0;
      return Promise.resolve(new Response(new ReadableStream({ async start(controller) {
        const emit = (name, data) => controller.enqueue(encoder.encode('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'));
        emit('accepted', {});
        for (let i = 0; i < 180; i++) {
          emit('token', { text: 'Consider the values already visited and the complement you need.\n' });
          window.streamChunks++;
          await new Promise(resolve => setTimeout(resolve, 35));
        }
        emit('done', {}); controller.close(); window.fetch = prior;
      } }), { headers: { 'Content-Type': 'text/event-stream' } }));
    };
    document.querySelector('.ci-speech').click();
    const input = document.querySelector('.ci-input'); input.value = 'Run the scroll regression'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();
  `);
  await until(() => evaluate("const v=document.querySelector('.interviews-view'); return window.streamChunks > 20 && v.scrollHeight > v.clientHeight + 400 && v.scrollHeight-v.scrollTop-v.clientHeight <= 1;"), 'initial streaming follow');
  const sticky = await evaluate("const h=document.querySelector('.ci-live-header').getBoundingClientRect(), v=document.querySelector('.interviews-view').getBoundingClientRect(); return {top:h.top, bottom:h.bottom, viewTop:v.top, viewBottom:v.bottom,padding:parseFloat(getComputedStyle(document.querySelector('.interviews-view')).paddingTop)};");
  assert.ok(Math.abs(sticky.top - sticky.viewTop - sticky.padding) <= 1 && sticky.bottom < sticky.viewBottom, 'timer and phases remain pinned while transcript scrolls: ' + JSON.stringify(sticky));
  const wheelPoint = await evaluate("const r=document.querySelector('.interviews-view').getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2};");
  await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...wheelPoint, deltaX: 0, deltaY: -1 });
  await sleep(150);
  const held = await evaluate("return {top:document.querySelector('.interviews-view').scrollTop,chunks:window.streamChunks};");
  await until(() => evaluate(`return window.streamChunks > ${held.chunks + 10};`), 'tokens while reading');
  assert.ok(Math.abs(await evaluate("return document.querySelector('.interviews-view').scrollTop;") - held.top) <= 1, 'tiny upward wheel holds exact position while tokens arrive');
  await evaluate("document.querySelector('.ci-log').focus({preventScroll:true});");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35 });
  await until(() => evaluate("const v=document.querySelector('.interviews-view'); return v.scrollHeight-v.scrollTop-v.clientHeight <= 1;"), 'return to bottom');
  const resumedAt = await evaluate('return window.streamChunks;');
  await until(() => evaluate(`return window.streamChunks > ${resumedAt + 10};`), 'continued stream');
  const followGaps = await evaluate(`
    const gaps = [];
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setTimeout(resolve, 17));
      const v = document.querySelector('.interviews-view');
      gaps.push(v.scrollHeight - v.scrollTop - v.clientHeight);
    }
    return gaps;
  `);
  assert.ok(followGaps.every(gap => gap <= 1), 'following resumes across new tokens and speech status changes: ' + JSON.stringify(followGaps));
  await until(() => evaluate("return !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'stream complete');
  await evaluate("document.querySelector('.ci-speech').click();");
  // Switch while a response is actually streaming; old response snapshots cannot
  // overwrite the new mode, and unsent text must never become an automatic answer.
  await evaluate(String.raw`
    const previousFetch = window.fetch;
    window.fetch = (url, opts) => {
      if (url !== '/api/interview/turn' || JSON.parse(opts.body).said !== 'mode switch regression') return previousFetch(url, opts);
      const encoder = new TextEncoder(); window.modeChunks = 0;
      return Promise.resolve(new Response(new ReadableStream({ async start(controller) {
        const emit = (name, data) => controller.enqueue(encoder.encode('event: ' + name + '\ndata: ' + JSON.stringify(data) + '\n\n'));
        emit('accepted', {});
        const chunks=['Check '+String.fromCharCode(96)+'get_', 'balance'+String.fromCharCode(96)+' and **available', ' funds**.\n\n', '- Reject expired holds.\n', '- Preserve ownership.\n\n'];
        for (let i=0; i<50; i++) { emit('token', {text:chunks[i%chunks.length]}); window.modeChunks++; await new Promise(resolve=>setTimeout(resolve,40)); }
        emit('done', {state:{mode:'voice'}}); window.fetch = previousFetch; controller.close();
      } }), {headers:{'Content-Type':'text/event-stream'}}));
    };
    const input=document.querySelector('.ci-input'); input.value='mode switch regression'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();
  `);
  await until(() => evaluate('return window.modeChunks > 2 && window.modeChunks < 50;'), 'mode test streaming');
  const switchIdentity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  await evaluate("document.querySelector('.ci-composer .ui-mode-switch[data-mode=voice]').click();");
  assert.ok(await evaluate("return document.querySelector('.ci-typed').hidden && !document.querySelector('.ci-voice').hidden && window.modeChunks<50;"), 'voice switch takes effect during reply');
  await evaluate("document.querySelector('.ci-composer .ui-mode-switch[data-mode=typed]').click(); const input=document.querySelector('.ci-input'); input.value='Unsent next thought'; input.dispatchEvent(new Event('input'));");
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.mode;"), 'typed');
  await until(() => evaluate("return window.modeChunks===50 && document.querySelector('.ci-mode-status').hidden && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'mode persisted after stream');
  assert.ok(await evaluate("const reply=[...document.querySelectorAll('.ci-entry:not(.ci-candidate) .ci-text')].at(-1);return reply.querySelector('code')?.textContent==='get_balance' && reply.querySelector('strong')?.textContent==='available funds' && reply.querySelectorAll('li').length===20 && reply.dataset.markdown.includes('`get_balance`');"), 'split Markdown tokens render as code, emphasis and lists without losing the raw reply');
  assert.equal(await evaluate("return document.querySelector('.ci-input').value;"), 'Unsent next thought');
  const switched = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  assert.equal(switched.id, switchIdentity.id); assert.equal(switched.startedAt, switchIdentity.startedAt); assert.equal(switched.mode, 'typed');
  await evaluate("const input=document.querySelector('.ci-input'); input.value=''; input.dispatchEvent(new Event('input'));");
  // Read older transcript content while background status polls keep running.
  await evaluate(`
    const text = document.querySelector('.ci-text');
    window.scrollFixtureText = text.textContent;
    text.textContent += ' ' + 'Earlier interview context. '.repeat(1000);
    const log = document.querySelector('.ci-log');
    log.focus({ preventScroll: true });
    const listViewport = document.querySelector('.interviews-view');
    listViewport.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, bubbles: true }));
    listViewport.scrollTop = 0;
    window.detachedInterviewRows = 0; window.idlePolls = 0;
    window.rowObserver = new MutationObserver(records => {
      window.detachedInterviewRows += records.reduce((n, record) => n + record.removedNodes.length, 0);
    });
    window.rowObserver.observe(document.querySelector('.interview-list'), { childList: true });
    const fetchBeforeScrollCheck = window.fetch;
    window.fetch = async (...args) => {
      const response = await fetchBeforeScrollCheck(...args);
      if (args[0] === '/api/interview/event') window.idlePolls++;
      return response;
    };
  `);
  assert.equal(await evaluate("return document.querySelector('.ci-log').scrollHeight <= document.querySelector('.ci-log').clientHeight + 1;"), true, 'transcript has no nested scroll range');
  async function wheelOver(selector, deltaY) {
    const point = await evaluate(`
      const rect = document.querySelector('${selector}').getBoundingClientRect();
      const view = document.querySelector('.interviews-view').getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round((Math.max(rect.top, view.top) + Math.min(rect.bottom, view.bottom)) / 2) };
    `);
    const before = await evaluate("return document.querySelector('.interviews-view').scrollTop;");
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY });
    await until(() => evaluate(`return document.querySelector('.interviews-view').scrollTop ${deltaY > 0 ? '>' : '<'} ${before};`), 'wheel over ' + selector);
  }
  await wheelOver('.ci-header', 180);
  await wheelOver('.ci-log', -120);
  await sleep(300); // Let the native wheel animation finish before pinning the reading fixture.
  await evaluate(`
    document.querySelector('.interviews-view').scrollTop = 120;
    window.readingPosition = document.querySelector('.interviews-view').scrollTop;
    window.listReadingPosition = window.readingPosition;
  `);
  await until(() => evaluate('return window.idlePolls >= 2;'), 'two background updates while reading');
  assert.equal(await evaluate('return window.detachedInterviewRows;'), 0, 'background updates never detach the expanded interview');
  assert.equal(await evaluate("return document.querySelector('.interviews-view').scrollTop;"), await evaluate('return window.readingPosition;'), 'background updates preserve transcript scroll');
  assert.equal(await evaluate("return document.querySelector('.interviews-view').scrollTop;"), await evaluate('return window.listReadingPosition;'), 'background updates preserve outer list scroll');
  assert.equal(await evaluate("return document.activeElement === document.querySelector('.ci-log');"), true, 'background updates preserve focus');
  await evaluate(`
    window.entriesBeforeReadingReply = document.querySelectorAll('.ci-entry').length;
    const input = document.querySelector('.ci-input'); input.value = 'I will check the space complexity.';
    input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();
  `);
  await until(() => evaluate("return document.querySelectorAll('.ci-entry').length >= window.entriesBeforeReadingReply + 2 && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'new reply while reading older transcript');
  assert.equal(await evaluate("return document.querySelector('.interviews-view').scrollTop;"), await evaluate('return window.readingPosition;'), 'new replies do not pull a reader to the bottom');
  await evaluate("window.rowObserver.disconnect(); document.querySelector('.ci-text').textContent = window.scrollFixtureText;");
  await evaluate("const input = document.querySelector('.ci-input'); input.value = 'Draft survives reload'; input.dispatchEvent(new Event('input')); ");
  await sleep(1100); await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === 'Draft survives reload';"), 'draft recovery');
  const after = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1')); ");
  assert.equal(after.startedAt, identity.startedAt, 'reload never resets wall clock');
  assert.equal(after.id, identity.id);
  const verdict = await fetch(origin + '/api/interview/event', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'two-sum', interviewId: identity.id, event: { type: 'verdict', verdict: 'Accepted', secondsSinceSpeech: 40, secondsSinceTyping: 40 } }) });
  assert.match(await verdict.text(), /It passed/);
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('It passed');"), 'persisted verdict interjection');
  const heights = await evaluate("return [...document.querySelectorAll('.ci-toolbar button')].filter(n => n.getClientRects().length).map(n => n.getBoundingClientRect().height);");
  assert.ok(heights.length > 1 && Math.max(...heights) - Math.min(...heights) <= 1, 'panel buttons share control height');
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.classList.contains('ci-finish')).click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true';"), 'debrief');
  // Finishing opens the full report; the sidebar keeps a compact summary.
  await until(() => evaluate("return !!document.querySelector('.rp-sheet[open] .rp-signal');"), 'report opens on finish');
  const report = await evaluate("return document.querySelector('.rp-sheet').textContent;");
  for (const section of ['Lean hire', 'Problem solving', 'Coding', 'Communication', 'Testing', 'What went well', 'Fix these three', 'Box score', 'Play by play', 'Your code']) assert.ok(report.includes(section), section);
  assert.equal(await evaluate("return document.querySelectorAll('.rp-dim-row').length;"), 4, 'four scored dimensions');
  assert.equal(await evaluate("return document.querySelector('.rp-graded')?.textContent;"), 'Graded at Beginner', 'the report says which difficulty graded it');
  assert.equal(await evaluate("return document.querySelector('.rp-signal').textContent;"), 'Lean hire', 'the report signal itself stays the raw signal');
  // An older record has no difficulty, so nothing is claimed about it.
  const graded = await evaluate(`
    const { renderReport } = await import('/js/interview-report.js');
    const saved = await (await fetch('/api/interview/two-sum/' + document.querySelector('.ci-panel').dataset.interviewId)).json();
    const label = reportDifficulty => {
      const body = renderReport({ title: 'Two Sum', record: { ...saved, reportDifficulty }, report: saved.report });
      return body.querySelector('.rp-graded')?.textContent ?? null;
    };
    return { old: label(undefined), midLevel: label('mid-level'), unknown: label('nonsense') };
  `);
  assert.deepEqual(graded, { old: null, midLevel: 'Graded at Mid-level', unknown: null }, 'report label by difficulty');
  await evaluate("document.querySelector('.rp-dim-row').click();");
  assert.equal(await evaluate("return document.querySelector('.rp-quote')?.textContent;"), 'I will use a map.', 'a verified quote is shown as a quote');
  await evaluate(`const { checkReportLayout } = await import('/js/interview-report.test.js');
    checkReportLayout((label, passed) => { if (!passed) throw Error(label); });`);
  // Follow-up questions: the weakest area is offered first, answers stream in and persist.
  assert.ok(await evaluate("return !!document.querySelector('.rp-ask-starter');"), 'report offers follow-up questions');
  const askLayout = await evaluate(`const r = document.querySelector('.rp-scroll').getBoundingClientRect(), a = document.querySelector('.rp-ask').getBoundingClientRect(), m = document.querySelector('.rp-main').getBoundingClientRect();
    return { beside: a.left >= r.right - 1, inside: a.right <= m.right + 0.5, fullHeight: Math.abs(a.height - m.height) < 1 };`);
  assert.deepEqual(askLayout, { beside: true, inside: true, fullHeight: true }, 'question panel docks beside the report, full height');
  // Dragging the divider widens the panel and keeps the report readable.
  const dragged = await evaluate(`const h = document.querySelector('.rp-ask-resize'), b = h.getBoundingClientRect(), y = b.top + b.height / 2, before = document.querySelector('.rp-ask').getBoundingClientRect().width;
    const at = (type, x) => h.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, button: 0, clientX: x, clientY: y }));
    try { h.setPointerCapture = () => {}; } catch {}
    at('pointerdown', b.left); at('pointermove', b.left - 200); at('pointerup', b.left - 200);
    const after = document.querySelector('.rp-ask').getBoundingClientRect().width;
    return { wider: after > before + 150, report: document.querySelector('.rp-scroll').getBoundingClientRect().width >= 360 };`);
  assert.deepEqual(dragged, { wider: true, report: true }, 'the panel divider resizes it');
  await evaluate("document.querySelector('.rp-ask-resize').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));");
  // Hiding the panel gives the report the whole sheet; the header button brings it back.
  await evaluate("document.querySelector('.rp-ask-hide').click();");
  assert.equal(await evaluate("return document.querySelector('.rp-ask').hidden && document.querySelector('.rp-ask-toggle').getAttribute('aria-pressed');"), 'false', 'the panel hides');
  await evaluate("document.querySelector('.rp-ask-toggle').click();");
  assert.equal(await evaluate("return !document.querySelector('.rp-ask').hidden && document.querySelector('.rp-ask-toggle').getAttribute('aria-pressed');"), 'true', 'the header button brings the panel back');
  await evaluate("[...document.querySelectorAll('.rp-dim-row')].find(n => n.textContent.startsWith('Testing')).click();");
  const scrollBefore = await evaluate("const s = document.querySelector('.rp-scroll'); s.scrollTop = 600; return s.scrollTop;");
  await evaluate("document.querySelector('.rp-dim-ask').click();");
  assert.equal(await evaluate("return document.querySelector('.rp-scroll').scrollTop;"), scrollBefore, 'asking leaves the report where it was');
  await until(() => evaluate("return document.querySelector('.rp-ask .cmsg.reply .cmsg-body')?.textContent.includes('[3,3], 6');"), 'follow-up answer streams in');
  assert.equal(await evaluate("return document.querySelector('.rp-ask-starters').hidden;"), true, 'suggestions give way to the thread');
  await evaluate("const i = document.querySelector('.rp-ask-input'); i.value = 'An unsent follow-up'; i.dispatchEvent(new Event('input'));");
  if (process.env.STUDIO_CHECK_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(process.env.STUDIO_CHECK_SHOT.replace(/\.png$/, '-ask.png'), Buffer.from(shot.data, 'base64'));
  }
  await evaluate("document.querySelector('.rp-sheet[open] .ui-dialog-close[aria-label=\"Close report\"]').click();");
  await until(() => evaluate("return !document.querySelector('.rp-sheet[open]');"), 'report closes with a draft');
  await evaluate("document.querySelector('.ci-open-report').click();");
  await until(() => evaluate("return document.querySelector('.rp-sheet[open] .rp-ask .cmsg.reply .cmsg-body')?.textContent.includes('[3,3], 6');"), 'answered follow-up survives reopening');
  assert.equal(await evaluate("return document.querySelector('.rp-ask-input').value;"), 'An unsent follow-up', 'unsent question survives reopening');
  await evaluate("const i = document.querySelector('.rp-ask-input'); i.value = ''; i.dispatchEvent(new Event('input'));");
  await evaluate("document.querySelector('.rp-sheet[open] .ui-dialog-close[aria-label=\"Close report\"]').click();");
  await until(() => evaluate("return !document.querySelector('.rp-sheet[open]');"), 'report closes');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-mini-dim').length;"), 4, 'sidebar summary');
  assert.deepEqual(await evaluate("const c = document.querySelector('.ci-score-hero .ui-badge'); return { text: c.textContent, success: c.classList.contains('ui-badge--success') };"), { text: 'Lean hire (Beginner)', success: true }, 'sidebar chip names the difficulty and keeps the raw tone');
  assert.equal(await evaluate("return !!document.querySelector('.ci-log');"), true, 'closing the report leaves the transcript in the sidebar');
  const debrief = await evaluate("return document.querySelector('.ci-feedback').textContent;");
  await evaluate("window.sidebarBefore = document.querySelector('.coach'); [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Chat').click();");
  assert.equal(await evaluate("return document.querySelector('.coach') === window.sidebarBefore;"), true, 'tab switching preserves the sidebar');
  await evaluate("[...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews').click();");
  assert.equal(await evaluate("return document.querySelector('.ci-feedback').textContent;"), debrief, 'switching tabs retains feedback');
  // Report difficulty lives on the server. Real routes against the scratch home.
  const difficultyOnServer = async () => (await (await fetch(origin + '/api/report/difficulty')).json()).difficulty;
  const difficultySeg = "document.querySelector('.settings .set-seg[aria-label=\"Report difficulty\"]')";
  const difficultyButtons = `[...${difficultySeg}.querySelectorAll('button')].map(b => ({ text: b.textContent, pressed: b.getAttribute('aria-pressed'), disabled: b.disabled }))`;
  const difficultyLoaded = () => until(() => evaluate(`return ${difficultySeg}?.getAttribute('aria-busy') === 'false';`), 'report difficulty loaded');
  assert.equal(await difficultyOnServer(), 'beginner', 'difficulty defaults to Beginner');
  // Held read: nothing is shown as selected, and nothing can be clicked, until the server answers.
  await evaluate(`
    window.fetchBeforeDifficulty = window.fetch;
    window.releaseDifficulty = null;
    const gate = new Promise(resolve => { window.releaseDifficulty = resolve; });
    window.fetch = async (...args) => { if (args[0] === '/api/report/difficulty') await gate; return window.fetchBeforeDifficulty(...args); };
    (await import('/js/settings.js')).openSettings();
  `);
  await until(() => evaluate(`return !!${difficultySeg};`), 'report difficulty control');
  assert.deepEqual(await evaluate(`return ${difficultyButtons};`), [
    { text: 'Beginner', pressed: 'false', disabled: true }, { text: 'Mid-level', pressed: 'false', disabled: true },
  ], 'no selection is painted while loading');
  await evaluate('window.releaseDifficulty(); window.fetch = window.fetchBeforeDifficulty;');
  await difficultyLoaded();
  assert.deepEqual(await evaluate(`return ${difficultyButtons};`), [
    { text: 'Beginner', pressed: 'true', disabled: false }, { text: 'Mid-level', pressed: 'false', disabled: false },
  ], 'both options render with the saved one selected');
  // No overflow in the Settings panel, in any theme, at desktop and phone widths.
  const themeNow = await evaluate("return (await import('/js/settings.js')).getSettings().theme;");
  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    for (const theme of await evaluate("return (await import('/js/settings.js')).THEMES.map(t => t.id);")) {
      const box = await evaluate(`
        (await import('/js/settings.js')).setSetting('theme', ${JSON.stringify(theme)});
        await new Promise(requestAnimationFrame);
        const body = document.querySelector('.set-body'), seg = ${difficultySeg}, b = body.getBoundingClientRect(), s = seg.getBoundingClientRect();
        const heights = [...seg.children].map(n => n.getBoundingClientRect().height);
        // Compare, not absolute: other Settings rows have their own overflow in some themes.
        const notice = document.querySelector('.settings .set-notice'), blurb = notice.nextElementSibling;
        const scrollWith = body.scrollWidth; seg.style.display = 'none'; blurb.style.display = 'none'; const scrollWithout = body.scrollWidth; seg.style.display = ''; blurb.style.display = '';
        return { width: ${width}, theme: ${JSON.stringify(theme)}, inside: s.left >= b.left && s.right <= b.right && blurb.getBoundingClientRect().right <= b.right, noBodyOverflow: scrollWith === scrollWithout, noSegOverflow: seg.scrollWidth <= seg.clientWidth, oneRow: new Set([...seg.children].map(n => n.getBoundingClientRect().top)).size === 1, sameHeight: Math.max(...heights) - Math.min(...heights) <= .5 };
      `);
      assert.deepEqual(box, { width, theme, inside: true, noBodyOverflow: true, noSegOverflow: true, oneRow: true, sameHeight: true }, 'report difficulty fits the Settings panel');
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate(`(await import('/js/settings.js')).setSetting('theme', ${JSON.stringify(themeNow)});`);
  // A failed save reverts, says so, and changes nothing on the server.
  await evaluate(`
    window.fetch = (...args) => args[0] === '/api/report/difficulty' && args[1]?.method === 'PUT'
      ? Promise.resolve(new Response(JSON.stringify({ error: { message: 'Fixture unavailable' } }), { status: 503 })) : window.fetchBeforeDifficulty(...args);
    ${difficultySeg}.querySelector('[data-difficulty="mid-level"]').click();
  `);
  await until(() => evaluate("const n = document.querySelector('.settings .set-notice'); return !n.hidden && n.textContent.includes('Could not save');"), 'failed save is reported');
  await difficultyLoaded();
  assert.deepEqual((await evaluate(`return ${difficultyButtons};`)).map(b => b.pressed), ['true', 'false'], 'a failed save reverts the selection');
  assert.equal(await difficultyOnServer(), 'beginner', 'a failed save changes nothing');
  await evaluate('window.fetch = window.fetchBeforeDifficulty;');
  // A real save clears the error and persists on the server across reopening.
  await evaluate(`${difficultySeg}.querySelector('[data-difficulty="mid-level"]').click();`);
  await until(async () => await difficultyOnServer() === 'mid-level', 'click saves the difficulty');
  await difficultyLoaded();
  assert.equal(await evaluate("return document.querySelector('.settings .set-notice').hidden;"), true, 'a successful save clears the error');
  await evaluate("(await import('/js/settings.js')).closeSettings(); (await import('/js/settings.js')).openSettings();");
  await difficultyLoaded();
  assert.deepEqual((await evaluate(`return ${difficultyButtons};`)).map(b => b.pressed), ['false', 'true'], 'the choice persists across reopening');
  await evaluate("(await import('/js/settings.js')).closeSettings();");
  assert.ok(!/difficulty/i.test(await evaluate("return localStorage.getItem('studio.settings.v1') || '';")), 'report difficulty never enters localStorage settings');
  // Simulate a reload before the browser received the final completion event.
  // The server has the debrief, but local storage still claims this interview is live.
  await evaluate(`localStorage.setItem('studio.interview.active.v1', ${JSON.stringify(JSON.stringify(identity))});`);
  const gate = await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    const fetchInterview = window.fetch.bind(window);
    window.loadingMutations = 0;
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    window.releaseInterviewLoad = release;
    window.fetch = async (...args) => {
      if (/^\\/api\\/interview\\/two-sum\\//.test(args[0])) { window.interviewLoadWaiting = true; await ready; }
      if (args[0] === '/api/interview/event') window.loadingMutations++;
      return fetchInterview(...args);
    };
  ` });
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate('return window.interviewLoadWaiting;'), 'delayed interview load');
  await sleep(1300);
  assert.equal(await evaluate('return window.loadingMutations;'), 0, 'loading must not start background turns');
  assert.equal(await evaluate("return document.querySelector('.ci-send').disabled;"), true, 'loading locks answer controls');
  await evaluate('window.releaseInterviewLoad();');
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true' && !localStorage.getItem('studio.interview.active.v1');"), 'completed reload clears stale active identity');
  assert.equal(await evaluate("return document.querySelector('.ci-feedback').textContent;"), debrief, 'reload retains the entire debrief');
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: gate.identifier });

  await evaluate("document.querySelector('.interview-back').click();");
  // A transient read failure must offer a working reload action, not trap the panel.
  await evaluate(`
    const readInterview = window.fetch.bind(window);
    let failRead = true;
    window.fetch = (...args) => {
      if (failRead && String(args[0]).startsWith('/api/interview/two-sum/')) {
        failRead = false;
        return Promise.resolve(new Response(JSON.stringify({ error: { message: 'Fixture load unavailable' } }), { status: 503 }));
      }
      return readInterview(...args);
    };
    (await import('/js/interview.js')).openInterviewRecord('two-sum', ${JSON.stringify(identity.id)});
  `);
  await until(() => evaluate("return document.querySelector('.ci-notice')?.textContent.includes('Fixture load unavailable');"), 'load failure notice');
  await evaluate("[...document.querySelectorAll('.ci-panel button')].find(n => n.textContent === 'Retry loading').click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true' && document.querySelector('.ci-notice').hidden;"), 'load retry recovers transcript');

  // Starting again while the completed debrief is visible must replace that panel.
  await evaluate("(await import('/js/coach.js')).setOpen(true); [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews').click(); document.querySelector('.interview-back')?.click();");
  await until(() => evaluate("return !!document.querySelector('.ci-setup');"), 'new interview from debrief');
  await evaluate("document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate(`return document.querySelector('.ci-panel')?.dataset.interviewId && document.querySelector('.ci-panel').dataset.interviewId !== ${JSON.stringify(identity.id)} && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;`), 'new interview replaces debrief');
  await evaluate("const input=document.querySelector('.ci-input'); input.value='I will use a map.'; input.dispatchEvent(new Event('input'));");
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.classList.contains('ci-finish')).click();");
  await until(() => evaluate("return !!document.querySelector('.ci-debrief .ci-streaming')?.textContent;"), 'debrief streams before completion');
  const partial = await evaluate("return document.querySelector('.ci-debrief .ci-text').textContent;");
  const secondId = await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;");
  await fetch(origin + '/api/interview/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'two-sum', interviewId: secondId }) });
  await until(() => evaluate("return document.querySelector('.ci-notice')?.textContent.includes('stopped');"), 'stopped debrief notice');
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.debriefed;"), 'false', 'stopped debrief stays unfinished');
  assert.ok(await evaluate("return document.querySelector('.ci-debrief .ci-text').textContent.trim().length > 0;"), 'partial remains visible');
  const partialRecord = (await fs.readFile(path.join(problemDir(home,'two-sum'), 'interviews', secondId, 'turns.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)).find(row => row.kind === 'partial');
  assert.equal(partial, 'Writing your report…', 'the raw report never streams into the transcript');
  assert.ok(partialRecord.asked.startsWith('{"signal"'), 'saved partial retains the streamed report');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-notice')?.textContent.includes('last reply did not finish');"), 'partial reload recovery');
  assert.ok(await evaluate("return document.querySelector('.ci-entry.ci-debrief')?.textContent.includes('interrupted');"), 'saved partial is labelled');
  await evaluate("[...document.querySelectorAll('.ci-panel button')].find(n => n.textContent === 'Retry reply').click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true';"), 'retried second debrief');
  assert.equal(await evaluate("return document.querySelectorAll('.interview-row').length;"), 2, 'past interviews remain listed');
  // The list keeps each interview's own difficulty: the setting changed between these two.
  const rowBadge = id => `document.querySelector('.interview-row[data-interview-id="${id}"] .interview-status')`;
  await until(() => evaluate(`return ${rowBadge(identity.id)}?.textContent === 'Lean hire (Beginner)' && ${rowBadge(secondId)}?.textContent === 'Lean hire';`), 'list labels by difficulty');
  assert.ok(await evaluate(`return ${rowBadge(identity.id)}.classList.contains('ui-badge--success') && ${rowBadge(secondId)}.classList.contains('ui-badge--success');`), 'list tone stays on the raw signal');
  assert.equal(await evaluate("return document.querySelector('.ci-score-hero .ui-badge').textContent;"), 'Lean hire', 'no suffix at Mid-level');
  // History is an accordion, and inspecting it is read-only.
  const callsBeforeHistory = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate(`document.querySelector('.interview-back')?.click(); document.querySelector('.interview-row[data-interview-id="${identity.id}"] .interview-row-summary').click();`);
  await until(() => evaluate(`return document.querySelector('.ci-panel')?.dataset.interviewId === ${JSON.stringify(identity.id)} && document.querySelector('.ci-panel').dataset.debriefed === 'true';`), 'older interview opens full pane');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-panel').length;"), 1, 'one detail view');
  assert.equal(await evaluate("return document.querySelector('.ci-feedback').textContent;"), debrief, 'older feedback is unchanged');
  await evaluate("document.querySelector('.interview-back').click();");
  assert.equal(await evaluate("return document.querySelectorAll('.ci-panel').length;"), 0, 'back returns to list');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), callsBeforeHistory, 'history never calls the interviewer');

  // Fresh sessions and paused sessions remain separate records in the same list.
  await evaluate("document.querySelector('.interview-back')?.click(); document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate("return document.querySelector('.ci-input') && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'third opening');
  const thirdId = await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;");
  await evaluate("const input=document.querySelector('.ci-input'); input.value='Saved paused answer'; input.dispatchEvent(new Event('input')); [...document.querySelectorAll('.ci-toolbar button')].find(n=>n.getAttribute('aria-label')==='Pause interview').click();");
  await until(() => evaluate("return !document.querySelector('.ci-paused')?.hidden;"), 'paused badge');
  await evaluate("document.querySelector('.interview-back')?.click(); document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate(`return document.querySelector('.ci-panel')?.dataset.interviewId !== ${JSON.stringify(thirdId)} && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;`), 'fresh fourth opening');
  const fourthId = await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;");
  await evaluate(`document.querySelector('.interview-back')?.click(); document.querySelector('.interview-row[data-interview-id="${thirdId}"] .interview-row-summary').click();`);
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === 'Saved paused answer';"), 'paused draft restored');
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n=>n.getAttribute('aria-label')==='Resume interview').click();");
  await until(() => evaluate(`return document.querySelector('.interview-row[data-interview-id="${fourthId}"] .interview-status')?.textContent === 'Paused' && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;`), 'resume pauses other interview');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`return document.querySelector('.coach')?.dataset.sidebarTab === 'interviews' && document.querySelector('.ci-panel')?.dataset.interviewId === ${JSON.stringify(thirdId)} && document.querySelector('.ci-input')?.value === 'Saved paused answer';`), 'selected row and tab survive reload');
  assert.equal(await evaluate("return document.querySelectorAll('.interview-row').length;"), 4, 'all interviews remain listed');
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.classList.contains('ci-finish')).click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true';"), 'resumed interview completes');
  await checkSidebar(expression => evaluate('return ' + expression));
  // The list itself, not just an open interview: four cards, one of them paused.
  await evaluate("document.querySelector('.interview-back').click();");
  await until(() => evaluate("return !document.querySelector('.interviews-overview').hidden;"), 'interview list shown');
  // The longest label must fit its row beside the date, even in a narrow sidebar.
  const rowFit = await evaluate(`
    const view = document.querySelector('.interviews-view'), badge = ${rowBadge(identity.id)}, top = badge.closest('.interview-row-top'), title = top.querySelector('strong');
    const saved = { text: badge.textContent, width: view.style.width };
    const measure = width => {
      view.style.width = width; badge.textContent = 'Strong hire (Beginner)';
      const b = badge.getBoundingClientRect(), t = title.getBoundingClientRect(), r = top.getBoundingClientRect();
      return { insideRow: b.right <= r.right + .5 && b.left >= r.left - .5, clearOfDate: b.left >= t.right - .5 || b.top >= t.bottom - .5, viewWidth: view.getBoundingClientRect().width };
    };
    const results = [measure(''), measure('280px')];
    view.style.width = saved.width; badge.textContent = saved.text;
    return results;
  `);
  console.log('Report difficulty list row', JSON.stringify(rowFit));
  for (const row of rowFit) assert.ok(row.insideRow && row.clearOfDate, 'list label fits its row: ' + JSON.stringify(row));
  await checkSidebar(expression => evaluate('return ' + expression));

  await evaluate("[...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Chat').click();");
  await until(() => evaluate("return !document.querySelector('.coach-compose').hidden;"), 'restored coach');
  await checkSidebar(expression => evaluate('return ' + expression));
  // Voice footer: real speaker state with fake playback and denied fake capture.
  await evaluate(`
    window.speechSynthesis.speak = utterance => { window.pendingInterviewSpeech = utterance; };
    window.micAttempts = 0;
    [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews').click();
    document.querySelector('.interview-back')?.click();
    document.querySelector('.ci-setup [aria-label^="Answer mode"]').click();
    [...document.querySelectorAll('.ui-menu-item')].find(n => n.textContent.includes('Voice')).click();
    document.querySelector('.ci-setup form').requestSubmit();
  `);
  await until(() => evaluate('return !!window.pendingInterviewSpeech;'), 'voice playback');
  assert.ok(await evaluate("const mic=document.querySelector('.ci-voice .voice-mic');return !mic.hidden && mic.getClientRects().length>0 && [...document.querySelectorAll('.ci-voice button')].some(n=>n.textContent==='Interrupt · Esc'&&!n.hidden);"), 'speaking keeps microphone and interrupt controls available');
  assert.equal(await evaluate("return document.querySelector('.ci-voice').textContent.includes('Hold Esc');"), false, 'no permanent interrupt instruction');
  await evaluate("[...document.querySelectorAll('.ci-voice button')].find(n => n.textContent === 'Interrupt · Esc').click();");
  await until(() => evaluate("return !document.querySelector('.ci-voice .vc-status').hidden && document.querySelector('.ci-voice .voice-state').textContent === 'Microphone off';"), 'microphone failure stays inline');
  assert.equal(await evaluate('return window.micAttempts;'), 1, 'permission failure never loops');
  // A voice answer can be sent without waiting for the silence that sends it on its own.
  const setVoiceDraft = text => evaluate(`const input = document.querySelector('.ci-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input'));`);
  await setVoiceDraft('Sort by position, then count fleets from the front.');
  await until(() => evaluate("const b = document.querySelector('.ci-send-now'); return !b.hidden && b.getClientRects().length > 0 && !b.disabled;"), 'voice draft offers Send');
  const sendRow = await evaluate(`const centre = n => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; };
    const send = document.querySelector('.ci-send-now'), mic = document.querySelector('.ci-voice .voice-mic');
    const panel = document.querySelector('.ci-voice').getBoundingClientRect();
    return { aligned: Math.abs(centre(send) - centre(mic)) <= 1, inside: send.getBoundingClientRect().right <= panel.right + 0.5 };`);
  assert.deepEqual(sendRow, { aligned: true, inside: true }, 'Send sits on the microphone row, inside the panel');
  if (process.env.STUDIO_CHECK_SHOT) {
    const clip = await evaluate(`document.querySelectorAll('dialog[open]').forEach(d => d.close());
      const r = document.querySelector('.ci-composer').getBoundingClientRect(); return { x: r.x - 8, y: r.y - 8, width: r.width + 16, height: r.height + 16, scale: 2 };`);
    const shot = await send('Page.captureScreenshot', { format: 'png', clip });
    await fs.writeFile(process.env.STUDIO_CHECK_SHOT, Buffer.from(shot.data, 'base64'));
  }
  await setVoiceDraft('');
  await until(() => evaluate("return document.querySelector('.ci-send-now').hidden;"), 'Send hides with nothing to send');
  const barHeight = await evaluate("document.querySelector('.ci-voice .vc-status').hidden = true; return document.querySelector('.ci-composer').getBoundingClientRect().height;");
  assert.ok(barHeight <= 72, `an idle voice bar stays one line: ${barHeight}px`);
  console.log('idle voice bar', barHeight);
  await checkSidebar(expression => evaluate('return ' + expression));
  const beforeEmptyFinish = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate("document.querySelector('.ci-finish').click();");
  await until(() => evaluate("return document.querySelector('.ci-feedback')?.textContent.includes('No report was generated');"), 'empty session completes without report');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), beforeEmptyFinish, 'empty finish does not call provider');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-mini-dim, .ci-dimension, .ci-open-report').length;"), 0, 'empty interview has no ratings or report button');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-feedback')?.textContent.includes('No report was generated');"), 'empty completion survives reload');
  // Deliberate silence: the microphone stays open while the reply is decided, and no
  // bubble, spoken line or failure notice follows. Capture and ASR are browser fakes.
  await evaluate(`
    window.openingCaptures=0;window.openingStops=0;window.openingLevel=0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => {window.openingCaptures++;return { getTracks: () => [{ stop() {window.openingStops++;}, addEventListener() {} }] };}, configurable: true });
    window.MediaRecorder = class extends EventTarget { constructor() { super(); this.mimeType = 'audio/webm'; } start() {} requestData() { const e = new Event('dataavailable'); e.data = new Blob(['x']); this.dispatchEvent(e); } stop() { queueMicrotask(() => { this.requestData(); this.dispatchEvent(new Event('stop')); }); } static isTypeSupported() { return true; } };
    window.AudioContext = class { constructor() { this.state = 'running'; } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(a) { a.fill(window.openingLevel); } }; } close() {} };
    const beforeVoiceFetch=window.fetch;
    window.fetch=(...args)=>String(args[0]).includes('/api/asr')?Promise.resolve(new Response(JSON.stringify({text:''}),{headers:{'content-type':'application/json'}})):beforeVoiceFetch(...args);
    window.speechSynthesis.speak = utterance => { window.pendingInterviewSpeech = utterance; utterance.onstart?.(); };
    window.pendingInterviewSpeech = null;
    [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews')?.click();
    document.querySelector('.interview-back')?.click();
  `);
  await until(() => evaluate("return !!document.querySelector('.ci-setup form');"), 'setup for silent mock');
  await evaluate(`document.querySelector('.ci-setup [aria-label^="Answer mode"]')?.click();
    [...document.querySelectorAll('.ui-menu-item')].find(n => n.textContent.includes('Voice'))?.click();
    document.querySelector('.ci-setup form').requestSubmit();`);
  await until(() => evaluate('return !!window.pendingInterviewSpeech;'), 'silent mock opening');
  await until(() => evaluate("return window.openingCaptures === 1 && document.querySelector('.ci-voice .voice-panel').dataset.capture === 'recording';"), 'microphone stays ready during opening question');
  await evaluate('window.openingLevel=.08;'); await sleep(450); await evaluate('window.openingLevel=0;');
  const micState = "document.querySelector('.ci-voice .voice-state').textContent";
  await until(() => evaluate(`return ${micState} === 'Listening';`), 'speech interrupts the opening question');
  assert.deepEqual(await evaluate('return {captures:window.openingCaptures,stops:window.openingStops};'), {captures:1,stops:0}, 'opening interruption reuses the same physical microphone');
  const silentId = (await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1')); ")).id;
  const silentFile = path.join(problemDir(home, 'two-sum'), 'interviews', silentId, 'turns.jsonl');
  const bubbles = "document.querySelectorAll('.ci-log .ci-entry:not(.ci-candidate)').length";
  const bubblesBefore = await evaluate(`return ${bubbles};`);
  await evaluate("window.pendingInterviewSpeech = null; const input = document.querySelector('.ci-input'); input.value = 'Hmm, I am still thinking aloud about the furthest layer.'; input.dispatchEvent(new Event('input'));");
  await until(() => evaluate("const b = document.querySelector('.ci-send-now'); return !b.hidden && !b.disabled;"), 'silent turn can send');
  await evaluate("document.querySelector('.ci-send-now').click();");
  await until(async () => (await fs.readFile(silentFile, 'utf8')).includes('still thinking aloud'), 'candidate words saved');
  await until(() => evaluate(`return ${micState} === 'Listening';`), 'mic reopens while the reply is decided');
  assert.ok(!(await fs.readFile(silentFile, 'utf8')).includes('interviewer_silent'), 'mic was open before the silent reply finished');
  await until(async () => (await fs.readFile(silentFile, 'utf8')).includes('interviewer_silent'), 'silent reply recorded');
  await sleep(300);
  assert.equal(await evaluate(`return ${bubbles};`), bubblesBefore, 'silence adds no interviewer bubble');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-log .interviewer-silent').length;"), 1, 'silence is shown as received');
  assert.equal(await evaluate('return window.pendingInterviewSpeech;'), null, 'silence speaks nothing');
  assert.equal(await evaluate(`return ${micState};`), 'Listening', 'still listening after silence');
  assert.deepEqual(await evaluate('return {captures:window.openingCaptures,stops:window.openingStops};'), {captures:1,stops:0}, 'submitting and receiving a silent reply never closes capture');
  assert.equal(await evaluate("return document.querySelector('.ci-log').textContent.includes('[[');"), false, 'no control tag leaks');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('still thinking aloud');"), 'silent turn survives reload');
  assert.equal(await evaluate("return /did not finish/.test(document.body.textContent);"), false, 'silence is not reported as a failed reply');
  await until(() => evaluate("return document.querySelectorAll('.ci-log .interviewer-silent').length === 1;"), 'the silent note survives reload');
  console.log('Mock continuous voice', await evaluate(`return (${checkMockVoice.toString()})('coding');`));
  const extended = await evaluate(`const id=document.querySelector('.ci-panel').dataset.interviewId; return (${checkMockTime.toString()})('coding', '/api/interview/two-sum/'+id);`);
  console.log('Mock time controls', extended);
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`return JSON.parse(localStorage.getItem('studio.interview.active.v1'))?.minutes === ${extended.extended} && !!document.querySelector('.ci-panel');`), 'extended budget survives reload');
  console.log('Interview browser check passed: opening, turn, verdict, draft/reload, loading isolation, stale completion recovery, restart, debrief, controls, coach restoration.');
  if (process.env.STUDIO_CHECK_REVIEW === '1') {
    console.log('Scratch browser ready for manual review. Press Enter to clean up.');
    process.stdin.resume();
    await new Promise(resolve => process.stdin.once('data', resolve));
    process.stdin.pause();
  }
} finally {
  socket?.close();
  await Promise.all([chrome, server].filter(Boolean).map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  for (const item of pending.values()) clearTimeout(item.timer);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await cleanupChrome(chrome, profile);
}
