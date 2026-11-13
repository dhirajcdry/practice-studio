import { cleanupChrome } from './chrome-cleanup.mjs';
import { problemDir } from '../server/storage-layout.mjs';
// Full visual audit: disposable data, browser profile, and retained report artifacts.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { newState } from '../server/interview/state.mjs';
import { InterviewStore } from '../server/interview/store.mjs';
import { runVisualAudit } from './visual-audit.mjs';
import { fixtureReport } from '../server/interview/test/report-fixture.mjs';
import { conversationTurns, formattedReply, mockFeedback } from './conversation-fixture.mjs';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-home-'));
const profile = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-profile-'));
const output = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visual-report-'));
const serverPort = Number(process.env.STUDIO_VISUAL_PORT) || 4181;
const debugPort = serverPort + 5263;
const origin = `http://127.0.0.1:${serverPort}`;
const debugOrigin = `http://127.0.0.1:${debugPort}`;
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
    ['import-sample', 'Import Sample', '900001', 'solve', [{ name: 'nums', type: 'integer[]' }], 'integer', '[1,2,3]', 'class Solution:\n    def solve(self, nums):\n        pass\n'],
    ['time-based-key-value-store', 'Time Based Key-Value Store', '981', 'lookup', [{ name: 'timestamp', type: 'integer' }], 'integer', '1', 'class Solution:\n    def lookup(self, timestamp):\n        # Synthetic visual fixture, not a TimeMap implementation.\n        return timestamp\n'],
    ['jump-game', 'Jump Game', '55', 'canJump', [{ name: 'nums', type: 'integer[]' }], 'boolean', '[2,3,1,1,4]', code],
    ['cheapest-flights-within-k-stops', 'Cheapest Flights Within K Stops', '787', 'findCheapestPrice', [
      { name: 'n', type: 'integer' }, { name: 'flights', type: 'integer[][]' },
      { name: 'src', type: 'integer' }, { name: 'dst', type: 'integer' }, { name: 'k', type: 'integer' },
    ], 'integer', '3\n[[0,1,100],[1,2,100],[0,2,500]]\n0\n2\n1', 'class Solution:\n    def findCheapestPrice(self, n, flights, src, dst, k):\n        return 200\n'],
  ];
  // A neutral collection fixture; real collections are private workspace data.
  await fsp.copyFile(path.join(ROOT, 'server', 'test', 'fixtures', 'collection.json'), path.join(home, 'collection.json'));
  for (const [slug, title, questionId, name, params, type, input, solution] of problems) {
    await json(path.join(home, 'cache', 'leetcode', `${slug}.json`), { question: {
      title, titleSlug: slug, difficulty: 'Medium', questionId,
      content: '<p>Use the supplied inputs to solve this synthetic practice problem.</p><p>Explain your approach and consider the edge cases.</p>',
      metaData: JSON.stringify({ name, params, return: { type } }), exampleTestcases: input,
      codeSnippets: [{ langSlug: 'python3', code: solution }],
    } });
    const dir = problemDir(home,slug);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'solution.py'), solution);
    await json(path.join(dir, 'cases.json'), { cases: [{ input, expected: slug === 'jump-game' ? 'true' : '200', source: 'custom' }] });
  }
  const store = new InterviewStore({ root: home });
  const conversationState = { ...newState({ slug: 'lld-locker', startedAt: Date.now() - 3480000, minutes: 60 }), discipline: 'lld', targetLevel: 'L4', pausedAt: Date.now(), lastCode: '# Candidate-owned design document\n' };
  await store.create('lld-locker', '1760000000000-00000011', conversationState);
  for (const turn of conversationTurns) await store.append('lld-locker', '1760000000000-00000011', turn);
  const designDir = path.join(home, 'design', '2026-11-04T12-00-00-000Z');
  await json(path.join(designDir, 'interview.json'), { prompt: 'Payment authorization', level: 'L4', minutes: 60, phase: 'design', startedAt: Date.now() - 3480000, debriefed: true, turns: [{}, {}] });
  await fsp.writeFile(path.join(designDir, 'turns.jsonl'), conversationTurns.map(turn => JSON.stringify({ ...turn, at: '2026-11-04T12:58:00Z' })).join('\n') + '\n');
  const lld = { ...newState({ slug: 'lld-locker', startedAt: Date.now() }), discipline: 'lld', targetLevel: 'L4', pausedAt: Date.now(), lastCode: '# Candidate-owned design document\n' };
  await store.create('lld-locker', '1760000000000-00000009', lld);
  await store.append('lld-locker', '1760000000000-00000009', { kind: 'opening', elapsedMs: 0, asked: 'Design a parcel locker system.' });
  await store.create('lld-locker','1760000000000-00000010',{...lld,debriefed:true,endedAt:Date.now()});
  await store.append('lld-locker','1760000000000-00000010',{kind:'turn',said:'Each reservation owns one locker.',asked:'How do you reject an expired code?',elapsedMs:5000});
  await store.append('lld-locker','1760000000000-00000010',{kind:'debrief',asked:'Review ownership and atomic reservation.',elapsedMs:60000});
  for (const [id, mode, done] of [['1760000000000-00000001', 'typed', false], ['1760000000000-00000002', 'voice', false], ['1760000000000-00000003', 'typed', true]]) {
    const state = newState({ slug: 'jump-game', mode, startedAt: Date.now() });
    state.phase = 'approach'; state.coachProvider = 'claude'; state.coachModel = 'default';
    state.debriefed = done; state.endedAt = done ? Date.now() : null;
    if (done) {
      state.startedAt = Date.now() - 540000; state.hireSignal = 'Lean hire'; state.phase = 'followup'; state.phaseSinceMs = 480000;
      state.phaseMs = { clarify: 45000, approach: 155000, code: 220000, test: 60000, followup: 0 };
      state.hints = [{ level: 'nudge', elapsedMs: 200000, phase: 'approach' }];
    }
    // Audit fixtures are paused so reading a screen cannot wake a model. The setup
    // below paints a running header with DOM only; no microphone or turn is started.
    if (!done) state.pausedAt = Date.now();
    await store.create('jump-game', id, state);
    await store.append('jump-game', id, { kind: 'opening', elapsedMs: 0, asked: 'Read the problem and walk me through your approach.' });
    await store.append('jump-game', id, { kind: 'candidate', elapsedMs: 30000, said: 'I would track the furthest reachable index.' });
    if (done) {
      // A finished interview with real evidence: a hint, a failing then passing run, an accepted submit.
      for (const entry of [
        { kind: 'opening', elapsedMs: 60000, asked: 'What is the time complexity?' },
        { kind: 'event', elapsedMs: 340000, event: { type: 'run_result', passed: 1, failed: 1, total: 2 } },
        { kind: 'candidate', elapsedMs: 360000, said: 'The loop bound was off by one, fixing it now.' },
        { kind: 'event', elapsedMs: 380000, event: { type: 'run_result', passed: 2, failed: 0, total: 2 } },
        { kind: 'event', elapsedMs: 480000, event: { type: 'verdict', verdict: 'Accepted', status: 'accepted', accepted: true } },
        { kind: 'buffer', elapsedMs: 480000, code },
        { kind: 'debrief', elapsedMs: 540000, asked: fixtureReport('I would track the furthest reachable index.') },
      ]) await store.append('jump-game', id, entry);
    }
  }
  for (const discipline of ['lld', 'design']) {
    const slug = discipline === 'lld' ? 'lld-locker' : 'design-url-shortener';
    const id = `visual-practice-${discipline}`, base = path.join(problemDir(home,slug), 'practice', id);
    await json(path.join(base, 'session.json'), { id, slug, discipline, title: discipline === 'lld' ? 'Locker system' : 'URL shortener', statement: discipline === 'lld' ? 'Design a locker system.' : 'Design a URL-shortening service.', mode: 'voice', createdAt: '2026-10-30T12:00:00Z', updatedAt: '2026-10-30T12:10:00Z' });
    await json(path.join(base, 'exchanges.json'), [{ requestId: 'fixture-question', question: 'What should I consider about concurrent reservations?', answer: formattedReply, status: 'complete', at: '2026-10-30T12:10:00Z' }]);
    await json(path.join(base, 'document.json'), { code: 'class Locker:\n    pass\n' });
    await json(path.join(base, 'elements.json'), []);
    await fsp.writeFile(path.join(problemDir(home,slug), 'NOTES.md'), '## Reservation ownership\n\nValidate ownership before releasing the resource.');
  }
  const branchId = 'visual-branch-lld', branchDir = path.join(problemDir(home,'lld-locker'),'practice',branchId);
  const source = {discipline:'lld',slug:'lld-locker',interviewId:'1760000000000-00000009',title:'Locker system',startedAt:Date.now()-3600000,capturedAt:new Date().toISOString(),completed:true};
  await json(path.join(branchDir,'session.json'),{id:branchId,slug:'lld-locker',discipline:'lld',title:'Locker system',statement:'Design a locker system.',mode:'typed',source,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()});
  await json(path.join(branchDir,'source.json'),{source,code:'class Locker:\n    pass\n',feedback:mockFeedback,turns:[]});
  await json(path.join(branchDir,'document.json'),{code:'class Locker:\n    pass\n'});
  await json(path.join(branchDir,'exchanges.json'),[]);
  const dir = problemDir(home,'jump-game');
  const rows = [
    { at: '2026-10-17T01:00:00Z', submissionId: '1', verdict: 'Accepted', accepted: true, testsPassed: 178, testsTotal: 178 },
    { at: '2026-10-18T01:00:00Z', submissionId: '2', verdict: 'Time Limit Exceeded', accepted: false, testsPassed: 12, testsTotal: 178 },
    { at: '2026-10-18T02:00:00Z', submissionId: '3', verdict: 'Wrong Answer', accepted: false, testsPassed: 30, testsTotal: 178 },
  ].map(row => ({ ...row, source: 'studio', codeFile: `submissions/${row.submissionId}.py` }));
  await json(path.join(dir, 'meta.json'), { schemaVersion: 1, slug: 'jump-game', submissions: rows });
  for (const row of rows) {
    await json(path.join(dir, 'submissions', `${row.submissionId}.json`), {
      schemaVersion: 1, submissionId: row.submissionId, source: 'studio', at: row.at, verdict: row,
      // Long, unspaced data: the shape that used to be cut mid-number at the box edge.
      failure: row.accepted ? null : row.submissionId === '3' ? { kind: 'wrong',
        lastTestcase: '[' + Array.from({ length: 28 }, (_, i) => 2147483600 + i).join(',') + ']\n[' + Array.from({ length: 22 }, (_, i) => `"reach${i}"`).join(',') + ']',
        expectedOutput: '[' + Array.from({ length: 24 }, (_, i) => i % 3 ? 2147483647 : 'null').join(',') + ']',
        output: '[' + Array.from({ length: 24 }, (_, i) => i % 4 ? 2147483647 : 'null').join(',') + ']' }
        : { kind: 'timeout', lastTestcase: '[3,2,1,0,4]', expectedOutput: 'false' },
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
  await requireFreePort(serverPort);
  await requireFreePort(debugPort);
  await seed();
  // Missing content stays offline; the audit never sends a coach prompt.
  server = spawn(process.execPath, ['--input-type=module', '--eval',
    "globalThis.fetch = async () => { throw Error('Network disabled in visual check'); }; const m = await import('./server/index.mjs'); m.start();"], {
    cwd: ROOT, env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(serverPort), STUDIO_MIRROR_DIR: '',
      STUDIO_CODEX_BINARY: '/nonexistent/visual-check-codex' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.on('error', error => { serverLog += error.message; });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', data => { serverLog = (serverLog + data).slice(-4000); });
  await ready(async () => (await fetch(`${origin}/api/health`)).ok, server, 'scratch server');
  chrome = spawn(CHROME, ['--headless=new', '--disable-background-networking', '--no-first-run',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'], { stdio: 'ignore' });
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
  await cleanupChrome(chrome, profile);
  await fsp.rm(home, { recursive: true, force: true });
}
