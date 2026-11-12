import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { randomViaConnector } from '../web/js/leetcode-bridge.js';

const source = await fs.readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const question = (paid = false) => ({ data: { randomQuestion: { titleSlug: 'sample-problem', isPaidOnly: paid } } });
function response(body, status = 200, type = 'application/json', challenge = '') {
  return { ok: status === 200, status, headers: { get: name => name === 'content-type' ? type : challenge },
    json: async () => body, text: async () => String(body) };
}
function load(fetchImpl) {
  const calls = [], removed = [];
  const context = { fetch: fetchImpl, location: { origin: 'https://leetcode.com' }, AbortSignal, setTimeout, clearTimeout,
    chrome: {
      runtime: { onConnect: { addListener() {} }, onInstalled: { addListener() {} } },
      cookies: { get: async () => ({ value: 'fake' }) },
      tabs: { query: async () => [{ id: 1, status: 'complete' }], remove: async id => removed.push(id) },
      scripting: { executeScript: async ({ func, args }) => { calls.push(func.name); return [{ result: await func(...args) }]; } },
    },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nglobalThis.readRandom = pageRandom; globalThis.workerRandom = fetchRandom;', context);
  return { context, calls, removed };
}

test('random query is algorithms-only with no difficulty and validated question fields', async () => {
  let reads = 0;
  const { context } = load(async (url, options) => {
    reads++; assert.equal(url, 'https://leetcode.com/graphql/');
    const body = JSON.parse(options.body);
    assert.deepEqual(body.variables, { categorySlug: 'algorithms', filters: {} });
    assert.equal(body.query, 'query randomQuestion($categorySlug: String, $filters: QuestionListFilterInput) { randomQuestion(categorySlug: $categorySlug, filters: $filters) { titleSlug isPaidOnly } }');
    return response(question());
  });
  const result = await context.workerRandom();
  assert.equal(reads, 1); assert.equal(result.ok, true); assert.equal(result.paidOnly, false);
});

test('premium picks allow exactly one replacement; errors never retry', async () => {
  for (const bodies of [[question(true), question()], [question(true), question(true)],
    [question(true), { errors: [{ message: 'Unknown field' }] }], [{ errors: [{ message: 'Unknown query' }] }]]) {
    let reads = 0;
    const { context } = load(async () => { assert.ok(reads < bodies.length); return response(bodies[reads++]); });
    const result = await context.workerRandom();
    assert.equal(reads, bodies.length);
    if (bodies.at(-1).data?.randomQuestion.isPaidOnly === false) assert.equal(result.ok, true);
    else assert.equal(result.ok, false);
    if (bodies.length === 2 && bodies[1].data?.randomQuestion.isPaidOnly) {
      assert.equal(result.code, 'PREMIUM_PROBLEM'); assert.match(result.message, /shuffle again/);
    }
  }
});

test('random response rejects malformed slugs, missing premium flag and GraphQL errors', async () => {
  for (const body of [{}, { data: { randomQuestion: { titleSlug: '../bad', isPaidOnly: false } } },
    { data: { randomQuestion: { titleSlug: 'valid' } } }, { ...question(), errors: [{ message: 'error' }] }]) {
    let reads = 0;
    const { context } = load(async () => { reads++; return response(body); });
    assert.equal((await context.workerRandom()).code, 'RANDOM_RESPONSE_INVALID'); assert.equal(reads, 1);
  }
});

test('random reports sign-in, rate limits, challenge and unreachable without retrying', async () => {
  for (const [reply, code] of [[response({}, 429), 'RATE_LIMITED'], [response({}, 401), 'SIGNED_OUT'],
    [response('Just a moment', 403, 'text/html', 'challenge'), 'JUDGE_UNREACHABLE'],
    [response('unavailable', 500, 'text/html'), 'JUDGE_UNREACHABLE'], [null, 'JUDGE_UNREACHABLE']]) {
    let reads = 0;
    const { context } = load(async () => { reads++; if (!reply) throw Error('offline'); return reply; });
    assert.equal((await context.workerRandom()).code, code); assert.equal(reads, 1);
  }
  const { context } = load(() => assert.fail('No network when signed out'));
  context.chrome.cookies.get = async () => null;
  assert.equal((await context.workerRandom()).code, 'SIGNED_OUT');
});

test('worker closes a background tab it created', async () => {
  const { context, removed } = load(async () => response(question()));
  vm.runInContext('leetcodeTab = async () => ({ id: 8, created: true });', context);
  assert.equal((await context.workerRandom()).ok, true);
  assert.deepEqual(removed, [8]);
});

test('page gates missing and older Connectors before sending any message', async () => {
  const previous = globalThis.document;
  try {
    for (const version of ['', '1.2.3']) {
      globalThis.document = { documentElement: { dataset: { studioConnector: version } } };
      const result = await randomViaConnector();
      assert.equal(result.code, version ? 'CONNECTOR_OUTDATED' : 'CONNECTOR_MISSING');
      assert.match(result.message, version ? /chrome:\/\/extensions/ : /Install Studio Connector/);
    }
  } finally { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; }
});

test('bridge relays random only from a marked Studio page and same window', async () => {
  const bridge = await fs.readFile(new URL('../extension/bridge.js', import.meta.url), 'utf8');
  let receive, marked = true;
  const sent = [];
  const window = { addEventListener: (_name, listener) => { receive = listener; }, postMessage() {} };
  const context = { window, location: { origin: 'http://localhost:4000' }, document: {
    documentElement: { dataset: {} }, querySelector: () => marked ? {} : null,
  }, chrome: { runtime: {
    getManifest: () => ({ version: '1.3.0' }),
    connect: () => ({ onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, postMessage: message => sent.push(message) }),
  } } };
  vm.runInNewContext(bridge, context);
  const data = { source: 'studio-page', type: 'random', id: 'fake' };
  receive({ source: {}, data }); assert.equal(sent.length, 0);
  marked = false; receive({ source: window, data }); assert.equal(sent.length, 0);
  marked = true; receive({ source: window, data }); assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'random');
  receive({ source: window, data: { ...data, type: 'unknown' } }); assert.equal(sent.length, 1);
});
