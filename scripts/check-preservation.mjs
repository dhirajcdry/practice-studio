// Navigation/reload regression checks using synthetic records, a fake coach and fake
// audio. No learner cache, real coach turn, or running Studio server is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-preserve-'));
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-preserve-profile-'));
const origin = 'http://127.0.0.1:4193';
const debug = 9349;
const cache = path.join(scratch, 'cache', 'leetcode');
await fsp.mkdir(cache, { recursive: true });
for (const [slug, title] of [['two-sum', 'Two Sum'], ['contains-duplicate', 'Contains Duplicate'], ['longest-common-prefix', 'Longest Common Prefix']]) {
  await fsp.writeFile(path.join(cache, `${slug}.json`), JSON.stringify({ slug, fetchedAt: new Date().toISOString(), question: {
    questionId: '1', questionFrontendId: '1', titleSlug: slug, title, content: '<p>Synthetic preservation fixture.</p>',
    difficulty: 'Easy', isPaidOnly: false, exampleTestcases: '', topicTags: [],
    metaData: JSON.stringify({ name: 'solve', params: [], return: { type: 'integer' } }),
    codeSnippets: [{ lang: 'Python3', langSlug: 'python3', code: 'class Solution:\n    def solve(self):\n        pass\n' }],
  } }));
}
await fsp.writeFile(path.join(scratch, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
let serverLog = '';
const server = spawn(process.execPath, ['server/index.mjs'], {
  cwd: ROOT, env: { ...process.env, STUDIO_HOME: scratch, STUDIO_PORT: '4193',
    STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'),
    STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'),
    FAKE_CLAUDE_MODE: 'ok' }, stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-2000); });
let chrome, ws;
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw Error(`scratch server failed: ${serverLog}`);
    try { ready = (await fetch(`${origin}/api/stats`)).ok; if (ready) break; } catch { /* wait for startup */ }
    await sleep(100);
  }
  if (!ready) throw Error(`scratch server did not start: ${serverLog}`);
  chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${debug}`,
    `--user-data-dir=${profile}`, '--window-size=1500,1000',
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', 'about:blank'], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${debug}/json`)).json()).find(t => t.type === 'page'); if (target) break; } catch { /* startup */ }
    await sleep(100);
  }
  if (!target) throw Error('Chrome debugging socket unavailable');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const n = ++id;
    const timer = setTimeout(() => { pending.delete(n); reject(Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(n, message => { clearTimeout(timer); message.error ? reject(Error(JSON.stringify(message.error))) : resolve(message); });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
  ws.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    if (message.method === 'Page.javascriptDialogOpening') call('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
  });
  const evaluate = async expression => {
    const result = (await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true })).result;
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async expression => {
    const result = await evaluate(`(async () => {
      for (let i=0; i<200; i++) { if (${expression}) return true; await new Promise(r=>setTimeout(r,50)); }
      return false;
    })()`);
    assert.equal(result, true, `timed out: ${expression}`);
  };
  const go = async slug => {
    await evaluate(`location.hash = ${JSON.stringify('#/p/' + slug)}`);
    await waitFor(`document.querySelector('.coach-compose textarea') && document.querySelector('.ws')?.isConnected`);
    await sleep(150);
  };
  await call('Page.enable');
  // Speech upload is stubbed locally; fake-device audio must never launch a model.
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, options) => String(url) === '/api/asr'
      ? Promise.resolve(new Response(JSON.stringify({ok:true,text:'synthetic spoken words'}), {headers:{'Content-Type':'application/json'}}))
      : realFetch(url, options);
  ` });
  await call('Page.navigate', { url: `${origin}/#/p/two-sum` });
  await waitFor(`document.querySelector('.coach-compose textarea')`);
  await evaluate(`document.querySelector('.coach-launch').click()`);
  const type = text => evaluate(`(() => { const box=document.querySelector('.coach-compose textarea'); box.value=${JSON.stringify(text)}; box.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  const text = () => evaluate(`document.querySelector('.coach-compose textarea').value`);
  await type('keep my question');
  await go('contains-duplicate');
  assert.equal(await text(), '');
  await type('a separate question');
  await go('two-sum');
  assert.equal(await text(), 'keep my question');
  await call('Page.reload', { ignoreCache: true });
  await sleep(500); await waitFor(`document.querySelector('.coach-compose textarea')`);
  assert.equal(await text(), 'keep my question');
  console.log('ok — composer drafts survive navigation/reload and stay scoped to their problem');

  const cmdArrow = (code, extra = {}) => evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {code:${JSON.stringify(code)}, key:${JSON.stringify(code)}, metaKey:true, bubbles:true, ...${JSON.stringify(extra)}}))`);
  await go('two-sum');
  await evaluate(`document.activeElement?.blur()`);
  await cmdArrow('ArrowRight');
  await waitFor(`location.hash === '#/p/longest-common-prefix'`);
  await waitFor(`document.querySelector('.coach-compose textarea')`);
  await evaluate(`document.activeElement?.blur()`);
  await cmdArrow('ArrowLeft');
  await waitFor(`location.hash === '#/p/two-sum'`);
  await waitFor(`document.querySelector('.coach-compose textarea')`);
  await evaluate(`(() => { const box=document.querySelector('.coach-compose textarea'); box.focus(); box.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowRight',key:'ArrowRight',metaKey:true,bubbles:true})); })()`);
  assert.equal(await evaluate('location.hash'), '#/p/two-sum');
  await waitFor(`document.querySelector('.monaco-editor textarea')`);
  await evaluate(`(() => { const editor=document.querySelector('.monaco-editor textarea'); editor.focus(); editor.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowRight',key:'ArrowRight',metaKey:true,bubbles:true})); })()`);
  assert.equal(await evaluate('location.hash'), '#/p/two-sum');
  console.log('ok — command-arrow navigation moves between neighbours and ignores composer/editor focus');

  await evaluate(`document.querySelector('.coach-compose textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true}))`);
  await waitFor(`JSON.parse(localStorage.getItem('studio.coach.seenRuns.v1') || '[]').length > 0`);
  await go('contains-duplicate');
  await evaluate(`(async () => (await import('/js/coachruns.js')).adopt())()`);
  assert.equal(await evaluate(`document.querySelector('.coach-runs')?.textContent.includes('answer ready') || [...document.querySelectorAll('.coach-run-state')].some(n=>n.textContent==='answer ready')`), false);
  await go('two-sum'); await go('contains-duplicate');
  await call('Page.reload', { ignoreCache: true });
  await sleep(500); await waitFor(`document.querySelector('.coach-compose textarea')`);
  await evaluate(`(async () => (await import('/js/coachruns.js')).adopt())()`);
  assert.equal(await evaluate(`document.querySelectorAll('.coach-run-state').length`), 0);
  console.log('ok — seen finished runs stay acknowledged after remount, adoption and reload');

  await go('two-sum');
  await evaluate(`document.querySelector('.rec-toggle').click()`);
  await waitFor(`document.querySelector('.rec.is-live') && localStorage.getItem('studio.attempt.v1')`);
  const attempt = await evaluate(`JSON.parse(localStorage.getItem('studio.attempt.v1'))`);
  for (const hash of ['#/p/contains-duplicate', '#/', '#/roadmap', '#/progress', '#/design', '#/p/two-sum']) {
    await evaluate(`location.hash=${JSON.stringify(hash)}`); await sleep(200);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('studio.attempt.v1')).attemptId`), attempt.attemptId);
    const bounds = await evaluate(`(() => { const node=document.querySelector('#recmount .rec'); const r=node?.getBoundingClientRect(); return {width:r?.width,height:r?.height, title:node?.querySelector('.rec-problem')?.textContent}; })()`);
    assert.ok(bounds.width > 0 && bounds.height > 0, `recorder visible on ${hash}`);
    if (hash !== '#/p/two-sum') assert.equal(bounds.title, 'Two Sum');
  }
  await call('Page.reload', { ignoreCache: true });
  await sleep(500); await waitFor(`document.querySelector('.rec.is-live')`);
  assert.equal(await evaluate(`JSON.parse(localStorage.getItem('studio.attempt.v1')).attemptId`), attempt.attemptId);
  await go('contains-duplicate');
  // Let the resumed segment clear the recorder's minimum useful-audio duration.
  await sleep(1500);
  await evaluate(`document.querySelector('.rec-toggle').click()`);
  await waitFor(`!localStorage.getItem('studio.attempt.v1')`);
  await waitFor(`document.querySelector('.coach-run-title')?.textContent === 'Two Sum'`);
  const files = await fsp.readdir(path.join(scratch, 'problems', 'two-sum', 'sessions'));
  const events = (await Promise.all(files.filter(f=>f.endsWith('.jsonl')).map(f=>fsp.readFile(path.join(scratch,'problems','two-sum','sessions',f),'utf8')))).join('\n').split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(events.filter(e=>e.type==='attempt_started').length, 1);
  assert.equal(events.filter(e=>e.type==='attempt_resumed').length, 1);
  assert.equal(events.filter(e=>e.type==='attempt_ended').length, 1);
  assert.ok(events.filter(e=>e.type.startsWith('attempt_')).every(e=>e.data.attemptId===attempt.attemptId));
  console.log('ok — fake-microphone attempt survives every route and reload with one identity');
} finally {
  ws?.close(); chrome?.kill(); server.kill();
  await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(profile, { recursive: true, force: true }).catch(() => {});
}
