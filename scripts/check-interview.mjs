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
const origin = 'http://127.0.0.1:4193', debug = 'http://127.0.0.1:9448';
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
  await free(4193); await free(9448);
  await fs.mkdir(path.join(home, 'cache', 'leetcode'), { recursive: true });
  await fs.writeFile(path.join(home, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  await fs.writeFile(path.join(home, 'cache', 'leetcode', 'two-sum.json'), JSON.stringify({ question: {
    title: 'Two Sum', titleSlug: 'two-sum', questionId: '1', difficulty: 'Easy',
    content: '<p>Find two numbers whose sum is the target.</p>',
    metaData: JSON.stringify({ name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }], return: { type: 'integer[]' } }),
    exampleTestcases: '[2,7,11,15]\n9', codeSnippets: [{ langSlug: 'python3', code: 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n' }],
  } }));
  server = spawn(process.execPath, ['--input-type=module', '--eval', "globalThis.fetch = async () => { throw Error('Network disabled in interview check'); }; (await import('./server/index.mjs')).start();"], {
    cwd: root, env: { ...process.env, STUDIO_TTS_PYTHON: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_SCRIPT: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_MODEL: path.join(root, 'server/tts/test/fake-helper.mjs'), STUDIO_TTS_VOICES: path.join(root, 'server/tts/test/fake-helper.mjs'), FAKE_INTERVIEW_PROMPT: path.join(home, 'provider-calls.jsonl'), STUDIO_HOME: home, STUDIO_PORT: '4193', STUDIO_MIRROR_DIR: '', STUDIO_COACH_BINARY: path.join(root, 'server/interview/test/fake-interviewer.mjs'), STUDIO_CODEX_BINARY: path.join(root, 'server/coach/test/bin/fake-codex.mjs') }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { logs = (logs + data).slice(-4000); });
  await until(async () => (await fetch(origin + '/api/health')).ok, 'server');
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-background-networking', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=9448', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  await until(async () => (await fetch(debug + '/json/list')).ok, 'Chrome');
  const [tab] = await (await fetch(debug + '/json/list')).json();
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
  await send('Page.enable'); await send('Runtime.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
  // Reject capture rather than fabricating audio. Typed mode remains fully usable.
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { value: async () => { throw new DOMException('No mic in check', 'NotAllowedError'); } });" });
  await send('Page.navigate', { url: origin + '/#/p/two-sum' });
  await until(() => evaluate("return !!document.querySelector('.rec-toggle') && !!document.querySelector('.ws-host');"), 'problem');
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
  await evaluate("document.querySelector('.rec-toggle').click();");
  await until(() => evaluate("return !!document.querySelector('.ci-setup');"), 'start choices');
  await evaluate("document.querySelector('.ci-setup form').requestSubmit();");
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('Find two numbers') && !document.querySelector('.ci-typed button').disabled;"), 'opening');
  assert.equal(await evaluate("return !!document.querySelector('.coach-bar');"), false, 'coach controls hidden');
  const identity = await evaluate("return JSON.parse(localStorage.getItem('studio.interview.active.v1')); ");
  const callsBeforeNoise = await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = '[typing] (keyboard clacking) (clicking) [TAPPING]'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-typed button').click();");
  await until(() => evaluate("return document.querySelector('.ci-input')?.value === '' && !document.querySelector('.ci-typed button').disabled;"), 'noise rejected');
  assert.equal(await fs.readFile(path.join(home, 'provider-calls.jsonl'), 'utf8'), callsBeforeNoise, 'noise must not call provider');
  assert.equal(await evaluate("return document.querySelectorAll('.ci-candidate').length;"), 0, 'noise must not appear in transcript');
  const noiseRecord = await fs.readFile(path.join(home, 'problems/two-sum/interviews', identity.id, 'turns.jsonl'), 'utf8');
  assert.ok(noiseRecord.includes('skipped_noise'), 'noise retained as a separate audit event');
  await evaluate("const input = document.querySelector('.ci-input'); input.value = 'I will use a map.'; input.dispatchEvent(new Event('input')); document.querySelector('.ci-typed button').click();");
  await until(() => evaluate("return document.querySelector('.ci-log')?.textContent.includes('What will you keep');"), 'reply');
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
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.textContent === 'End').click();");
  await until(() => evaluate("return document.querySelector('.ci-panel')?.dataset.debriefed === 'true';"), 'debrief');
  const debrief = await evaluate("return document.querySelector('.ci-debrief').textContent;");
  for (const section of ['Problem solving', 'Coding', 'Communication', 'Testing & verification', 'Hire signal', 'Hints used', 'Time per phase', 'Practise next']) assert.ok(debrief.includes(section), section);
  await evaluate("[...document.querySelectorAll('.ci-toolbar button')].find(n => n.textContent === 'Back to coach').click();");
  await until(() => evaluate("return !!document.querySelector('.coach-bar');"), 'restored coach');
  console.log('Interview browser check passed: opening, turn, verdict, draft/reload, wall clock, debrief, controls, coach restoration.');
} finally {
  socket?.close(); chrome?.kill(); server?.kill();
  for (const item of pending.values()) clearTimeout(item.timer);
  await fs.rm(home, { recursive: true, force: true }); await fs.rm(profile, { recursive: true, force: true });
}
