import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';

async function load(fetchImpl) {
  const source = await fsp.readFile(path.resolve('extension/background.js'), 'utf8');
  const context = { console, fetch: fetchImpl, location: { origin: 'https://leetcode.com' }, chrome: {
    runtime: { onConnect: { addListener() {} } }, cookies: {}, tabs: {}, scripting: {},
  }, setTimeout, clearTimeout, URL, AbortController, AbortSignal };
  vm.createContext(context);
  vm.runInContext(`${source}\nglobalThis.__pageDetails = pageDetails; globalThis.__pageDetails.fetchDetails = fetchDetails;`, context);
  return context.__pageDetails;
}

test('pageDetails performs exactly one GraphQL read and parses JSON distributions', async () => {
  let calls = 0;
  let query = '';
  const pageDetails = await load(async (_url, options) => { calls++; query = options.body; return { ok: true, async json() { return { data: { submissionDetails: { runtime: '23 ms', runtimeDistribution: JSON.stringify({ lang: 'python3', distribution: [['23', 4.51]] }) } } }; } }; });
  const result = await pageDetails('123', 'csrf');
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(result.details.runtimeDistribution), JSON.stringify({ lang: 'python3', distribution: [['23', 4.51]] }));
  assert.doesNotMatch(query, /fullCompileError|fullRuntimeError/);
});

test('unknown or malformed detail fields fail closed without retrying', async () => {
  let calls = 0;
  const pageDetails = await load(async () => { calls++; return { ok: true, async json() { return { data: { submissionDetails: { runtimeDistribution: '{bad json', unknown: '{bad json' } } }; } }; });
  const result = await pageDetails('123', 'csrf');
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
  assert.equal(result.details.runtimeDistribution, null);
  assert.equal(result.details.unknown, '{bad json');
});

test('GraphQL unknown-field errors return no details and never retry', async () => {
  let calls=0;
  const read=await load(async()=>{ calls++; return {ok:true,json:async()=>({errors:[{message:'Cannot query field fullCompileError'}]})}; });
  const result=await read('123','csrf');
  assert.equal(calls,1); assert.equal(result.ok,false); assert.equal(result.details,null); assert.match(result.detailsError,/Cannot query field/);
});


test('invalid details slug returns before any browser or network access', async () => {
  const page = await load(() => { throw new Error('Unexpected network access'); });
  const result = await page.fetchDetails({ submissionId: '123', slug: '../bad' });
  assert.equal(result.ok, false);
  assert.match(result.message, /problem name is invalid/);
  assert.doesNotMatch(result.message, /submitted/);
});
