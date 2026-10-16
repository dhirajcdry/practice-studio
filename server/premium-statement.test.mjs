import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { PremiumStatementCache, parsePremiumStatement, solutionPath } from './premium-statement.mjs';
import { premiumCaseDescription } from './premium-cases.mjs';
import { LeetCodeContentCache } from './leetcode.mjs';
import { buildCases } from './runner/testcases.mjs';

const html = '<p>A tree &amp; graph.</p><pre>\n<strong>Input:</strong> n = 2, edges = [[0,1]]\n<strong>Output:</strong> true\n<strong>Explanation:</strong> Connected.\n</pre>';
const markdown = (code) => `# Title\n<!-- description:start -->\n${html}\n<!-- description:end -->\n## Solutions\n\n\`\`\`python\n${code}\n\`\`\``;
const md = markdown('class Solution:\n    def validTree(self, n: int, edges: List[List[int]]) -> bool:\n        def helper():\n            return 42\n        return True');
const entry = { leetcodeProblemNumber: 261, title: 'Graph Valid Tree', slug: 'graph-valid-tree' };
async function temp(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-premium-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('hundred ranges and encoded folder segments', () => {
  assert.equal(solutionPath(261, 'Graph Valid Tree'), '0200-0299/0261.Graph%20Valid%20Tree/README_EN.md');
  assert.equal(solutionPath(323, 'A/B'), '0300-0399/0323.A%2FB/README_EN.md');
  assert.equal(solutionPath(1101, 'Title'), '1100-1199/1101.Title/README_EN.md');
});

test('extracts only description HTML, examples, and direct method stubs', () => {
  const parsed = parsePremiumStatement(md);
  assert.equal(parsed.descriptionHtml, html);
  assert.deepEqual(parsed.examples, [{ input: 'n = 2, edges = [[0,1]]', output: 'true' }]);
  assert.equal(parsed.stub, 'class Solution:\n    def validTree(self, n: int, edges: List[List[int]]) -> bool:\n        pass');
  assert.equal(parsePremiumStatement('no markers'), null);
});

test('multiline typed signatures, decorators, inline bodies and Definition comments', () => {
  const prefix = '# Definition for a binary tree node.\n# class TreeNode:\n#     def __init__(self, val=0):\n#         self.val = val';
  const code = `${prefix}\nclass Solution:\n    @staticmethod\n    @decorator(\n        "x",\n    )\n    def solve(\n        root: Optional[TreeNode],\n        value: str = ":",\n    ) -> int:\n        def nested():\n            pass\n        return 1\n\n    def other(self): return 2`;
  assert.equal(parsePremiumStatement(markdown(code)).stub, `${prefix}\nclass Solution:\n    @staticmethod\n    @decorator(\n        "x",\n    )\n    def solve(\n        root: Optional[TreeNode],\n        value: str = ":",\n    ) -> int:\n        pass\n    def other(self):\n        pass`);
});

test('examples stay within each pre and decode text', () => {
  const sample = md.replace(html, '<pre class="example"><strong>Input:</strong> s = &quot;a&amp;b&quot;<strong>Output:</strong> &quot;b&quot;<strong>Explanation:</strong> done</pre><pre><strong>Output:</strong> 99</pre>');
  assert.deepEqual(parsePremiumStatement(sample).examples, [{ input: 's = "a&b"', output: '"b"' }]);
});

test('cache deduplicates requests and persists success', async t => {
  const dir = await temp(t); let calls = 0;
  const fetchImpl = async () => { calls++; return new Response(md); };
  const cache = new PremiumStatementCache({ cacheDir: dir, fetchImpl });
  const [a, b] = await Promise.all([cache.getStatement(entry), cache.getStatement(entry)]);
  assert.ok(a); assert.deepEqual(a, b); assert.equal(calls, 1);
  assert.deepEqual(await new PremiumStatementCache({ cacheDir: dir, fetchImpl }).getStatement(entry), a);
  assert.equal(calls, 1);
  assert.equal(a.statementSource.url, 'https://github.com/doocs/leetcode/blob/main/solution/0200-0299/0261.Graph%20Valid%20Tree/README_EN.md');
});

test('404 uses one contents lookup and retries the resolved directory', async t => {
  const calls = [];
  const cache = new PremiumStatementCache({ cacheDir: await temp(t), fetchImpl: async url => {
    calls.push(url);
    if (calls.length === 1) return new Response('', { status: 404 });
    if (calls.length === 2) return Response.json([{ name: '0261.Actual Title', type: 'dir', download_url: null }]);
    return new Response(md);
  } });
  const result = await cache.getStatement(entry);
  assert.ok(result); assert.equal(calls.length, 3);
  assert.equal(calls[1], 'https://api.github.com/repos/doocs/leetcode/contents/solution/0200-0299');
  assert.match(calls[2], /0261.Actual%20Title\/README_EN.md$/);
  assert.match(result.statementSource.url, /0261.Actual%20Title\/README_EN.md$/);
});

test('failure does not cache; non-404 does not retry; unwritable cache still serves', async t => {
  const dir = await temp(t); let calls = 0;
  const cache = new PremiumStatementCache({ cacheDir: dir, fetchImpl: async () => { calls++; return new Response('', { status: 429 }); } });
  assert.equal(await cache.getStatement(entry), null);
  assert.equal(await cache.getStatement(entry), null); assert.equal(calls, 2);
  const file = path.join(dir, 'file'); await fsp.writeFile(file, 'occupied');
  assert.ok(await new PremiumStatementCache({ cacheDir: file, fetchImpl: async () => new Response(md) }).getStatement(entry));
});

test('premium enrichment preserves existing snippets and skips public content', async t => {
  let calls = 0;
  const cache = new LeetCodeContentCache({ cacheDir: await temp(t), entryFor: () => entry,
    fetchQuestionImpl: async () => ({ isPaidOnly: true, content: null, codeSnippets: null }),
    premiumCache: { getStatement: async () => { calls++; return { ...parsePremiumStatement(md), statementSource: { name: 'doocs/leetcode' } }; } },
  });
  const { content } = await cache.getContent(entry.slug);
  assert.equal(content.descriptionHtml, html);
  assert.equal(content.codeSnippets[0].langSlug, 'python3');
  cache.fetchQuestionImpl = async () => ({ content: '<p>Public</p>', isPaidOnly: false });
  assert.equal((await cache.getContent('public')).content.descriptionHtml, '<p>Public</p>');
  assert.equal(calls, 1);
});

test('case outputs require exact input matches, including reordered examples', () => {
  const content = { metaData: { params: [{ name: 'n' }, { name: 'edges' }] }, exampleTestcases: '2\n[[0,1]]\n3\n[]', statementExamples: [{ input: 'n = 3, edges = []', output: 'false' }, ...parsePremiumStatement(md).examples] };
  const descriptionHtml = premiumCaseDescription(content);
  const result = buildCases({ perCase: 2, testcases: content.exampleTestcases, descriptionHtml });
  assert.deepEqual(result.cases.map(c => c.expectedValue), [true, false]);
  content.exampleTestcases = '4\n[]';
  assert.equal(premiumCaseDescription(content), '');
});

test('workspace offers the mirrored starter without overwriting a saved solution', async t => {
  const { routes } = await import('./workspace/routes.mjs');
  const homeRoot = await temp(t);
  const stub = parsePremiumStatement(md).stub;
  const ctx = { homeRoot, params: { slug: entry.slug }, leetcode: { getContent: async () => ({ content: { codeSnippets: [{ langSlug: 'python3', code: stub }] } }) } };
  let response;
  const res = { writeHead() {}, end(body) { response = JSON.parse(body); } };
  const getCode = routes['GET /api/problems/:slug/code'];
  await getCode({}, res, ctx);
  assert.equal(response.code, stub); assert.equal(response.isStub, true);
  const file = path.join(homeRoot, 'problems', entry.slug, 'solution.py');
  await assert.rejects(fsp.stat(file), { code: 'ENOENT' });
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, 'my existing solution');
  await getCode({}, res, ctx);
  assert.equal(response.code, 'my existing solution'); assert.equal(response.isStub, false);
  assert.equal(await fsp.readFile(file, 'utf8'), 'my existing solution');
});

test('failed fallback retry and thrown fetch both return null', async t => {
  let calls = 0;
  const cache = new PremiumStatementCache({ cacheDir: await temp(t), fetchImpl: async () => {
    calls++;
    if (calls === 1) return new Response('', { status: 404 });
    if (calls === 2) return Response.json([{ name: '0261.Title', type: 'dir' }]);
    return new Response('error', { status: 503 });
  } });
  assert.equal(await cache.getStatement(entry), null); assert.equal(calls, 3);
  cache.fetchImpl = async () => { throw new Error('offline'); };
  assert.equal(await cache.getStatement(entry), null);
});
