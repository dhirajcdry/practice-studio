// Full visual audit: disposable data, browser profile, and retained report artifacts.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { runVisualAudit } from './visual-audit.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-home-'));
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-profile-'));
const output = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-report-'));
const origin = 'http://127.0.0.1:4181';
const debugOrigin = 'http://127.0.0.1:9444';
const code = 'class Solution:\n    def canJump(self, nums):\n        # Try the next reachable position.\n        return True\n';
let server, chrome;
let serverLog = '';

async function json(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(value, null, 2));
}

// Fixed check ports must belong to this run, never an existing Studio or browser.
async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(Error(`Port ${port} is unavailable; refusing to reuse an existing process (${error.code}).`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

async function seed() {
  const problems = [
    ['jump-game', 'Jump Game', '55', 'canJump', [{ name: 'nums', type: 'integer[]' }], 'boolean', '[2,3,1,1,4]', code],
    ['cheapest-flights-within-k-stops', 'Cheapest Flights Within K Stops', '787', 'findCheapestPrice', [
      { name: 'n', type: 'integer' }, { name: 'flights', type: 'integer[][]' },
      { name: 'src', type: 'integer' }, { name: 'dst', type: 'integer' }, { name: 'k', type: 'integer' },
    ], 'integer', '3\n[[0,1,100],[1,2,100],[0,2,500]]\n0\n2\n1', 'class Solution:\n    def findCheapestPrice(self, n, flights, src, dst, k):\n        return 200\n'],
  ];
  for (const [slug, title, questionId, name, params, type, input, solution] of problems) {
    await json(path.join(home, 'cache', 'leetcode', `${slug}.json`), { question: {
      title, titleSlug: slug, difficulty: 'Medium', questionId,
      content: '<p>Use the supplied inputs to solve this synthetic practice problem.</p><p>Explain your approach and consider the edge cases.</p>',
      metaData: JSON.stringify({ name, params, return: { type } }), exampleTestcases: input,
      codeSnippets: [{ langSlug: 'python3', code: solution }],
    } });
    const dir = path.join(home, 'problems', slug);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'solution.py'), solution);
    await json(path.join(dir, 'cases.json'), { cases: [{ input, expected: slug === 'jump-game' ? 'true' : '200', source: 'custom' }] });
  }
  const dir = path.join(home, 'problems', 'jump-game');
  const rows = [
    { at: '2026-10-17T01:00:00Z', submissionId: '1', verdict: 'Accepted', accepted: true, testsPassed: 178, testsTotal: 178 },
    { at: '2026-10-18T01:00:00Z', submissionId: '2', verdict: 'Time Limit Exceeded', accepted: false, testsPassed: 12, testsTotal: 178 },
  ].map(row => ({ ...row, source: 'studio', codeFile: `submissions/${row.submissionId}.py` }));
  await json(path.join(dir, 'meta.json'), { schemaVersion: 1, slug: 'jump-game', submissions: rows });
  for (const row of rows) {
    await json(path.join(dir, 'submissions', `${row.submissionId}.json`), {
      schemaVersion: 1, submissionId: row.submissionId, source: 'studio', at: row.at, verdict: row,
      failure: row.accepted ? null : { kind: 'timeout', lastTestcase: '[3,2,1,0,4]', expectedOutput: 'false' },
      details: row.accepted ? {
        runtime: { display: '23 ms', ms: 23, percentile: 44, unit: 'ms', distribution: [
          { bucket: 20, label: '20', pct: 25 }, { bucket: 23, label: '23', pct: 45 }, { bucket: 30, label: '30', pct: 30 },
        ] },
        memory: { display: '20.1 MB', mb: 20.1, percentile: 55, unit: 'KB', distribution: [
          { bucket: 20480, label: '20480', pct: 30 }, { bucket: 20582, label: '20582', pct: 40 }, { bucket: 21504, label: '21504', pct: 30 },
        ] },
      } : null,
      leadUp: { minutes: 12, localRuns: 8, coachAsks: 1 },
    });
    await fsp.writeFile(path.join(dir, row.codeFile), code);
  }
  await fsp.writeFile(path.join(dir, 'chats.jsonl'), JSON.stringify({
    at: '2026-10-18T01:00:00Z', sessionId: 'visual-past-chat', kind: 'question',
    ask: 'Both are good, right?', answer: 'Compare how far each choice lets you reach. Then try a case with a zero.',
  }) + '\n');
}

async function ready(read, child, label) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null || child.signalCode) throw Error(`${label} exited. ${serverLog}`);
    try { const value = await read(); if (value) return value; } catch { /* bounded readiness retry */ }
    await sleep(100);
  }
  throw Error(`Timed out waiting for ${label}. ${serverLog}`);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill();
  });
}

console.log(`Visual audit screenshots and findings: ${output}`);
try {
  await requireFreePort(4181);
  await requireFreePort(9444);
  await seed();
  // Missing content stays offline; the audit never sends a coach prompt.
  server = spawn(process.execPath, ['--input-type=module', '--eval',
    "globalThis.fetch = async () => { throw Error('Network disabled in visual check'); }; const m = await import('./server/index.mjs'); m.start();"], {
    cwd: ROOT, env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: '4181', STUDIO_MIRROR_DIR: '',
      STUDIO_CODEX_BINARY: '/nonexistent/visual-check-codex' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', error => { serverLog += error.message; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
  await ready(async () => (await fetch(`${origin}/api/health`)).ok, server, 'scratch server');
  chrome = spawn(CHROME, ['--headless=new', '--disable-background-networking', '--no-first-run',
    '--remote-debugging-port=9444', `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
  chrome.on('error', error => { serverLog += error.message; });
  const target = await ready(async () => (await (await fetch(`${debugOrigin}/json`)).json()).find(tab => tab.type === 'page'), chrome, 'headless Chrome');
  const findings = await runVisualAudit({ origin, target, output });
  for (const row of findings) console.error(`${row.theme}/${row.mode}/${row.state} | ${row.kind} | ${row.where || 'page'} | ${row.what || ''} ${row.detail}`);
  console.log(`${findings.length} findings. Screenshots and JSON: ${output}`);
  if (findings.length) process.exitCode = 1;
} catch (error) {
  console.error(`Visual check could not complete: ${error.message}`);
  process.exitCode = 1;
} finally {
  await stop(chrome);
  await stop(server);
  await fsp.rm(profile, { recursive: true, force: true });
  await fsp.rm(home, { recursive: true, force: true });
}
