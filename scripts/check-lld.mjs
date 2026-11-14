import { cleanupChrome } from './chrome-cleanup.mjs';
import { problemDir } from '../server/storage-layout.mjs';
// Real browser wiring, fake interviewer, synthetic cached statement, scratch home.
// No mic and no actual judge submission; verdicts enter through the same event API.
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
const serverPort = Number(process.env.STUDIO_CHECK_PORT) || 4197, debugPort = serverPort + 5255;
const origin = `http://127.0.0.1:${serverPort}`, debug = `http://127.0.0.1:${debugPort}`;
let server, chrome, socket, logs = '', sequence = 0;
const pending = new Map();
async function free(port) {
  await new Promise((resolve, reject) => { const probe = net.createServer(); probe.on('error', reject); probe.listen(port, '127.0.0.1', () => probe.close(resolve)); });
}
async function until(fn, label) {
  for (let i = 0; i < 150; i++) { try { if (await fn()) return; } catch { /* starting */ } await sleep(100); }
  throw Error(`Timed out: ${label}\n${logs}`);
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
  // Headless Chrome has no OS window focus; voice listens only while the page is focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  // Reject capture rather than fabricating audio. Typed mode remains fully usable.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { window.micAttempts = (window.micAttempts || 0) + 1; throw new DOMException('No mic in check', 'NotAllowedError'); }, configurable: true });" });
  await send('Page.navigate', { url: origin + '/#/lld' });
  await until(() => evaluate("return document.querySelectorAll('.th-problem[data-slug]').length === 3 && !!document.querySelector('.th[data-state=ready]');"), 'LLD home');
  assert.ok(await evaluate("const r = document.querySelector('.th-mock .ci-start').getBoundingClientRect(); return r.width > 0 && r.bottom <= innerHeight;"), 'the new-mock setup is on the page without a click');

  assert.ok(await evaluate("return !!document.querySelector('.th-mock [aria-label=\"Answer mode: Voice\"]');"), 'new mocks default to voice');
  assert.deepEqual(await evaluate("return { chosen: document.querySelectorAll('.th-problem[aria-pressed=true]').length, special: document.querySelectorAll('.th-problem[data-open]').length, acts: [...document.querySelectorAll('.th-detail .th-act h3')].map(n => n.textContent), practise: document.querySelector('.th-pick[data-kind=practise] .ui-select-button').getAttribute('aria-label'), mock: document.querySelector('.th-pick[data-kind=mock] .ui-select-button')?.getAttribute('aria-label') };"),
    { chosen: 0, special: 0, acts: ['Practise', 'Mock'], practise: 'Problem: Surprise me', mock: 'Problem: Surprise me' }, 'nothing is chosen on arrival; both ways in start on Surprise me, and both offer My own problem');

  for (const width of [1440, 390]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
    const slugs = await evaluate("return [...document.querySelectorAll('.th-problem[data-slug]')].map(n => n.dataset.slug);");
    for (const slug of slugs) {
      const point = await evaluate(`const button = document.querySelector('.th-problem[data-slug="${slug}"]'); button.scrollIntoView({block:'center'}); const r = button.getBoundingClientRect(); return {x:r.left+r.width/2, y:r.top+r.height/2};`);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      const selection = await evaluate(`
        const pick = document.querySelector('.th-problem[data-slug="${slug}"]'), start = document.querySelector('.th-mock .ci-start');
        start.scrollIntoView({block:'nearest'}); const c = start.getBoundingClientRect();
        return { pressed:pick.getAttribute('aria-pressed'), chosen:document.querySelectorAll('.th-problem[aria-pressed=true]').length,
          shown:document.querySelector('.th-detail-title').textContent === pick.querySelector('.th-problem-title').textContent,
          visible:c.width > 0 && c.left >= 0 && c.right <= innerWidth && c.top >= -1 && c.bottom <= innerHeight + 1,  // sub-pixel rounding of scrollIntoView
          fits:document.documentElement.scrollWidth <= innerWidth };
      `);
      assert.deepEqual(selection, { pressed:'true', chosen:1, shown:true, visible:true, fits:true }, `${slug} is chosen and shown with Start mock at ${width}px`);
    }
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(`/tmp/studio-lld-library-${width}.png`, Buffer.from(shot.data, 'base64'));
  }
  assert.equal(await evaluate("return (await (await fetch('/api/lld')).json()).interviews.length;"), 0, 'selection never starts an interview');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await evaluate("document.querySelector('.th-clear').click();");
  assert.equal(await evaluate("return document.querySelectorAll('.th-problem[aria-pressed=true]').length + ':' + document.querySelector('.th-detail-title').textContent;"), '0:Start something new', 'Clear returns to starting on something new');
  await evaluate("document.querySelector('.th-problem[data-slug=\"lld-locker\"]').focus();");
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  assert.equal(await evaluate("return document.querySelector('.th-problem[data-slug=\"lld-locker\"]').getAttribute('aria-pressed');"), 'true', 'keyboard chooses the problem');
  // Arrow keys move the one selection through the list.
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
  assert.equal(await evaluate("return document.activeElement.dataset.slug + ':' + document.querySelectorAll('.th-problem[aria-pressed=true]').length;"), 'lld-vending-machine:1', 'ArrowDown moves the selection');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38 });
  assert.equal(await evaluate("return document.querySelector('.th-problem[aria-pressed=true]').dataset.slug;"), 'lld-locker', 'ArrowUp moves it back');
  await evaluate("document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return !!document.querySelector('.ci-log .ui-turn') && !!window.monaco?.editor.getModels().length;"), 'LLD opening');
  assert.equal(await evaluate("return document.querySelector('.ui-workspace-header h1').textContent;"), 'Locker system', 'Start opens the chosen problem');
  assert.equal(await evaluate('return monaco.editor.getModels()[0].getValue();'), '', 'candidate starts with blank Python');
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.mode;"), 'voice', 'sample mock also defaults to voice');
  async function answerMode(value) {
    await evaluate(`document.querySelector('.ci-composer .ui-mode-switch[data-mode=${value}]').click();`);
    await until(() => evaluate(`return document.querySelector('.ci-panel').dataset.mode===${JSON.stringify(value)} && document.querySelector('.ci-mode-status').hidden;`), 'saved answer mode');
  }
  await answerMode('typed');
  const originalIdentity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  await evaluate("const input=document.querySelector('.ci-input'); input.value='Keep this unsent thought.'; input.dispatchEvent(new Event('input'));");
  await answerMode('voice');
  assert.ok(await evaluate("return document.querySelector('.ci-typed').hidden && !document.querySelector('.ci-voice').hidden && document.querySelector('.ci-live-words').textContent==='Keep this unsent thought.';"), 'switching retains unsent typed draft without sending');
  await answerMode('typed');
  assert.equal(await evaluate("return document.querySelector('.ci-input').value;"), 'Keep this unsent thought.');
  const switchedIdentity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  assert.equal(switchedIdentity.id, originalIdentity.id); assert.equal(switchedIdentity.startedAt, originalIdentity.startedAt);
  await evaluate("const input=document.querySelector('.ci-input'); input.value=''; input.dispatchEvent(new Event('input'));");

  const code = 'class Booking:\n    pass\n\nassert 2 + 2 == 4\nprint("LLD checks passed")\n';
  await evaluate(`monaco.editor.getModels()[0].setValue(${JSON.stringify(code)});`);
  await until(() => evaluate("return document.querySelector('.lld-notice').textContent === 'Saved to disk';"), 'document saved');
  await evaluate("[...document.querySelectorAll('button')].find(n => n.textContent === 'Run Python').click();");
  await until(() => evaluate("return document.querySelector('.pyrun .rr-printed')?.textContent.includes('LLD checks passed');"), 'Python output');
  assert.match(await evaluate("return document.querySelector('.pyrun .rr-headline').textContent;"), /^Ran · .* · exit 0$/);
  const previousPage = await evaluate('return performance.timeOrigin;');
  await send('Page.reload', { ignoreCache: true });
  await until(() => evaluate(`return performance.timeOrigin !== ${previousPage} && !!window.monaco?.editor.getModels().length && !!document.querySelector('.ci-log .ui-turn');`), 'restored workspace');
  assert.equal(await evaluate('return monaco.editor.getModels()[0].getValue();'), code, 'saved Python survives reload');
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.mode;"), 'typed', 'changed mode survives reload');
  await evaluate("const b = document.querySelector('.ci-pause[aria-label=\"Resume interview\"]'); if (b && !b.hidden) b.click();");
  await until(() => evaluate("return !document.querySelector('.ci-input').disabled || !!document.querySelector('.ci-paused button');"), 'restored controls');
  await until(() => evaluate("return !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'ready after resume');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = 'I will check overlapping reservations before mutating room state.'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-send').click();");
  await until(() => evaluate("return document.querySelectorAll('.ci-candidate').length === 1 && !document.querySelector('.ci-input').disabled && !document.querySelector('.ci-pause').disabled;"), 'candidate answer');
  // Idle ticks persist state every few seconds. The header is built once, so Finish stays
  // the same node and keeps keyboard focus through them.
  await evaluate("window.idleFinish = document.querySelector('.ui-screen-header .ci-finish'); window.idleFinish.focus(); window.idleEvents = 0; const real = window.fetch; window.fetch = (...args) => { if (String(args[0]).endsWith('/api/interview/event')) window.idleEvents++; return real(...args); };");
  await sleep(12000);
  assert.deepEqual(await evaluate("return { same: document.querySelector('.ui-screen-header .ci-finish') === window.idleFinish, focused: document.activeElement === window.idleFinish, ticked: window.idleEvents >= 2, menus: document.querySelectorAll('.ui-menu').length };"),
    { same: true, focused: true, ticked: true, menus: 0 }, 'header Finish survives 12 idle seconds as the same focused node');
  for (const mode of ['light', 'dark']) {
    await evaluate(`(await import('/js/settings.js')).setSetting('mode', ${JSON.stringify(mode)});`);
    await evaluate('await new Promise(resolve => setTimeout(resolve, 350));');
    const bounds = await evaluate(`const a = document.querySelector('.lld-document').getBoundingClientRect(), b = document.querySelector('.lld-interviewer').getBoundingClientRect(); return { aligned: Math.abs(a.top-b.top)<1, separate: a.right <= b.left, inside: b.right <= innerWidth };`);
    assert.deepEqual(bounds, { aligned: true, separate: true, inside: true });
    const shot = await send('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile('/tmp/studio-lld-' + mode + '.png', Buffer.from(shot.data, 'base64'));
  }
  await evaluate("document.querySelector('.ci-finish').click();");
  await until(() => evaluate("return !!document.querySelector('.rp-sheet[open]');"), 'LLD report');
  assert.equal(await evaluate("return document.querySelectorAll('.rp-dim-row').length;"), 10, 'LLD rubric has ten dimensions');
  assert.ok(await evaluate("return document.querySelector('.rp-sheet').textContent.includes('State modeling');"));
  await evaluate("document.querySelector('.rp-sheet [aria-label=\"Close report\"]').click();");
  assert.ok(await evaluate("return !!document.querySelector('.ci-open-report') && document.querySelector('.ci-open-report').getBoundingClientRect().width > 0;"), 'completed LLD report remains reopenable');
  await evaluate("location.hash='#/lld';");
  await until(() => evaluate("return !!document.querySelector('.th[data-state=ready] .th-mock .ci-start');"), 'adaptive setup');
  assert.equal(await evaluate("return document.querySelectorAll('.th-problem[aria-pressed=true]').length;"), 0, 'mock + Surprise me is the default');
  await evaluate("document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return document.querySelector('.ui-workspace-header h1')?.textContent==='Museum ticket reservations' && !!document.querySelector('.ci-log .ui-turn');"), 'adaptive problem opening');
  assert.equal(await evaluate("return document.querySelector('.ci-panel').dataset.mode;"), 'voice');
  assert.equal(await evaluate("return monaco.editor.getModels().find(m=>!m.isDisposed())?.getValue();"), '', 'generated mock starts blank');
  const generated = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  assert.equal(generated.slug, 'lld-museum-ticket-reservations');
  assert.ok(await fs.stat(path.join(problemDir(home,generated.slug), 'problem.json')));
  assert.ok(await fs.stat(path.join(problemDir(home,generated.slug), 'interviews', generated.id, 'turns.jsonl')));
  await answerMode('typed');
  await evaluate("location.hash='#/design';");
  await until(() => evaluate("return !!document.querySelector('.th[data-state=ready] .th-mock .ci-start');"), 'design home');
  assert.equal(await evaluate("return document.querySelector('.th-pick[data-kind=mock] .ui-select-button').getAttribute('aria-label');"), 'Problem: Surprise me');
  assert.ok(await evaluate("return !!document.querySelector('.th-mock [aria-label=\"Answer mode: Voice\"]');"));
  await evaluate("document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return document.querySelector('.dz-log')?.textContent.includes('Design a museum ticket reservation system.');"), 'adaptive system design opening');
  assert.ok(await evaluate("return document.querySelector('.dz-view').dataset.mode==='voice';"));
  await evaluate("document.querySelector('.dz-compose .ui-mode-switch[data-mode=type]').click();");
  await until(() => evaluate("return document.querySelector('.dz-view').dataset.mode==='type';"), 'design typed switch');
  const designRecord = (await (await fetch(origin + '/api/design')).json()).interviews[0];
  await until(async () => (await (await fetch(origin + '/api/design/' + designRecord.id)).json()).mode === 'typed', 'design mode saved');
  const designIdentity = await (await fetch(origin + '/api/design/' + designRecord.id)).json();
  await evaluate("document.querySelector('.dz-back').click();");
  await until(() => evaluate("return [...document.querySelectorAll('.th-item .th-pill')].some(n=>n.textContent==='Unfinished');"), 'design history');
  await evaluate("[...document.querySelectorAll('.th-item')].find(n=>n.querySelector('.th-pill')?.textContent==='Unfinished').querySelector('.th-item-open').click();");
  await until(() => evaluate("return document.querySelector('.dz-view')?.dataset.mode==='type';"), 'resumed typed design');
  const designResumed = await (await fetch(origin + '/api/design/' + designRecord.id)).json();
  assert.equal(designResumed.id, designIdentity.id);
  // Silence in a design mock: no empty bubble and no failure, the microphone stays open
  // while the reply is decided, and total quiet offers the interviewer one chance to speak.
  const designEntries = "document.querySelectorAll('.dz-log .dz-entry.dz-q').length";
  const designRows = async () => (await (await fetch(origin + '/api/design/' + designRecord.id)).json()).turns;
  const qBefore = await evaluate(`return ${designEntries};`);
  await evaluate(`
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => ({ getTracks: () => [{ stop() {}, addEventListener() {} }] }), configurable: true });
    window.MediaRecorder = class extends EventTarget { constructor() { super(); this.mimeType = 'audio/webm'; } start() {} requestData() { const e = new Event('dataavailable'); e.data = new Blob(['x']); this.dispatchEvent(e); } stop() { queueMicrotask(() => { this.requestData(); this.dispatchEvent(new Event('stop')); }); } static isTypeSupported() { return true; } };
    window.AudioContext = class { constructor() { this.state = 'running'; } createMediaStreamSource() { return { connect() {} }; } createAnalyser() { return { fftSize: 1024, getFloatTimeDomainData(a) { a.fill(0); } }; } close() {} };
    document.querySelector('.dz-compose .ui-mode-switch[data-mode=voice]').click();
  `);
  const designMic = "document.querySelector('.voice-panel .voice-state')?.textContent";
  await until(() => evaluate(`return ${designMic} === 'Listening';`), 'design mic open');
  await evaluate("const input = document.querySelector('.dz-compose textarea'); input.value = 'Hmm, I am still thinking aloud about the cache.'; input.dispatchEvent(new Event('input'));");
  await until(() => evaluate("const b = document.querySelector('.dz-voice-send'); return b && !b.hidden && !b.disabled;"), 'design voice draft can send');
  await evaluate("document.querySelector('.dz-voice-send').click();");
  await until(async () => (await designRows()).some(t => t.kind === 'candidate' && t.said?.includes('still thinking aloud')), 'design words saved');
  await until(() => evaluate(`return ${designMic} === 'Listening';`), 'design mic reopens while deciding');
  assert.ok(!(await designRows()).some(t => t.kind === 'interviewer_silent'), 'design mic opened before the silent reply finished');
  assert.equal(await evaluate(`return ${designEntries};`), qBefore, 'no empty bubble while deciding');
  await until(async () => (await designRows()).some(t => t.kind === 'interviewer_silent'), 'design silence recorded');
  await sleep(300);
  assert.equal(await evaluate(`return ${designEntries};`), qBefore, 'silence adds no interviewer bubble');
  assert.equal(await evaluate("return document.querySelectorAll('.dz-log .interviewer-silent').length;"), 1, 'silence is shown as received');
  assert.equal(await evaluate("return /No response was received|\\[\\[|connection ended/.test(document.querySelector('.dz-log').textContent);"), false, 'silence is not a failure');
  assert.equal(await evaluate(`return ${designMic};`), 'Listening', 'design still listening after silence');
  await evaluate("const real = Date.now.bind(Date); Date.now = () => real() + 65000;");
  await until(() => evaluate(`return ${designEntries} === ${qBefore + 1};`), 'quiet offers the interviewer a chance to step in');
  await sleep(1500);
  assert.equal(await evaluate(`return ${designEntries};`), qBefore + 1, 'the step-in offer has a cooldown');
  assert.equal(await evaluate("return document.querySelectorAll('.dz-log .interviewer-silent').length;"), 1, 'a step-in offer never claims to have heard anything');
  // Each way in with no problem chosen: Practise on a surprise (LLD, typed) and on your own
  // brief, then System design's Mock on your own brief and Practise on a surprise.
  const choose = (kind, text) => evaluate(`document.querySelector('.th-pick[data-kind=${kind}] .ui-select-button').click(); await new Promise(r => setTimeout(r, 80));
    [...document.querySelectorAll('.ui-menu:not([hidden]) .ui-menu-item')].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click(); await new Promise(r => setTimeout(r, 80));`);
  const pickMenu = (selector, text) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); await new Promise(r => setTimeout(r, 80));
    [...document.querySelectorAll('.ui-menu:not([hidden]) .ui-menu-item')].find(n => n.textContent.trim() === ${JSON.stringify(text)}).click(); await new Promise(r => setTimeout(r, 80));`);
  async function openHome(hash) {
    await evaluate("localStorage.removeItem('studio.interview.active.v1');");
    await send('Page.navigate', { url: origin + '/' + hash });
    await until(() => evaluate("return !!document.querySelector('.th[data-state=ready] .th-practice');"), hash + ' home');
  }
  const practiceSession = async () => {
    await until(() => evaluate("return /^#\\/(lld|design)\\/practice\\//.test(location.hash) && !!document.querySelector('.pr-coach');"), 'practice opened');
    const [, discipline, , slug, id] = (await evaluate('return location.hash;')).split('/');
    return { discipline, ...(await (await fetch(`${origin}/api/practice/${slug}/${id}`)).json()).session, text: await evaluate('return document.body.innerText;') };
  };
  await openHome('#/lld');
  await pickMenu('.th-act--practise [aria-label^="Answer mode"]', 'Typed');
  await evaluate("document.querySelector('.th-practice').click();");
  const surprisePractice = await practiceSession();
  assert.deepEqual({ slug: surprisePractice.slug, statement: surprisePractice.statement, mode: surprisePractice.mode, openEnded: surprisePractice.openEnded },
    { slug: 'lld-bike-dock-rentals', statement: 'Design a bike dock rental system.', mode: 'typed', openEnded: false }, 'Practise + Surprise me prepares an unseen problem and opens it untimed, typed');
  assert.ok(!/Each dock holds one bike|dock goes offline/.test(surprisePractice.text), 'interviewer-only facts and curveball never reach the screen');
  await openHome('#/lld');
  assert.ok(await evaluate("return /Practised/.test(document.querySelector('.th-problem[data-slug=\"lld-bike-dock-rentals\"] .th-problem-line')?.textContent || '');"), 'the practised surprise problem joins the library');
  await choose('practise', 'My own problem');
  await evaluate("const t = document.querySelector('.th-act--practise .th-brief textarea'); t.value = 'Design a library book hold queue.\\nHolds expire after three days.'; t.dispatchEvent(new Event('input')); document.querySelector('.th-practice').click();");
  const ownPractice = await practiceSession();
  assert.deepEqual({ title: ownPractice.title, statement: ownPractice.statement, openEnded: ownPractice.openEnded, slug: ownPractice.slug.startsWith('lld-open-') },
    { title: 'Design a library book hold queue.', statement: 'Design a library book hold queue.\nHolds expire after three days.', openEnded: true, slug: true }, 'Practise + My own problem opens on the brief');
  await openHome('#/design');
  await evaluate("document.querySelector('.th-practice').click();");
  const designSurprise = await practiceSession();
  assert.deepEqual({ slug: designSurprise.slug, statement: designSurprise.statement }, { slug: 'design-bike-dock-rentals', statement: 'Design a bike dock rental system.' }, 'System design Practise + Surprise me');
  await openHome('#/design');
  await choose('mock', 'My own problem');
  await evaluate("document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return !!document.querySelector('.th-mock .ci-setup [role=status]:not([hidden])');"), 'empty brief refused');
  assert.match(await evaluate("return document.querySelector('.th-mock .ci-setup [role=status]:not([hidden])').textContent;"), /Write your problem first/);
  await evaluate("const t = document.querySelector('.th-mock .th-brief textarea'); t.value = 'Design a pastry shop order board.'; t.dispatchEvent(new Event('input')); document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return document.querySelector('.dz-log')?.textContent.includes('Design a pastry shop order board.');"), 'own-brief system design mock opening');
  const ownMock = (await (await fetch(origin + '/api/design')).json()).interviews.find(i => i.prompt === 'Design a pastry shop order board.');
  assert.ok(ownMock && !ownMock.problemSlug, 'Mock + My own problem starts a design mock on the brief');
  // LLD Mock + My own problem: Studio prepares a scenario for the brief (private facts and
  // curveball on the server), then the mock starts on it exactly as a surprise does.
  await openHome('#/lld');
  await choose('mock', 'My own problem');
  await evaluate("document.querySelector('.th-mock .ci-start').click();");
  await until(() => evaluate("return !!document.querySelector('.th-mock .ci-setup [role=status]:not([hidden])');"), 'empty LLD brief refused');
  assert.match(await evaluate("return document.querySelector('.th-mock .ci-setup [role=status]:not([hidden])').textContent;"), /Write your problem first/);
  const lldBrief = 'Design a bakery order queue.\nOrders are collected in turn; a cancelled order frees its slot.';
  await evaluate(`const t = document.querySelector('.th-mock .th-brief textarea'); t.value = ${JSON.stringify(lldBrief)}; t.dispatchEvent(new Event('input')); document.querySelector('.th-mock .ci-start').click();`);
  await until(() => evaluate("return document.querySelector('.ui-workspace-header h1')?.textContent==='Design a bakery order queue' && !!document.querySelector('.ci-log .ui-turn');"), 'own-brief LLD mock opening');
  const ownLld = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1'));");
  assert.equal(ownLld.slug, 'lld-bakery-order-queue', 'the mock runs on the problem prepared for the brief');
  const ownProblem = JSON.parse(await fs.readFile(path.join(problemDir(home, ownLld.slug), 'problem.json'), 'utf8'));
  assert.equal(ownProblem.brief, lldBrief); assert.match(ownProblem.facts, /PRIVATE_BRIEF_FACTS/);
  assert.ok(await fs.stat(path.join(problemDir(home, ownLld.slug), 'interviews', ownLld.id, 'turns.jsonl')));
  assert.ok(await evaluate("return document.querySelector('.ci-log').textContent.includes('Design a bakery order queue.');"), 'the interviewer opens on the public statement');
  assert.ok(!(await evaluate("return /PRIVATE_BRIEF/.test(document.body.innerText);")), 'interviewer-only facts and curveball never reach the screen');
  const selectionPrompt = (await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt).filter(p => p.includes('INTERVIEW_PROBLEM_SELECTION') && p.includes('bakery')).at(-1);
  assert.match(selectionPrompt, /<(CANDIDATE_BRIEF_[0-9a-f-]+)>\nDesign a bakery order queue\.[\s\S]*<\/\1>/, 'the brief reaches the preparation fenced as data');
  await openHome('#/lld');
  assert.equal(await evaluate("return document.querySelector('.th-pick[data-kind=mock] .th-brief textarea').value;"), '', 'a started brief is cleared');
  console.log('Interview browser check passed: Practise and Mock with no problem chosen (surprise and own brief, both tracks, LLD mock prepared for the brief), adaptive LLD/system-design starts, voice defaults, live mode switching/draft preservation/resume, card selection at 1440/390px, Python execution/persistence, reports.');
} catch (error) {
  try { console.error('Browser state:', await evaluate("return {hash:location.hash, text:document.body.innerText.slice(-1800)};")); } catch {}
  const calls = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8').catch(()=>'');
  const last = calls.trim().split('\n').at(-1); if (last) { const prompt=JSON.parse(last).prompt; console.error('Last fake turn:', {selection:prompt.includes('INTERVIEW_PROBLEM_SELECTION'), debrief:prompt.includes("Write the candidate's report"), opening:prompt.match(/The problem for this interview is: ([^\n]+)/)?.[1]}); }
  throw error;
} finally {
  socket?.close();
  await Promise.all([chrome, server].filter(Boolean).map(child => new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode) return resolve();
    child.once('exit', resolve); child.kill();
  })));
  for (const item of pending.values()) clearTimeout(item.timer);
  await fs.rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); await cleanupChrome(chrome, profile);
}
