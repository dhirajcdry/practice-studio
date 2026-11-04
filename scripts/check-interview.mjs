import { problemDir } from '../server/storage-layout.mjs';
// Real browser wiring, fake interviewer, synthetic cached statement, scratch home.
// No mic and no actual judge submission; verdicts enter through the same event API.
import { checkSidebar } from './check-sidebar.mjs';
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
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [...(process.env.STUDIO_CHECK_REVIEW === '1' ? [] : ['--headless=new']), '--disable-background-networking', '--no-first-run', '--no-default-browser-check', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { window.micAttempts = (window.micAttempts || 0) + 1; throw new DOMException('No mic in check', 'NotAllowedError'); } });" });
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
  await evaluate("document.querySelector('.ci-setup [aria-label^=\"Answer mode\"]').click(); [...document.querySelectorAll('.ui-menu:not([hidden]) .ui-menu-item')].find(n=>n.textContent.trim()==='Typed').click(); document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('Find two numbers') && !document.querySelector('.ci-send').disabled;"), 'opening');
  const dock = await evaluate("const v=document.querySelector('.interviews-view').getBoundingClientRect(),c=document.querySelector('.ci-composer').getBoundingClientRect();return {gap:v.bottom-c.bottom,bottom:c.bottom,viewport:v.bottom};");
  assert.ok(dock.gap>=-1 && dock.gap<=32, 'Short interviews keep the composer at the bottom: '+JSON.stringify(dock));

  assert.equal(await evaluate("return !!document.querySelector('.coach-bar');"), true, 'shared sidebar stays mounted');
  assert.equal(await evaluate("return !!document.querySelector('.ws .rec-toggle');"), false, 'interview controls leave the editor toolbar');
  const identity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1')); ");
  const callsBeforeNoise = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = '[typing] (keyboard clacking) (clicking) [TAPPING]'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();");
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === '' && !document.querySelector('.ci-send').disabled;"), 'noise rejected');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), callsBeforeNoise, 'noise must not call provider');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-candidate').length;"), 0, 'noise must not appear in transcript');
  const noiseRecord = await fs.readFile(path.join(problemDir(home,'two-sum'), 'interviews', identity.id, 'turns.jsonl'), 'utf8');
  assert.ok(noiseRecord.includes('skipped_noise'), 'noise retained as a separate audit event');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = 'I will use a map.'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();");
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('What will you keep');"), 'reply');
  // A deliberately long incremental reply exercises real layout growth while
  // speech is enabled, without calling a model or real audio service.
  await until(() => evaluate("return !document.querySelector('.ci-send').disabled;"), 'ready to stream');
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
  await until(() => evaluate("return !document.querySelector('.ci-send').disabled;"), 'stream complete');
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
        for (let i=0; i<50; i++) { emit('token', {text:'A continued response. '}); window.modeChunks++; await new Promise(resolve=>setTimeout(resolve,40)); }
        emit('done', {state:{mode:'voice'}}); window.fetch = previousFetch; controller.close();
      } }), {headers:{'Content-Type':'text/event-stream'}}));
    };
    const input=document.querySelector('.ci-input'); input.value='mode switch regression'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();
  `);
  await until(() => evaluate('return window.modeChunks > 2 && window.modeChunks < 50;'), 'mode test streaming');
  const switchIdentity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  await evaluate("document.querySelector('.ci-composer [aria-label^=\"Answer mode:\"]').click(); [...document.querySelectorAll('.ui-menu:not([hidden]) .ui-menu-item')].find(n=>n.textContent.trim()==='Voice').click();");
  assert.ok(await evaluate("return document.querySelector('.ci-typed').hidden && !document.querySelector('.ci-voice').hidden && window.modeChunks<50;"), 'voice switch takes effect during reply');
  await evaluate("document.querySelector('.ci-composer [aria-label^=\"Answer mode:\"]').click(); [...document.querySelectorAll('.ui-menu:not([hidden]) .ui-menu-item')].find(n=>n.textContent.trim()==='Typed').click(); const input=document.querySelector('.ci-input'); input.value='Unsent next thought'; input.dispatchEvent(new Event('input'));");
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.mode;"), 'typed');
  await until(() => evaluate("return window.modeChunks===50 && document.querySelector('.ci-mode-status').hidden && !document.querySelector('.ci-send').disabled;"), 'mode persisted after stream');
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
  await until(() => evaluate("return document.querySelectorAll('.ci-entry').length >= window.entriesBeforeReadingReply + 2 && !document.querySelector('.ci-send').disabled;"), 'new reply while reading older transcript');
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
  for (const section of ['Lean hire', 'Problem solving', 'Coding', 'Communication', 'Testing', 'What went well', 'What to improve', 'Practise next']) assert.ok(report.includes(section), section);
  assert.equal(await evaluate("return document.querySelectorAll('.rp-dim').length;"), 4, 'four scored dimensions');
  assert.equal(await evaluate("return document.querySelector('.rp-quote')?.textContent;"), 'I will use a map.', 'a verified quote is shown as a quote');
  // Follow-up questions: the weakest area is offered first, answers stream in and persist.
  assert.ok(await evaluate("return !!document.querySelector('.rp-ask-starter');"), 'report offers follow-up questions');
  const askLayout = await evaluate(`const s = document.querySelector('.rp-scroll').getBoundingClientRect(), a = document.querySelector('.rp-ask').getBoundingClientRect(), d = document.querySelector('.rp-sheet').getBoundingClientRect();
    return { beside: a.left >= s.right - 1, inside: a.right <= d.right + 0.5 && a.bottom <= d.bottom + 0.5 };`);
  assert.deepEqual(askLayout, { beside: true, inside: true }, 'question panel sits beside the report, inside the sheet');
  const widths = await evaluate(`const panel = document.querySelector('.rp-ask'), handle = panel.querySelector('.drawer-resize');
    const before = panel.getBoundingClientRect().width;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true, bubbles: true }));
    return { before, after: panel.getBoundingClientRect().width, saved: Number(localStorage.getItem('studio.report.ask.width.v1')) };`);
  assert.ok(widths.after === widths.before + 80 && widths.saved === widths.after, `question panel resizes and remembers its width ${JSON.stringify(widths)}`);
  await evaluate("[...document.querySelectorAll('.rp-dim-ask')].find(n => n.textContent === 'Ask about testing').click();");
  await until(() => evaluate("return document.querySelector('.rp-ask .cmsg.reply .cmsg-body')?.textContent.includes('[3,3], 6');"), 'follow-up answer streams in');
  assert.equal(await evaluate("return document.querySelector('.rp-ask-starters').hidden;"), true, 'suggestions give way to the thread');
  await evaluate("const i = document.querySelector('.rp-ask-input'); i.value = 'An unsent follow-up'; i.dispatchEvent(new Event('input'));");
  if (process.env.STUDIO_CHECK_SHOT) {
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(process.env.STUDIO_CHECK_SHOT.replace(/\.png$/, '-ask.png'), Buffer.from(shot.data, 'base64'));
  }
  await evaluate("document.querySelector('.rp-sheet[open] .icon-btn[aria-label=\"Close report\"]').click();");
  await until(() => evaluate("return !document.querySelector('.rp-sheet[open]');"), 'report closes with a draft');
  await evaluate("document.querySelector('.ci-open-report').click();");
  await until(() => evaluate("return document.querySelector('.rp-sheet[open] .rp-ask .cmsg.reply .cmsg-body')?.textContent.includes('[3,3], 6');"), 'answered follow-up survives reopening');
  assert.equal(await evaluate("return document.querySelector('.rp-ask-input').value;"), 'An unsent follow-up', 'unsent question survives reopening');
  await evaluate("const i = document.querySelector('.rp-ask-input'); i.value = ''; i.dispatchEvent(new Event('input'));");
  await evaluate("document.querySelector('.rp-sheet[open] .icon-btn[aria-label=\"Close report\"]').click();");
  await until(() => evaluate("return !document.querySelector('.rp-sheet[open]');"), 'report closes');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-mini-dim').length;"), 4, 'sidebar summary');
  assert.equal(await evaluate("return !!document.querySelector('.ci-log');"), true, 'closing the report leaves the transcript in the sidebar');
  const debrief = await evaluate("return document.querySelector('.ci-feedback').textContent;");
  await evaluate("window.sidebarBefore = document.querySelector('.coach'); [...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Chat').click();");
  assert.equal(await evaluate("return document.querySelector('.coach') === window.sidebarBefore;"), true, 'tab switching preserves the sidebar');
  await evaluate("[...document.querySelectorAll('.coach-tab')].find(n => n.textContent === 'Interviews').click();");
  assert.equal(await evaluate("return document.querySelector('.ci-feedback').textContent;"), debrief, 'switching tabs retains feedback');
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
  await until(() => evaluate(`return document.querySelector('.ci-panel')?.dataset.interviewId && document.querySelector('.ci-panel').dataset.interviewId !== ${JSON.stringify(identity.id)} && !document.querySelector('.ci-send').disabled;`), 'new interview replaces debrief');
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
  await until(() => evaluate("return document.querySelector('.ci-input') && !document.querySelector('.ci-send').disabled;"), 'third opening');
  const thirdId = await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;");
  await evaluate("const input=document.querySelector('.ci-input'); input.value='Saved paused answer'; input.dispatchEvent(new Event('input')); [...document.querySelectorAll('.ci-toolbar button')].find(n=>n.getAttribute('aria-label')==='Pause interview').click();");
  await until(() => evaluate("return !document.querySelector('.ci-paused')?.hidden;"), 'paused badge');
  await evaluate("document.querySelector('.interview-back')?.click(); document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate(`return document.querySelector('.ci-panel')?.dataset.interviewId !== ${JSON.stringify(thirdId)} && !document.querySelector('.ci-send').disabled;`), 'fresh fourth opening');
  const fourthId = await evaluate("return document.querySelector('.ci-panel').dataset.interviewId;");
  await evaluate(`document.querySelector('.interview-back')?.click(); document.querySelector('.interview-row[data-interview-id="${thirdId}"] .interview-row-summary').click();`);
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === 'Saved paused answer';"), 'paused draft restored');
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n=>n.getAttribute('aria-label')==='Resume interview').click();");
  await until(() => evaluate(`return document.querySelector('.interview-row[data-interview-id="${fourthId}"] .interview-status')?.textContent === 'Paused' && !document.querySelector('.ci-send').disabled;`), 'resume pauses other interview');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`return document.querySelector('.coach')?.dataset.sidebarTab === 'interviews' && document.querySelector('.ci-panel')?.dataset.interviewId === ${JSON.stringify(thirdId)} && document.querySelector('.ci-input')?.value === 'Saved paused answer';`), 'selected row and tab survive reload');
  assert.equal(await evaluate("return document.querySelectorAll('.interview-row').length;"), 4, 'all interviews remain listed');
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.classList.contains('ci-finish')).click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true';"), 'resumed interview completes');
  await checkSidebar(expression => evaluate('return ' + expression));
  // The list itself, not just an open interview: four cards, one of them paused.
  await evaluate("document.querySelector('.interview-back').click();");
  await until(() => evaluate("return !document.querySelector('.interviews-overview').hidden;"), 'interview list shown');
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
  assert.equal(await evaluate("return [...document.querySelectorAll('.ci-voice button')].filter(n => !n.closest('[hidden]') && n.getClientRects().length).map(n => n.textContent).join('|');"), 'Interrupt · Esc', 'speaking exposes one relevant action');
  assert.equal(await evaluate("return document.querySelector('.ci-voice').textContent.includes('Hold Esc');"), false, 'no permanent interrupt instruction');
  await evaluate("[...document.querySelectorAll('.ci-voice button')].find(n => n.textContent === 'Interrupt · Esc').click();");
  await until(() => evaluate("return !document.querySelector('.ci-voice .vc-status').hidden && document.querySelector('.ci-voice .voice-state').textContent === 'Microphone off';"), 'microphone failure stays inline');
  assert.equal(await evaluate('return window.micAttempts;'), 1, 'permission failure never loops');
  // A voice answer can be sent without waiting for the silence that sends it on its own.
  const setVoiceDraft = text => evaluate(`const input = document.querySelector('.ci-input'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input'));`);
  await setVoiceDraft('Sort by position, then count fleets from the front.');
  await until(() => evaluate("const b = document.querySelector('.ci-send-now'); return !b.hidden && b.getClientRects().length > 0 && !b.disabled;"), 'voice draft offers Send');
  const sendRow = await evaluate(`const centre = n => { const r = n.getBoundingClientRect(); return r.top + r.height / 2; };
    const send = document.querySelector('.ci-send-now'), mic = [...document.querySelectorAll('.ci-voice button')].find(n => n.textContent === 'Enable microphone');
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
  await checkSidebar(expression => evaluate('return ' + expression));
  const beforeEmptyFinish = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate("document.querySelector('.ci-finish').click();");
  await until(() => evaluate("return document.querySelector('.ci-feedback')?.textContent.includes('No report was generated');"), 'empty session completes without report');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), beforeEmptyFinish, 'empty finish does not call provider');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-mini-dim, .ci-dimension, .ci-open-report').length;"), 0, 'empty interview has no ratings or report button');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate("return document.querySelector('.ci-feedback')?.textContent.includes('No report was generated');"), 'empty completion survives reload');
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
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
