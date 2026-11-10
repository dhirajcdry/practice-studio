import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { InterviewService, interviewRoutes } from './routes.mjs';
import { LeetCodeContentCache } from '../leetcode.mjs';

const binary = new URL('./test/fake-interviewer.mjs', import.meta.url).pathname;

async function harness(t, { cache, catalog } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-statement-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'cache', 'leetcode'), { recursive: true });
  const interview = new InterviewService({ root, binary });
  const context = { interview, leetcode: cache, catalog };
  async function call(route, body = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    req.url = route.split(' ')[1];
    let output = '', status;
    const res = { writeHead(c) { status = c; }, write(c) { output += c; }, end(c = '') { output += c; }, flushHeaders() {} };
    const method = route.split(' ')[0];
    await interviewRoutes[`${method} ${new URL(req.url, 'http://localhost').pathname}`](req, res, context);
    return { status, output };
  }
  return { root, interview, call, context };
}

test('paid cached problem uses premium statement for interview and persists it', async t => {
  const { interview, call, root, context } = await harness(t, { catalog: { get: () => ({ number: 999 }) } });
  await fs.mkdir(path.join(root, 'cache', 'premium-statements'), { recursive: true });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'paid-problem.json'), JSON.stringify({ complete: true, question: { title: 'Paid Problem', isPaidOnly: true, content: null } }));
  await fs.writeFile(path.join(root, 'cache', 'premium-statements', '999-paid-problem.json'), JSON.stringify({ descriptionHtml: '<p>Premium statement.</p>', statementSource: { name: 'fixture' }, examples: [] }));
  const cache = new LeetCodeContentCache({ cacheDir: path.join(root, 'cache', 'leetcode'), premiumCache: { cacheDir: path.join(root, 'cache', 'premium-statements') } });
  context.leetcode = cache;
  const opening = await call('POST /api/interview/start', { slug: 'paid-problem', mode: 'typed' });
  assert.equal(opening.status, 200);
  const id = [...opening.output.matchAll(/"id":"([^"]+)"/g)][0][1];
  const state = await interview.store.readState('paid-problem', id);
  assert.match(state.statement, /Premium statement/);
  assert.doesNotMatch(state.statement, /expected/);
});

test('missing, whitespace, and corrupt caches reject before creating an interview', async t => {
  const { interview, call, root } = await harness(t);
  let providerCalls = 0;
  interview.run = () => { providerCalls++; throw Error('Must not start a provider'); };
  for (const [slug, value] of [['missing', null], ['blank', { question: { title: 'Blank', content: '  ' } }], ['corrupt', '{']]) {
    if (value !== null) await fs.writeFile(path.join(root, 'cache', 'leetcode', `${slug}.json`), typeof value === 'string' ? value : JSON.stringify(value));
    await assert.rejects(call('POST /api/interview/start', { slug }), error => error.code === 'NO_STATEMENT');
    assert.equal((await interview.store.list(slug)).length, 0);
  }
  assert.equal(providerCalls, 0);
});

test('waits for an in-flight page-open cache write without fetching', async t => {
  const { interview, call, root, context } = await harness(t);
  let resolve;
  const pending = new Promise(r => { resolve = r; });
  let observed;
  const joined = new Promise(r => { observed = r; });
  const cache = { inFlight: { get: () => { observed(); return pending; } }, readCache: async slug => {
    const raw = JSON.parse(await fs.readFile(path.join(root, 'cache', 'leetcode', `${slug}.json`), 'utf8'));
    return raw;
  } };
  context.leetcode = cache;
  const start = call('POST /api/interview/start', { slug: 'race' });
  await joined;
  assert.equal((await interview.store.list('race')).length, 0);
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'race.json'), JSON.stringify({ complete: true, question: { title: 'Race', content: '<p>Loaded.</p>' } }));
  resolve();
  const opening = await start;
  assert.equal(opening.status, 200);
  const id = [...opening.output.matchAll(/"id":"([^"]+)"/g)][0][1];
  assert.match((await interview.store.readState('race', id)).statement, /Loaded/);
});

test('uses a cached NeetCode definition and later turns use persisted statement', async t => {
  const { interview, call, root, context } = await harness(t, { catalog: { get: () => ({ neetcodeSlug: 'demo' }) } });
  await fs.writeFile(path.join(root, 'cache', 'leetcode', 'demo-problem.json'), JSON.stringify({ complete: true, question: { title: 'Old', isPaidOnly: true, content: null } }));
  const neetcode = { read: async () => ({ ncSlug: 'demo', name: 'Demo', description: 'Explain it.', starterPython: '    def solve(self, nums: List[int]) -> int:\n        return 0', examples: ['nums = [1]'], testCaseType: 'method' }) };
  context.leetcode = new LeetCodeContentCache({ cacheDir: path.join(root, 'cache', 'leetcode'), entryFor: () => ({ neetcodeSlug: 'demo' }), neetcode });
  const opening = await call('POST /api/interview/start', { slug: 'demo-problem' });
  const id = [...opening.output.matchAll(/"id":"([^"]+)"/g)][0][1];
  const state = await interview.store.readState('demo-problem', id);
  assert.match(state.statement, /Explain it/);
  await fs.rm(path.join(root, 'cache', 'leetcode', 'demo-problem.json'));
  const turn = await call('POST /api/interview/turn', { slug: 'demo-problem', interviewId: id, said: 'I would scan it.', requestId: 'later' });
  assert.equal(turn.status, 200);
});

