import { checkControls } from './check-controls.mjs';
// Exercise saved submissions in a disposable workspace and browser profile.
// External judge hosts are blocked before navigation; no real tutor turns are run.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const origin = 'http://127.0.0.1:4198';
const debugPort = 9358;
const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-submissions-'));
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-submissions-profile-'));
const originalCode = '# current buffer\n';
const savedCode = '# saved submission\nclass Solution:\n    pass\n';
let server;
let chrome;
let socket;
let serverLog = '';

async function writeJson(file, value) {
  await fsp.writeFile(file, JSON.stringify(value));
}

async function seedWorkspace() {
  const problem = path.join(scratch, 'problems', 'two-sum');
  await fsp.mkdir(path.join(scratch, 'cache', 'leetcode'), { recursive: true });
  await fsp.mkdir(path.join(problem, 'submissions'), { recursive: true });
  await writeJson(path.join(scratch, 'cache', 'leetcode', 'two-sum.json'), { question: {
    title: 'Two Sum', titleSlug: 'two-sum', difficulty: 'Easy', content: '<p>Synthetic</p>', questionId: '1',
    metaData: JSON.stringify({
      name: 'twoSum', params: [{ name: 'nums', type: 'integer[]' }, { name: 'target', type: 'integer' }],
      return: { type: 'integer[]' },
    }),
    exampleTestcases: '[2,7]\n9', codeSnippets: [{ langSlug: 'python3', code: 'class Solution: pass' }],
  } });
  const rows = [1, 2, 3].map((id, index) => ({
    at: index === 0 ? '2026-10-17T01:00:00.000Z' : `2026-10-18T0${index + 1}:00:00.000Z`, submissionId: String(id), source: 'studio',
    verdict: index === 1 ? 'Wrong Answer' : 'Accepted', accepted: index !== 1,
    testsPassed: index === 1 ? 79 : 178, testsTotal: 178, codeFile: `submissions/${id}.py`,
  }));
  await writeJson(path.join(problem, 'meta.json'), { schemaVersion: 1, slug: 'two-sum', submissions: rows });
  for (const row of rows) {
    await fsp.writeFile(path.join(problem, row.codeFile), savedCode);
    if (row.submissionId === '1') continue; // Old accepted record, no sidecar.
    await writeJson(path.join(problem, 'submissions', `${row.submissionId}.json`), {
      schemaVersion: 1, submissionId: row.submissionId, source: 'studio', at: row.at, verdict: row,
      failure: row.accepted ? null : {
        kind: 'wrong_answer', lastTestcase: '[1,2,3]', expectedOutput: '[1,2]', output: '[1,3]',
        stdout: Array.from({ length: 18 }, (_, index) => `Diagnostic line ${index}`).join('\n'),
      },
      details: row.accepted ? {
        runtime: { display: '23 ms', ms: 23, percentile: 44, unit: 'ms', distribution: [
          { bucket: 20, label: '20', pct: 25 }, { bucket: 23, label: '23', pct: 45 },
          { bucket: 30, label: '30', pct: 30 },
        ] },
        memory: { display: '20.1 MB', mb: 20.1, percentile: 55, distribution: [{ bucket: 20480, label: '20480', pct: 30 }, { bucket: 20582, label: '20582', pct: 40 }, { bucket: 21504, label: '21504', pct: 30 }], unit: 'KB' },
      } : null,
      leadUp: { minutes: 12, localRuns: 8, coachAsks: 1 },
    });
  }
  await fsp.writeFile(path.join(problem, 'solution.py'), originalCode);
  const chats = rows.slice(0, 2).map((row, index) => ({
    at: row.at, sessionId: `seed-${index + 1}`, kind: index ? 'attempt-review' : 'question',
    ask: index ? 'Review my latest attempt.' : 'What edge case should I try?',
    answer: 'Synthetic coach answer for the check.',
  }));
  await fsp.writeFile(path.join(problem, 'chats.jsonl'), chats.map(chat => JSON.stringify(chat)).join('\n') + '\n');
}

/** One bounded watcher owns readiness polling; failures keep the child's useful log. */
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

async function checkPanel({ call, evaluate, wait }) {
  await call('Network.enable');
  await call('Network.setBlockedURLs', { urls: ['https://*', 'http://leetcode.com/*', 'http://neetcode.io/*'] });
  await call('Page.enable');
  await call('Page.navigate', { url: `${origin}/#/p/two-sum` });
  await wait(`document.querySelector('.coach-launch')`);
  // Same hash, so the panel is still open: the launcher toggles, and a blind click would
  // close it and leave every later measurement reading a hidden panel as zeros.
  await sleep(400);
  await evaluate(`document.body.classList.contains('coach-open') || document.querySelector('.coach-launch').click()`);
  await wait(`document.body.classList.contains('coach-open') && document.querySelector('.coach-bar').getBoundingClientRect().height > 0`);
  await wait(`document.querySelector('.recent-chat')`);
  assert.equal(await evaluate(`document.querySelector('.coach-state').hidden && document.querySelector('.coach-sep').hidden`), true, 'idle has no state label or dot');
  await evaluate(`document.querySelector('.recent-chat').click()`);
  await evaluate(`document.querySelector('[aria-label="History"]').click()`);
  await wait(`document.querySelector('.chat-history-popover .recent-chat')`);
  assert.equal(await evaluate(`(() => {
    const panel = document.querySelector('.coach').getBoundingClientRect();
    const popover = document.querySelector('.chat-history-popover').getBoundingClientRect();
    return popover.left >= panel.left && popover.right <= panel.right && popover.bottom <= panel.bottom;
  })()`), true, 'history popover fits inside the panel');
  await evaluate(`document.querySelectorAll('.coach-tab')[1].click()`);
  await wait(`document.querySelectorAll('.submission-row').length === 3`);
  assert.equal(await evaluate(`document.querySelector('[aria-label=History]').hidden && document.querySelector('[aria-label="New chat"]').hidden && document.querySelector('.chat-history-popover').hidden`), true, 'submissions hides chat tools and popover');
  for (const width of [380, 460]) {
    // Set the panel itself, not the viewport: the workspace uses desktop columns.
    await evaluate(`(() => {
      const panel = document.querySelector('.coach');
      panel.style.width = '${width}px';
      panel.style.minWidth = '${width}px';
      panel.style.maxWidth = '${width}px';
    })()`);
    assert.equal(await evaluate(`(() => {
      const row = document.querySelector('.submission-row');
      const box = row.getBoundingClientRect(), chevron = row.querySelector('.submission-chevron').getBoundingClientRect();
      return Math.abs(box.top + box.height / 2 - chevron.top - chevron.height / 2) <= 1
        && row.querySelector('.submission-row-top').getBoundingClientRect().right <= chevron.left;
    })()`), true, 'row reserves space for a vertically centred chevron');
    await evaluate(`document.querySelector('.submission-row').click()`);
    await wait(`document.querySelector('.submission-chart')`);
    assert.equal(await evaluate(`document.querySelector('.submission-hero h3').textContent`), 'Accepted');
    assert.equal(await evaluate(`(() => {
      return [...document.querySelectorAll('.submission-segments')].every(track => {
        const box = track.getBoundingClientRect();
        const header = track.parentElement.getBoundingClientRect();
        return box.width < header.width && Math.abs(box.left - header.left) <= 1
          && [...track.children].every(button => Math.abs(button.getBoundingClientRect().height
            - parseFloat(getComputedStyle(button).getPropertyValue('--control-h-sm'))) <= 1);
      });
    })()`), true, 'segments are content-width, left-aligned and use the small control height');
    await evaluate(`[...document.querySelectorAll('.submission-segments button')].find(n => n.textContent === 'Memory').click()`);
    assert.equal(await evaluate(`document.querySelector('.submission-chart .you')?.getAttribute('aria-label')`), '20582 KB · 40% of submissions');
    // Measure the settled layout. The detail slides in, and mid-slide it is wider than
    // the panel by design; the container clips that, so only the resting state counts.
    await evaluate(`Promise.all(document.getAnimations().map(a => a.finished.catch(() => {})))`);
    // Name the offenders rather than reporting a bare false: a layout failure is only
    // actionable when it says which element stuck out, and by how much.
    assert.deepEqual(await evaluate(`(() => {
      const root = document.querySelector('.submissions');
      const panel = root.getBoundingClientRect();
      const offenders = [...root.querySelectorAll('*')].filter(node => {
        const box = node.getBoundingClientRect();
        return box.width && (box.left < panel.left - 1 || box.right > panel.right + 1);
      }).slice(0, 5).map(node => {
        const box = node.getBoundingClientRect();
        const name = node.className?.baseVal ?? node.className;
        return node.tagName.toLowerCase() + (name ? '.' + String(name).split(' ').join('.') : '')
          + ' overflows by ' + Math.round(Math.max(panel.left - box.left, box.right - panel.right)) + 'px';
      });
      if (root.scrollWidth > root.clientWidth + 1) offenders.unshift('scrollWidth ' + root.scrollWidth + ' > ' + root.clientWidth);
      return offenders;
    })()`), [], `detail fits ${width}px panel`);
    assert.equal(await evaluate(`(() => {
      const root = document.querySelector('.submissions');
      // Short enough that the detail must scroll; otherwise "sticky" is never exercised.
      root.style.maxHeight = '260px';
      root.scrollTop = root.scrollHeight;
      const header = root.querySelector('.submission-navigation').getBoundingClientRect();
      return root.scrollTop > 0 && Math.abs(header.top - root.getBoundingClientRect().top) <= 1;
    })()`), true, 'header remains at the top after scrolling');
    await evaluate(`document.querySelector('.submissions').style.maxHeight = ''`);
    await evaluate(`document.querySelector('.submission-navigation button').click()`);
    assert.equal(await evaluate(`(() => {
      const panel = document.querySelector('.submissions');
      return panel.scrollWidth <= panel.clientWidth + 1;
    })()`), true, `list fits ${width}px panel`);
  }
  await evaluate(`document.querySelectorAll('.submission-row')[1].click()`);
  assert.equal(await evaluate(`!!document.querySelector('.failure-block') && !document.querySelector('.submission-chart')`), true, 'wrong answer has failure blocks only');
  await evaluate(`document.querySelectorAll('.coach-tab')[1].click()`);
  await wait(`document.querySelectorAll('.submission-row').length === 3`);
  await evaluate(`document.querySelectorAll('.submission-row')[2].click()`);
  assert.equal(await evaluate(`document.querySelector('.submissions').textContent.includes("Charts weren't kept for this submission.")`), true, 'old accepted record has missing charts');
  assert.deepEqual(await evaluate(`[...document.querySelectorAll('.submission-segments button')].map(b => b.textContent)`),
    ['Code', 'vs editor'], 'no chart switch or previous comparison for the oldest chartless submission');
  await evaluate(`[...document.querySelectorAll('.submission-segments button')].find(b => b.textContent === 'vs editor').click()`);
  await wait(`document.querySelector('.submission-diff')`);
  await evaluate(`document.querySelectorAll('.coach-tab')[1].click()`);
  await evaluate(`document.querySelector('.submission-row').click()`);
  await evaluate(`[...document.querySelectorAll('.submissions button')]
    .find(button => button.textContent === 'vs previous').click()`);
  await wait(`document.querySelector('.submission-diff')`);
  await evaluate(`[...document.querySelectorAll('.submissions button')]
    .find(button => button.textContent === 'Load into editor').click()`);
  const getCode = `(async () => (await import('/js/editor.js')).submissionEditor('two-sum').getCode())()`;
  await wait(`document.querySelector('.submission-status')?.textContent.includes('loaded')`);
  assert.equal(await evaluate(getCode), savedCode, 'load changes the editor buffer');
  await evaluate(`document.querySelector('.monaco-editor textarea').focus()`);
  await call('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'z', code: 'KeyZ', modifiers: 4, windowsVirtualKeyCode: 90, commands: ['undo'],
  });
  await call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'z', code: 'KeyZ', modifiers: 4 });
  await wait(`${getCode}.then(code => code === ${JSON.stringify(originalCode)})`);
  assert.equal(await evaluate(getCode), originalCode, 'Command-Z restores the original buffer');
  await call('Page.navigate', { url: `${origin}/#/p/two-sum` });
  await wait(`document.querySelector('.coach-launch')`);
  await sleep(400);
  await evaluate(`document.body.classList.contains('coach-open') || document.querySelector('.coach-launch').click()`);
  await wait(`document.body.classList.contains('coach-open') && document.querySelector('.coach-bar').getBoundingClientRect().height > 0`);
  await wait(`document.querySelector('.recent-chat')`);
  await evaluate(`document.querySelector('.recent-chat').click()`);
  await evaluate(`document.querySelector('[aria-label="History"]').click()`);
  await wait(`document.querySelector('.chat-history-popover .recent-chat')`);
  await checkControls({ call, evaluate, wait }, origin);
  await call('Page.navigate', { url: `${origin}/tests.html` });
  await wait(`document.title.startsWith('PASS') || document.title.startsWith('FAIL')`);
  assert.equal(await evaluate(`document.title.startsWith('PASS')`), true, 'browser rendering tests pass');
}

try {
  await seedWorkspace();
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: ROOT,
    env: {
      ...process.env, STUDIO_HOME: scratch, STUDIO_PORT: '4198',
      STUDIO_COACH_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-claude.mjs'),
      STUDIO_CODEX_BINARY: path.join(ROOT, 'server/coach/test/bin/fake-codex.mjs'),
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  server.stderr.on('data', chunk => { serverLog = (serverLog + chunk).slice(-2000); });
  await until(async () => {
    if (server.exitCode !== null) throw new Error(`Scratch server failed: ${serverLog}`);
    try { return (await fetch(`${origin}/api/stats`)).ok; }
    catch { return false; }
  }, 'scratch server');
  chrome = spawn(CHROME, [
    '--headless=new', '--disable-background-networking', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`,
    '--window-size=1500,1000', 'about:blank',
  ], { stdio: 'ignore' });
  await checkPanel(await connectBrowser());
  console.log('ok — submissions, history, bounds, sticky navigation and editor undo');
} finally {
  socket?.close();
  // Wait for both children to exit before deleting their directories: Chrome keeps
  // writing its profile while it shuts down, and removing it underneath fails ENOTEMPTY.
  const exited = child => child && child.exitCode === null && child.signalCode === null
    ? new Promise(resolve => child.once('exit', resolve)) : Promise.resolve();
  const closing = [exited(chrome), exited(server)];
  chrome?.kill();
  server?.kill();
  await Promise.all(closing);
  await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 5 });
  await fsp.rm(profile, { recursive: true, force: true, maxRetries: 5 });
}
