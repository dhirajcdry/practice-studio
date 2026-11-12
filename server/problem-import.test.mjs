import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { disciplineForSlug, problemDir } from './storage-layout.mjs';
import { Catalog, loadCatalog } from './catalog.mjs';
import { problemImportRoutes, parseProblemUrl } from './problem-import.mjs';

const store = { hasLanguage: () => false, hasArticle: () => false };
const base = { source: {}, problems: [{ leetcodeSlug: 'two-sum', title: 'Two Sum', lists: { neetcode250: true }, pattern: 'Arrays' }] };
function req(data) { return Readable.from([JSON.stringify(data)]); }
function response() { return { status: 0, body: '', writeHead(s) { this.status = s; }, end(b) { this.body = JSON.parse(b); } }; }
function ctx(root, leetcode) { return { homeRoot: root, solutions: store, catalog: new Catalog(base, store), leetcode }; }
const content = (slug, metaData = { name: 'solve', params: [], return: { type: 'integer' } }) => ({ question: { title: slug, questionFrontendId: '99', difficulty: 'Easy', isPaidOnly: false }, content: { title: slug, metaData, codeSnippets: [{ langSlug: 'python3', code: 'def solve(x):\n    return x' }] } });

test('parseProblemUrl accepts only canonical LeetCode problem paths', () => {
  assert.equal(parseProblemUrl('https://leetcode.com/problems/two-sum/description/'), 'two-sum');
  assert.equal(parseProblemUrl('http://www.leetcode.com/problems/a1/'), 'a1');
  for (const url of ['https://evil.test/problems/x', 'https://leetcode.com/contest/x', 'https://leetcode.com/problems/a_b/']) {
    assert.throws(() => parseProblemUrl(url), /LeetCode|valid|address|URL/);
  }
});

test('preview returns fetched metadata but does not mutate catalog or storage', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const routes = problemImportRoutes({ addedFile: path.join(root, 'added-problems.json') });
  const c = ctx(root, { getContent: async () => content('new-problem') }); const res = response();
  await routes['POST /api/problems/import/preview'](req({ url: 'https://leetcode.com/problems/new-problem/' }), res, c);
  assert.equal(res.status, 200); assert.equal(res.body.existing, false); assert.equal(res.body.slug, 'new-problem');
  assert.equal(c.catalog.get('new-problem'), null); await assert.rejects(fs.access(path.join(root, 'added-problems.json')));
});

test('import persists, duplicate is idempotent, and reload restores entry', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-')); const file = path.join(root, 'added-problems.json');
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const routes = problemImportRoutes({ addedFile: file }); const c = ctx(root, { getContent: async () => content('new-problem') });
  let res = response(); await routes['POST /api/problems/import'](req({ url: 'https://leetcode.com/problems/new-problem/' }), res, c);
  assert.equal(res.body.existing, false); assert.equal(c.catalog.get('new-problem').lists.added, true);
  res = response(); await routes['POST /api/problems/import'](req({ url: 'https://leetcode.com/problems/new-problem/' }), res, c); assert.equal(res.body.existing, true);
  const loaded = loadCatalog(path.resolve('data/catalog.json'), store, null, file); assert.equal(loaded.get('new-problem').lists.added, true);
});

test('import accepts slugs, labels others, and rejects invalid sources', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-')); const file = path.join(root, 'added-problems.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routes = problemImportRoutes({ addedFile: file });
  const c = ctx(root, { getContent: async slug => content(slug) });
  const other = response();
  await routes['POST /api/problems/import'](req({ slug: 'other-problem', source: 'others' }), other, c);
  assert.equal(other.body.entry.lists.others, true); assert.equal(other.body.entry.lists.added, undefined);
  const you = response();
  await routes['POST /api/problems/import'](req({ slug: 'your-problem' }), you, c);
  assert.equal(you.body.entry.lists.added, true);
  const saved = JSON.parse(await fs.readFile(file));
  assert.deepEqual(saved.map(item => item.lists), [{ others: true }, { added: true }]);
  for (const source of ['curated', '', null, 1, {}]) {
    await assert.rejects(routes['POST /api/problems/import'](req({ slug: 'bad-source', source }), response(), c), { status: 400 });
  }
});

test('existing curated, You, and Others entries are not rewritten', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-')); const file = path.join(root, 'added-problems.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routes = problemImportRoutes({ addedFile: file });
  const catalog = new Catalog({ source: {}, problems: [
    { leetcodeSlug: 'curated', title: 'Curated', lists: { neetcode250: true } },
    { leetcodeSlug: 'you-entry', title: 'You', lists: { added: true } },
    { leetcodeSlug: 'others-entry', title: 'Others', lists: { others: true } },
  ] }, store);
  const c = { ...ctx(root, { getContent: async slug => content(slug) }), catalog };
  const original = [{ leetcodeSlug: 'you-entry', title: 'You', lists: { added: true } }, { leetcodeSlug: 'others-entry', title: 'Others', lists: { others: true } }];
  await fs.writeFile(file, JSON.stringify(original));
  for (const [slug, source] of [['curated', 'others'], ['you-entry', 'others'], ['others-entry', 'you']]) {
    const res = response(); await routes['POST /api/problems/import'](req({ slug, source }), res, c);
    assert.equal(res.body.existing, true); assert.equal(Boolean(res.body.entry.lists.added), slug === 'you-entry'); assert.equal(Boolean(res.body.entry.lists.others), slug === 'others-entry');
  }
  assert.deepEqual(JSON.parse(await fs.readFile(file)), original);
});

test('same-slug source race keeps the first saved label', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-')); const file = path.join(root, 'added-problems.json');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const routes = problemImportRoutes({ addedFile: file });
  const c = ctx(root, { getContent: async slug => content(slug) });
  await Promise.all([
    routes['POST /api/problems/import'](req({ slug: 'raced', source: 'others' }), response(), c),
    routes['POST /api/problems/import'](req({ slug: 'raced', source: 'you' }), response(), c),
  ]);
  const saved = JSON.parse(await fs.readFile(file));
  assert.equal(saved.length, 1); assert.deepEqual(saved[0].lists, { others: true });
  assert.equal(c.catalog.get('raced').lists.others, true); assert.equal(c.catalog.get('raced').lists.added, undefined);
});

test('concurrent imports serialize without losing records and unsupported metadata is reported', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-')); const file = path.join(root, 'added-problems.json');
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const routes = problemImportRoutes({ addedFile: file });
  const c = ctx(root, { getContent: async (slug) => content(slug, { name: 'solve', params: [{ type: 'tree' }] }) });
  const results = await Promise.all(['one', 'two', 'three'].map((slug) => { const r = response(); return routes['POST /api/problems/import'](req({ url: `https://leetcode.com/problems/${slug}/` }), r, c).then(() => r); }));
  assert.equal(JSON.parse(await fs.readFile(file)).length, 3); assert.equal(results[0].body.entry.lists.added, true);
  const preview = response(); await routes['POST /api/problems/import/preview'](req({ url: 'https://leetcode.com/problems/unsupported/' }), preview, c);
  assert.equal(preview.body.runner.supported, false); assert.match(preview.body.runner.message, /cannot build|supported|type/i);
});


test('unknown and challenged problems never create catalog entries', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'added-problems.json');
  const routes = problemImportRoutes({ addedFile: file });
  for (const kind of ['unknown-slug', 'challenged']) {
    const c = ctx(root, { getContent: async () => { throw Object.assign(new Error('Unavailable'), { kind }); } });
    await assert.rejects(routes['POST /api/problems/import'](req({url:'https://leetcode.com/problems/missing/'}), response(), c), {status:kind==='unknown-slug'?404:503});
    assert.equal(c.catalog.get('missing'), null);
    await assert.rejects(fs.access(file));
  }
});

test('failed writes do not poison later explicit imports', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'added-problems.json');
  await fs.writeFile(file, 'broken');
  const routes = problemImportRoutes({ addedFile: file });
  const c = ctx(root, {getContent:async slug=>content(slug)});
  const call = () => routes['POST /api/problems/import'](req({url:'https://leetcode.com/problems/new-problem/'}), response(), c);
  await assert.rejects(call());
  assert.equal(c.catalog.get('new-problem'), null);
  await fs.rm(file);
  await call();
  assert.ok(c.catalog.get('new-problem'));
});


test('new design-prefixed LeetCode identities use coding storage without reclassifying saved topics', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const routes=problemImportRoutes({addedFile:path.join(root,'added-problems.json')});
  const c=ctx(root,{getContent:async slug=>content(slug)});
  await fs.mkdir(path.join(root,'tracks/design/problems/design-existing-topic'),{recursive:true});
  await assert.rejects(routes['POST /api/problems/import'](req({url:'https://leetcode.com/problems/design-existing-topic/'}),response(),c),{status:409});
  assert.equal(disciplineForSlug('design-existing-topic'),'design');
  await routes['POST /api/problems/import'](req({url:'https://leetcode.com/problems/design-import-fixture/'}),response(),c);
  assert.equal(disciplineForSlug('design-import-fixture'),'coding');
  assert.equal(problemDir(root,'design-import-fixture'),path.join(root,'tracks/coding/problems/design-import-fixture'));
});
