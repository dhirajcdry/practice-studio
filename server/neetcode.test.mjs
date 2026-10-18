import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseNeetCodePage, parseNeetCodeExample, neetcodeDefinition, NeetCodeContentCache, cleanStatement, statementOutputs, neetcodeExpectedHtml } from './neetcode.mjs';
import { LeetCodeContentCache } from './leetcode.mjs';
import { readCachedProblem } from './coach/problem-cache.mjs';
import { loadProblemContext } from './runner/routes.mjs';
import { problemCases } from './runner/case-list.mjs';
import { runCode } from './runner/run.mjs';

const fixture = slug => fsp.readFile(new URL(`./test/fixtures/neetcode/${slug}.html`, import.meta.url), 'utf8');
const parsed = async slug => parseNeetCodePage(await fixture(slug));
const definitions = [
  ['islands-and-treasure', 'islandsAndTreasure', 2], ['foreign-dictionary', 'foreignDictionary', 3],
  ['string-encode-and-decode', 'encode', 2], ['meeting-schedule', 'canAttendMeetings', 2],
  ['meeting-schedule-ii', 'minMeetingRooms', 2], ['valid-tree', 'validTree', 2],
  ['count-connected-components', 'countComponents', 2],
];
async function temp(t) { const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-nc-test-')); t.after(() => fsp.rm(dir, { recursive: true, force: true })); return dir; }

test('all fixtures select NeetCode methods, examples and the outputs NeetCode prints', async () => {
  for (const [slug, method, count] of definitions) {
    const p = await parsed(slug);
    const d = neetcodeDefinition(p);
    assert.equal(d.metaData.name, method);
    assert.equal(p.examples.length, count);
    const cases = problemCases({ ...d, pythonStub: d.codeSnippets[0].code }, slug === 'string-encode-and-decode' ? 'encode-and-decode-strings' : slug);
    assert.equal(cases.runnable, true);
    assert.equal(cases.examples.length, count);
    // Foreign Dictionary accepts any valid order, so its printed output is no answer key.
    const want = slug === 'foreign-dictionary' ? null : d.metaData.neetcodeExpected;
    assert.deepEqual(cases.examples.map(c => c.expected), want ?? Array(count).fill(null));
  }
  assert.deepEqual(neetcodeDefinition(await parsed('islands-and-treasure')).metaData.neetcodeExpected,
    ['[[3,-1,0,1],[2,2,1,-1],[1,-1,2,-1],[0,-1,3,4]]', '[[0,-1],[1,2]]']);
  const pro = await parsed('the-earliest-moment-when-everyone-become-friends');
  assert.equal(pro.proOnly, true);
  assert.equal(neetcodeDefinition(pro), null);
});

test('both transfer-state ids; strict whitelist drops answers at parse time', async () => {
  const raw = { id: 'test', name: 'Test', free: false, starterCode: { python: 'class Solution:', java: 'secret' }, solutions: 'secret', article_body: 'secret', video: 'secret', custom_test_cases: ['n=1'] };
  for (const id of ['ng-state', 'serverApp-state']) {
    const p = parseNeetCodePage(`<script type="application/json" id="${id}">${JSON.stringify({ 'problem-test': raw })}</script>`);
    assert.deepEqual(Object.keys(p).sort(), ['ncSlug','name','description','starterPython','examples','testCaseType','proOnly','message'].sort());
    assert.equal(p.proOnly, false);
    assert.ok(!JSON.stringify(p).includes('secret'));
  }
  assert.equal(parseNeetCodePage('<html>unavailable</html>'), null);
});

test('example assignments preserve nested commas, strings and tuple values', () => {
  assert.deepEqual(parseNeetCodeExample('grid=[[1,2],[3,4]]', ['grid']), [[[1,2],[3,4]]]);
  assert.deepEqual(parseNeetCodeExample('n=5, edges=[[0,1],[1,2]]', ['n','edges']), [5,[[0,1],[1,2]]]);
  assert.deepEqual(parseNeetCodeExample('n=5\nedges=[]', ['n','edges']), [5,[]]);
  assert.deepEqual(parseNeetCodeExample('intervals=[(0,30),(5,10)]', ['intervals']), [[[0,30],[5,10]]]);
  assert.deepEqual(parseNeetCodeExample('strs=["a,b", "x=(y,z)", "quote: \\"]"]', ['strs']), [['a,b','x=(y,z)','quote: "]']]);
  assert.throws(() => parseNeetCodeExample('wrong=1', ['n']));
});

test('cache coalesces a miss, uses correct URL and stores no answers; failure returns null', async t => {
  let calls = 0;
  const dir = await temp(t);
  const cache = new NeetCodeContentCache({ cacheDir: dir, fetchImpl: async (url, opts) => {
    calls++;
    assert.equal(url, 'https://neetcode.io/problems/valid-tree/question');
    assert.match(opts.headers['user-agent'], /Mozilla/);
    assert.ok(opts.signal);
    return { ok: true, text: () => fixture('valid-tree') };
  } });
  await Promise.all([cache.get('valid-tree'), cache.get('valid-tree')]);
  await cache.get('valid-tree');
  assert.equal(calls, 1);
  assert.deepEqual(await fsp.readdir(dir), ['valid-tree.json']);
  assert.deepEqual(JSON.parse(await fsp.readFile(path.join(dir, 'valid-tree.json'), 'utf8')), await parsed('valid-tree'));
  cache.fetchImpl = async () => { throw new Error('offline'); };
  assert.equal(await cache.get('missing'), null);
});

test('premium definition reaches runner, cache-only coach and workspace; public/pro/failure preserve fallback', async t => {
  const root = await temp(t);
  let ncCalls = 0;
  const nc = new NeetCodeContentCache({ cacheDir: path.join(root, 'cache/neetcode'), fetchImpl: async () => {
    ncCalls++; return { ok: true, text: () => fixture('islands-and-treasure') };
  } });
  const cache = new LeetCodeContentCache({ cacheDir: path.join(root, 'cache/leetcode'), neetcode: nc,
    entryFor: () => ({ neetcodeSlug: 'islands-and-treasure', number: 286 }),
    fetchQuestionImpl: async slug => ({ isPaidOnly: slug !== 'public', content: null, metaData: { name: 'wallsAndGates' }, codeSnippets: null }),
  });
  const c = (await cache.getContent('walls-and-gates')).content;
  assert.equal(c.metaData.name, 'islandsAndTreasure');
  assert.match(c.codeSnippets[0].code, /islandsAndTreasure/);
  const coach = await readCachedProblem({ leetcode: cache, root, slug: 'walls-and-gates' });
  assert.equal(coach.metaData.params[0].name, 'grid');
  assert.match(coach.pythonStub, /islandsAndTreasure/);
  const runner = await loadProblemContext({ leetcode: cache }, 'walls-and-gates', {});
  assert.equal(runner.metaData.name, 'islandsAndTreasure');
  assert.match(runner.pythonStub, /islandsAndTreasure/);
  const raw = JSON.parse(await fsp.readFile(cache.cacheFile('walls-and-gates'), 'utf8'));
  assert.equal(raw.question.metaData.name, 'wallsAndGates');
  assert.equal((await cache.getContent('public')).content.metaData.name, 'wallsAndGates');
  assert.equal(ncCalls, 1);
  for (const fallback of [null, await parsed('the-earliest-moment-when-everyone-become-friends')]) {
    cache.neetcode = { get: async () => fallback, read: async () => fallback };
    cache.premiumCache = { getStatement: async () => ({ descriptionHtml: 'Fallback', stub: 'old stub', examples: [], statementSource: { url: 'mirror' } }) };
    const result = (await cache.getContent('walls-and-gates')).content;
    assert.equal(result.descriptionHtml, 'Fallback');
    assert.equal(result.codeSnippets[0].code, 'old stub');
  }
});

test('real Python driver converts Interval pairs and judges against NeetCode outputs', async () => {
  const d = neetcodeDefinition(await parsed('meeting-schedule'));
  const result = await runCode({ ...d, slug: 'meeting-rooms', code: 'class Solution:\n    def canAttendMeetings(self, intervals: List[Interval]) -> bool:\n        intervals.sort(key=lambda i: i.start)\n        return all(a.end <= b.start for a, b in zip(intervals, intervals[1:]))\n' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.cases.map(c => c.actual), ['false', 'true']);
  assert.ok(result.cases.every(c => c.passed === true));
});

test('real Python driver uses one Solution instance for NeetCode encode/decode', async () => {
  const d = neetcodeDefinition(await parsed('string-encode-and-decode'));
  const result = await runCode({ ...d, slug: 'encode-and-decode-strings', code: 'class Solution:\n    def encode(self, strs):\n        self.value = strs\n        return "encoded"\n    def decode(self, s):\n        return self.value\n' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.cases.map(c => c.actual), ['["Hello","World"]', '[""]']);
  assert.ok(result.cases.every(c => c.passed === true));
});

test('workspace returns NeetCode Reset stub and never rewrites existing learner code', async t => {
  const { routes } = await import('./workspace/routes.mjs');
  const homeRoot = await temp(t);
  const definition = neetcodeDefinition(await parsed('foreign-dictionary'));
  const ctx = { homeRoot, params: { slug: 'alien-dictionary' }, leetcode: { getContent: async () => ({ content: definition }) } };
  let response;
  const res = { writeHead() {}, end(body) { response = JSON.parse(body); } };
  const getCode = routes['GET /api/problems/:slug/code'];
  await getCode({}, res, ctx);
  assert.equal(response.code, definition.codeSnippets[0].code);
  const file = path.join(homeRoot, 'problems/alien-dictionary/solution.py');
  await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const existing = 'class Solution:\n    def alienOrder(self, words):\n        return "mine"\n';
  await fsp.writeFile(file, existing);
  await getCode({}, res, ctx);
  assert.equal(response.code, existing);
  assert.equal(response.stub, definition.codeSnippets[0].code);
  assert.equal(await fsp.readFile(file, 'utf8'), existing);
});

test('timeout aborts the one request with no retry or cache write', async t => {
  let calls = 0;
  const cache = new NeetCodeContentCache({ cacheDir: await temp(t), timeoutMs: 10,
    fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
      calls++;
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    }),
  });
  assert.equal(await cache.get('valid-tree'), null);
  assert.equal(calls, 1);
  assert.deepEqual(await fsp.readdir(cache.cacheDir), []);
});

test('statement cleanup: TeX to text, pictures to links, hint and company blocks dropped', () => {
  const md = 'A $m \\times n$ grid, $1 \\le k$.\n\n![](https://example.test/p.png)\n\n<br>\n<details class="hint-accordion"><summary>Hint 1</summary>spoiler</details>';
  assert.equal(cleanStatement(md), 'A m × n grid, 1 ≤ k.\n\n[Picture on NeetCode](https://example.test/p.png)');
});

test('printed outputs are used only when every example has one and one answer is right', () => {
  const block = out => '```java\nInput: x = 1\n\nOutput: ' + out + '\n```\n';
  assert.deepEqual(statementOutputs(block('[\n  1, 2\n]') + block('true'), 2), ['[1,2]', 'true']);
  assert.equal(statementOutputs(block('1'), 2), null);
  assert.equal(statementOutputs(block('not json'), 1), null);
  assert.equal(statementOutputs('Return one possible order.\n' + block('"ab"'), 1), null);
  assert.equal(neetcodeExpectedHtml({ neetcodeExpected: ['"<a>"'] }), '<pre><strong>Output:</strong> "&lt;a&gt;"</pre>');
});
