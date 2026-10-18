// Isolated browser check: fake providers, fake Studycraft, never ports 4173/4317.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { workspace } from '../server/coach/test/tools-fixture.mjs';
import { flushRecall, readRecallState } from '../server/recall/sync.mjs';
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const origin = 'http://127.0.0.1:4196', debugPort = 9366;
const fixture = await workspace();
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-recall-chrome-'));
let server, chrome, socket, offline = false, calls = 0;
const studycraft = http.createServer(async (req, res) => {
  assert.equal(req.url, '/api/recall/import');
  assert.equal(req.headers.authorization, 'Bearer fake-recall-token');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const payload = JSON.parse(raw); calls++;
  res.setHeader('Content-Type', 'application/json');
  if (offline) { res.writeHead(503); res.end('{}'); return; }
  assert.equal(payload.author, 'tutor');
  res.end(JSON.stringify({ status: 'updated', noteId: 'pattern-note',
    url: `http://127.0.0.1:${studycraft.address().port}/notes/pattern-note`,
    externalId: payload.externalId, evidenceHash: payload.evidenceHash, revisionId: payload.revisionId }));
});
const note = { patternId: 'hashing-complement', title: 'Hashing: complement', body: 'Look up before insertion.',
  intuition: 'Remember previous values.', recall: 'Why look up first?', trap: 'No trap recorded.', failingCase: 'No failing case recorded.' };
const tools = body => JSON.stringify([{ tool: 'get_recall_evidence', arguments: { patternId: note.patternId } },
  { tool: 'save_recall_note', arguments: { ...note, body } }]);
async function until(read, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await read();
    if (result) return result;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function connectBrowser() {
  const target = await until(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json`);
      return (await response.json()).find(tab => tab.type === 'page');
    } catch { return null; }
  }, 'Chrome');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, message => {
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await call('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  }
  return { call, evaluate, wait: expression => until(() => evaluate(expression), expression) };
}


try {
  await new Promise((resolve, reject) => { studycraft.once('error', reject); studycraft.listen(0, '127.0.0.1', resolve); });
  const endpoint = `http://127.0.0.1:${studycraft.address().port}/api/recall/import`;
  await fsp.writeFile(path.join(fixture.root, 'coach-settings.json'), JSON.stringify({ provider: 'claude', model: 'default' }));
  server = spawn(process.execPath, ['server/index.mjs'], { cwd: ROOT, env: {
    ...process.env, STUDIO_HOME: fixture.root, STUDIO_PORT: '4196', STUDIO_MIRROR_DIR: '',
    STUDYCRAFT_RECALL_URL: endpoint, STUDYCRAFT_RECALL_TOKEN: 'fake-recall-token',
    STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'),
    STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'),
    FAKE_CLAUDE_MODE: 'tools', FAKE_CLAUDE_TOOL_CALLS: tools('Claude lesson.'), FAKE_CODEX_TOOL_CALLS: tools('Codex revision.'),
  }, stdio: ['ignore', 'ignore', 'pipe'] });
  let logs = ''; server.stderr.on('data', data => { logs = (logs + data).slice(-3000); });
  await until(async () => { if (server.exitCode !== null) throw Error(logs); try { return (await fetch(origin + '/api/health')).ok; } catch { return false; } }, 'scratch server');
  chrome = spawn(CHROME, ['--headless=new', '--disable-background-networking', '--no-first-run',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore' });
  const { call, evaluate, wait } = await connectBrowser();
  await call('Network.enable'); await call('Network.setBlockedURLs', { urls: ['https://*', 'http://leetcode.com/*', 'http://neetcode.io/*'] });
  await call('Page.navigate', { url: origin + '/#/p/two-sum' });
  await wait(`document.querySelector('.coach-recall')`);
  await evaluate(`document.body.classList.add('coach-open')`);
  await wait(`document.querySelector('.coach-recall').getBoundingClientRect().width > 0`);
  const geometry = await evaluate(`(() => { const b = document.querySelector('.coach-recall').getBoundingClientRect(); const c = document.querySelector('.coach-compose').getBoundingClientRect(); return {width:b.width,height:b.height,left:b.left,right:b.right,parentLeft:c.left,parentRight:c.right}; })()`);
  assert.ok(geometry.height >= 24 && geometry.width > 80 && geometry.left >= geometry.parentLeft && geometry.right <= geometry.parentRight);
  await evaluate(`document.querySelector('.coach-recall').click()`);
  await wait(`document.querySelector('[data-tool="save_recall_note"] a')?.textContent === 'Saved to Studycraft ↗'`);
  await wait(`!document.querySelector('.coach-recall').disabled`);
  offline = true;
  await fsp.writeFile(path.join(fixture.root, 'coach-settings.json'), JSON.stringify({ provider: 'codex', model: 'gpt-6-astra' }));
  await evaluate(`document.querySelector('.coach-recall').click()`);
  await wait(`[...document.querySelectorAll('[data-tool="save_recall_note"]')].some(n => n.textContent.includes('Pending sync'))`);
  await wait(`!document.querySelector('.coach-recall').disabled`);
  offline = false;
  process.env.STUDYCRAFT_RECALL_URL = endpoint; process.env.STUDYCRAFT_RECALL_TOKEN = 'fake-recall-token';
  await flushRecall(fixture.root, { force: true });
  const state = await readRecallState(fixture.root);
  assert.equal(state.outbox.items.length, 2); assert.ok(state.outbox.items.every(i => i.status === 'saved'));
  assert.equal(state.mapping[note.patternId].noteId, 'pattern-note'); assert.equal(calls, 3);
  await call('Page.reload');
  await wait(`document.querySelector('.coach-recall')`);
  await evaluate(`document.body.classList.add('coach-open')`);
  await wait(`document.querySelector('.recent-chat') || document.querySelector('[data-tool="save_recall_note"] a')`);
  await evaluate(`document.querySelector('.recent-chat')?.click()`);
  await wait(`document.querySelector('[data-tool="save_recall_note"] a')`);
  console.log('ok — recall action, both fake providers, saved/pending receipts, retry without generation, reload, measured bounds');
} finally {
  socket?.close();
  for (const child of [chrome, server]) if (child && child.exitCode === null && !child.signalCode) {
    await new Promise(resolve => { const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill(); });
  }
  await new Promise(resolve => studycraft.close(resolve));
  await fixture.cleanup(); await fsp.rm(profile, { recursive: true, force: true });
}
