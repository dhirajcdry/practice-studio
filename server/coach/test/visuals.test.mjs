import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { routes } from '../routes.mjs';
import { VisualService, ImageQueue, generateImage, visualId, imageKind, QUEUE_FULL, MAX_IMAGE_BYTES } from '../visuals.mjs';
import { MCP_STARTED, MCP_UNCONFIRMED } from '../codex-cli.mjs';
import { HttpError, sendError } from '../../http-util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CODEX = path.join(HERE, 'bin', 'fake-codex.mjs');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const quiet = { info() {}, warn() {}, error() {} };

// ------------------------------------------------------------------ the image job itself

/** An in-process app-server whose turn ends however `turn(emit)` says. */
function fakeCodex({ turn, mcpNames = [], mcpError = false, mcpStarts = false } = {}) {
  const requests = []; let child, args, opts;
  const emit = message => child.stdout.write(JSON.stringify(message) + '\n');
  const spawnFn = (_binary, argv, options) => {
    args = argv; opts = options;
    child = new EventEmitter(); child.exitCode = null;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { if (child.exitCode !== null) return; child.exitCode = 0; setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit('close', 0); }); };
    child.stdin.on('data', chunk => {
      for (const line of String(chunk).trim().split('\n')) {
        const m = JSON.parse(line); requests.push(m);
        if (!m.method || !m.id) continue;
        setImmediate(() => {
          if (child.exitCode !== null) return;
          if (m.method === 'mcpServerStatus/list' && mcpError) return emit({ id: m.id, error: { message: 'Method not found' } });
          if (m.method === 'thread/start' && mcpStarts) emit({ method: 'mcpServer/startupStatus/updated', params: { name: 'node_repl', status: 'ready' } });
          const result = m.method === 'account/read' ? { account: { type: 'chatgpt' } }
            : m.method === 'mcpServerStatus/list' ? { data: mcpNames.map(name => ({ name })), nextCursor: null }
            : m.method === 'thread/start' ? { thread: { id: 'thread' } }
            : m.method === 'turn/start' ? { turn: { id: 'turn' } } : {};
          emit({ id: m.id, result });
          if (m.method === 'turn/start') turn(params => emit({ method: params.method, params: { threadId: 'thread', ...params.params } }));
        });
      }
    });
    return child;
  };
  return { spawnFn, requests, get args() { return args; }, get options() { return opts; }, get child() { return child; } };
}
const drawn = (result, extra = {}) => emit => {
  emit({ method: 'item/started', params: { item: { type: 'imageGeneration', status: 'in_progress', result: '' } } });
  emit({ method: 'item/completed', params: { item: { type: 'imageGeneration', id: 'ig', status: 'completed', result, revisedPrompt: 'revised', failure: null, ...extra } } });
  emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
};

test('a drawn picture comes back as checked bytes from a locked-down, image-only thread', async () => {
  const f = fakeCodex({ turn: drawn(PNG.toString('base64')), mcpNames: ['playwright', 'node_repl'] });
  const picture = await generateImage({ prompt: 'a red kite', model: 'gpt-6-astra', spawnFn: f.spawnFn, env: { OPENAI_API_KEY: 'sk-nope' } });
  assert.equal(picture.ext, 'png'); assert.ok(picture.bytes.equals(PNG)); assert.equal(picture.revisedPrompt, 'revised');
  assert.equal(typeof picture.ms, 'number');
  const argv = f.args.join(' ');
  assert.ok(argv.includes('--enable image_generation') && !argv.includes('--disable image_generation'));
  assert.ok(argv.includes('--disable shell_tool'));
  assert.equal(f.options.env.OPENAI_API_KEY, undefined);
  const thread = f.requests.find(r => r.method === 'thread/start').params;
  assert.equal(thread.ephemeral, true); assert.equal(thread.sandbox, 'read-only'); assert.equal(thread.approvalPolicy, 'never');
  assert.deepEqual(thread.config.mcp_servers, { playwright: { enabled: false }, node_repl: { enabled: false } });
  assert.match(thread.baseInstructions, /illustrator/);
  const text = f.requests.find(r => r.method === 'turn/start').params.input[0].text;
  const fence = text.match(/<<<(STUDIO-DATA-[A-F0-9]+) /)[1];
  assert.ok(text.includes(`<<<${fence} PICTURE DESCRIPTION\na red kite\n${fence}>>>`));
  assert.match(text, /flat, editorial/);
  assert.equal(f.child.exitCode, 0); assert.equal(fs.existsSync(f.options.cwd), false);
});

test('the job refuses what is not a picture, and says why when Codex would not draw', async () => {
  const cases = [
    [drawn(Buffer.from('<svg>not really a picture</svg>').toString('base64')), /not a picture/],
    [drawn('', { failure: { type: 'usageLimitExceeded', limitId: 'x', resetsAt: 1_900_000_000 } }), /Codex image limit reached; it resets .+2030/],
    [drawn('', { failure: { type: 'usageLimitExceeded', resetsAt: null } }), /: Codex image limit reached\.$/],
    [emit => emit({ method: 'turn/completed', params: { turn: { status: 'completed' } } }), /: Codex finished without drawing a picture\.$/],
    [emit => emit({ method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'session limit reached' } } } }), /session limit reached/],
  ];
  for (const [turn, message] of cases) {
    const f = fakeCodex({ turn });
    await assert.rejects(generateImage({ prompt: 'p', spawnFn: f.spawnFn }), message);
    assert.equal(f.child.exitCode, 0);
  }
  const huge = 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 8);
  await assert.rejects(generateImage({ prompt: 'p', spawnFn: fakeCodex({ turn: drawn(huge) }).spawnFn }), /larger than Studio keeps/);
});

test('the image job fails closed on the same tool-server checks as the chat coach', async () => {
  const unlisted = fakeCodex({ turn: drawn(PNG.toString('base64')), mcpError: true });
  await assert.rejects(generateImage({ prompt: 'p', spawnFn: unlisted.spawnFn }), new RegExp(MCP_UNCONFIRMED.replace(/[.;]/g, '.')));
  assert.ok(!unlisted.requests.some(r => r.method === 'thread/start'));
  const started = fakeCodex({ turn: drawn(PNG.toString('base64')), mcpStarts: true });
  await assert.rejects(generateImage({ prompt: 'p', spawnFn: started.spawnFn }), error => error.message === MCP_STARTED);
  assert.ok(!started.requests.some(r => r.method === 'turn/start'));
});

test('ids hash the trimmed prompt, and the bytes decide the extension', () => {
  const expected = crypto.createHash('sha256').update('two-sum\na red kite').digest('hex').slice(0, 20);
  assert.equal(visualId('two-sum', '  a red kite  '), expected);
  assert.equal(imageKind(PNG), 'png');
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'jpg');
  assert.equal(imageKind(Buffer.from('RIFF\0\0\0\0WEBPVP8 ', 'latin1')), 'webp');
  assert.equal(imageKind(Buffer.from('<svg onload=x>', 'latin1')), null);
});

// ------------------------------------------------------------------ over HTTP

/** The route table behind a router that matches 'METHOD /path/:param' as app.mjs does. */
async function serve(t, ctx) {
  const server = http.createServer((req, res) => {
    const segments = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean);
    let handler, params = {};
    for (const [key, h] of Object.entries(routes)) {
      const [method, route] = key.split(' ');
      const pattern = route.split('/').filter(Boolean);
      if (method !== req.method || pattern.length !== segments.length) continue;
      const p = {};
      if (pattern.every((part, i) => part.startsWith(':') ? ((p[part.slice(1)] = decodeURIComponent(segments[i])), true) : part === segments[i])) { handler = h; params = p; break; }
    }
    if (!handler) return sendError(res, 404, 'NOT_FOUND', 'no such route');
    Promise.resolve(handler(req, res, { ...ctx, params })).catch(err => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', String(err));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    post: async body => { const r = await fetch(base + '/api/coach/visuals', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, json: await r.json() }; },
    get: async route => { const r = await fetch(base + route); return { status: r.status, json: await r.json().catch(() => null) }; },
  };
}

async function tempRoot(t) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-visuals-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  return root;
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** A generator the test finishes by hand, so queue and dedupe states can be observed. */
function manualGenerate() {
  const calls = [];
  const generate = options => new Promise((resolve, reject) => calls.push({ options, resolve, reject }));
  const draw = (i = calls.length - 1) => calls[i].resolve({ bytes: PNG, ext: 'png', revisedPrompt: 'r', ms: 5 });
  return { calls, generate, draw };
}

test('end to end with the fake Codex: one spawn for two asks, stored, served with the right headers', async t => {
  const root = await tempRoot(t);
  let spawns = 0;
  const visuals = new VisualService({
    root, binary: CODEX, log: quiet, queue: new ImageQueue(),
    env: { ...process.env, FAKE_CODEX_IMAGE: '1' },
    spawnFn: (...a) => { spawns += 1; return spawn(...a); },
  });
  const api = await serve(t, { visuals });
  const ask = { slug: 'two-sum', prompt: '  a red kite  ', alt: 'A kite' };
  const first = await api.post(ask);
  const second = await api.post(ask);
  const id = visualId('two-sum', 'a red kite');
  assert.equal(first.status, 200);
  assert.deepEqual([first.json.id, second.json.id], [id, id]);
  assert.ok(['queued', 'drawing'].includes(first.json.status));
  const ready = await until(async () => { const r = await api.get(`/api/coach/visuals/two-sum/${id}`); return r.json.status === 'ready' && r.json; });
  assert.equal(spawns, 1);
  assert.deepEqual({ ...ready, elapsedMs: 0 }, { id, status: 'ready', url: `/api/coach/visuals/two-sum/${id}/image`, alt: 'A kite', elapsedMs: 0 });

  const dir = path.join(root, 'problems', 'two-sum', 'visuals');
  assert.deepEqual((await fsp.readdir(dir)).sort(), [`${id}.json`, `${id}.png`]);
  const meta = JSON.parse(await fsp.readFile(path.join(dir, `${id}.json`), 'utf8'));
  assert.equal(meta.prompt, 'a red kite'); assert.equal(meta.ext, 'png'); assert.equal(meta.model, 'gpt-6-astra');
  assert.equal(meta.revisedPrompt, 'A fixture picture.'); assert.equal(meta.slug, 'two-sum');

  const image = await fetch(api.base + ready.url);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal(image.headers.get('content-length'), String(PNG.length));
  assert.equal(image.headers.get('cache-control'), 'private, max-age=31536000, immutable');
  assert.equal(image.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await image.arrayBuffer()).equals(PNG));

  // Already on disk: answered ready, nothing spawned.
  assert.equal((await api.post(ask)).json.status, 'ready');
  assert.equal(spawns, 1);
});

test('a failure is remembered and not retried until asked; retry draws again', async t => {
  const root = await tempRoot(t);
  const m = manualGenerate();
  const visuals = new VisualService({ root, log: quiet, queue: new ImageQueue(), generate: m.generate });
  const api = await serve(t, { visuals });
  const ask = { slug: 'two-sum', prompt: 'a kite' };
  const { json: queued } = await api.post(ask);
  await until(() => m.calls.length === 1);
  assert.equal((await api.get(`/api/coach/visuals/two-sum/${queued.id}`)).json.status, 'drawing');
  m.calls[0].reject(new Error('Codex image limit reached.'));
  const failed = await until(async () => { const r = await api.get(`/api/coach/visuals/two-sum/${queued.id}`); return r.json.status === 'failed' && r.json; });
  assert.equal(failed.message, 'Codex image limit reached.');

  const again = await api.post(ask);
  assert.deepEqual([again.json.status, again.json.message], ['failed', 'Codex image limit reached.']);
  assert.equal(m.calls.length, 1);

  const retried = await api.post({ ...ask, retry: true });
  assert.ok(['queued', 'drawing'].includes(retried.json.status));
  await until(() => m.calls.length === 2);
  m.draw(1);
  await until(async () => (await api.get(`/api/coach/visuals/two-sum/${queued.id}`)).json.status === 'ready');
});

test('one picture at a time; a full line is turned away without being remembered as a failure', async t => {
  const root = await tempRoot(t);
  const m = manualGenerate();
  const visuals = new VisualService({ root, log: quiet, queue: new ImageQueue({ maxWaiting: 4 }), generate: m.generate });
  const api = await serve(t, { visuals });
  const answers = [];
  for (let i = 0; i < 5; i += 1) answers.push((await api.post({ slug: 'two-sum', prompt: `picture ${i}` })).json);
  await until(() => m.calls.length === 1);
  assert.deepEqual(answers.map(a => a.status), ['queued', 'queued', 'queued', 'queued', 'queued']);
  assert.equal(m.calls.length, 1, 'only one drawing at a time');
  // One drawing plus four waiting: the sixth is refused.
  const full = (await api.post({ slug: 'two-sum', prompt: 'picture 5' })).json;
  assert.deepEqual([full.status, full.message], ['failed', QUEUE_FULL]);
  assert.equal((await api.get(`/api/coach/visuals/two-sum/${full.id}`)).json.status, 'missing');

  m.draw(0);
  await until(() => m.calls.length === 2);
  assert.equal((await api.post({ slug: 'two-sum', prompt: 'picture 5' })).json.status, 'queued');
});

test('GET reports and serves but never starts work; bad input and traversal are refused', async t => {
  const root = await tempRoot(t);
  const m = manualGenerate();
  const visuals = new VisualService({ root, log: quiet, queue: new ImageQueue(), generate: m.generate });
  const api = await serve(t, { visuals });
  const id = visualId('two-sum', 'never asked');
  assert.deepEqual((await api.get(`/api/coach/visuals/two-sum/${id}`)), { status: 200, json: { id, status: 'missing', alt: '' } });
  assert.equal((await api.get(`/api/coach/visuals/two-sum/${id}/image`)).status, 404);
  assert.equal(m.calls.length, 0);

  for (const body of [{ prompt: 'x' }, { slug: '../etc', prompt: 'x' }, { slug: 'two-sum' }, { slug: 'two-sum', prompt: '   ' },
    { slug: 'two-sum', prompt: 'x'.repeat(2001) }, { slug: 'two-sum', prompt: 'x', alt: 'a'.repeat(301) }, { slug: 'two-sum', prompt: 'x', alt: 7 }]) {
    assert.equal((await api.post(body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  assert.equal((await api.post({ slug: 'two-sum', prompt: 'x'.repeat(2000) })).status, 200);

  // A file planted outside the visuals folder must not be reachable by any spelling.
  await fsp.writeFile(path.join(root, 'secret.json'), JSON.stringify({ ext: 'png' }));
  await fsp.writeFile(path.join(root, 'secret.png'), PNG);
  for (const route of [
    '/api/coach/visuals/two-sum/..%2F..%2F..%2Fsecret/image',
    '/api/coach/visuals/..%2F..%2F/aaaaaaaaaaaaaaaaaaaa/image',
    `/api/coach/visuals/two-sum/${id.toUpperCase()}`,
    `/api/coach/visuals/two-sum/${id}0`,
    '/api/coach/visuals/two-sum/..%2Fsecret',
  ]) {
    assert.equal((await api.get(route)).status, 400, route);
  }
});
