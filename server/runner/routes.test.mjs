// The route table, exercised over a real socket the way the router will call it.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { routes, handleTestcases } from './routes.mjs';
import { HttpError, sendError } from '../http-util.mjs';

const META = {
  name: 'twoSum',
  params: [
    { name: 'nums', type: 'integer[]' },
    { name: 'target', type: 'integer' },
  ],
  return: { type: 'integer[]' },
};

const QUESTION = {
  metaData: JSON.stringify(META),
  exampleTestcases: '[2,7,11,15]\n9',
  content: '<pre><strong>Output:</strong> [0,1]\n</pre>',
};

/** A stand-in for the router the main agent owns: same dispatch, nothing more. */
function serve(ctx) {
  const server = http.createServer((req, res) => {
    const key = `${req.method} ${req.url.split('?')[0]}`;
    const handler = routes[key];
    if (!handler) return sendError(res, 404, 'NOT_FOUND', 'No such address.');
    Promise.resolve(handler(req, res, ctx)).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      return sendError(res, 500, 'INTERNAL_ERROR', 'Something went wrong.');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Call a handler directly and collect what it sent. No socket needed for a GET. */
async function call(handler, ctx) {
  let status = 0;
  let body = null;
  const res = {
    statusCode: 200,
    setHeader() {},
    writeHead(code) { status = code; return this; },
    end(payload) { body = payload ? JSON.parse(payload) : null; },
  };
  await handler({ method: 'GET', url: '/x', headers: {} }, res, ctx);
  return { status: status || res.statusCode, body };
}

async function post(server, path, body) {
  const { port } = server.address();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('the route table exports exactly the contracted routes and nothing else', () => {
  // Deliberately exhaustive. This module runs arbitrary code, so a route appearing
  // here by accident is the kind of mistake that has to fail a test, not pass review.
  assert.deepEqual(Object.keys(routes).sort(), [
    'GET /api/problems/:slug/testcases',
    'POST /api/run',
    'POST /api/run/cancel',
    'PUT /api/problems/:slug/testcases',
  ]);
  for (const fn of Object.values(routes)) assert.equal(typeof fn, 'function');
});

test('GET testcases returns the same cases a run would use, and executes nothing', async () => {
  const ctx = {
    params: { slug: 'two-sum' },
    leetcode: {
      getContent: async () => ({
        content: {
          metaData: JSON.stringify(META),
          exampleTestcases: '[2,7,11,15]\n9\n[3,2,4]\n6',
          descriptionHtml: '<pre><strong>Output:</strong> [0,1]\n</pre><pre><strong>Output:</strong> [1,2]\n</pre>',
        },
      }),
    },
  };
  const { status, body } = await call(handleTestcases, ctx);
  assert.equal(status, 200);
  assert.deepEqual(body.cases.map((c) => c.expected), ['[0,1]', '[1,2]']);
  assert.match(body.cases[0].input, /2,7,11,15/);
});

test('GET testcases says why rather than inventing cases when content is missing', async () => {
  const { status, body } = await call(handleTestcases, { params: { slug: 'two-sum' } });
  assert.equal(status, 200);
  assert.deepEqual(body.cases, []);
  assert.match(body.reason, /not been opened/i);
});

test('POST /api/run drives a problem out of the LeetCode cache (no network)', async (t) => {
  let asked = 0;
  const ctx = {
    catalog: { get: (slug) => (slug === 'two-sum' ? { slug } : null) },
    leetcode: {
      getContent: async (slug) => {
        asked += 1;
        assert.equal(slug, 'two-sum');
        // Phase 1 as it stands today: metaData only on the raw question.
        return { content: { exampleTestcases: QUESTION.exampleTestcases, descriptionHtml: QUESTION.content }, question: QUESTION };
      },
    },
  };
  const server = await serve(ctx);
  t.after(() => server.close());

  const { status, body } = await post(server, '/api/run', {
    slug: 'two-sum',
    code: 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n',
  });
  assert.equal(status, 200);
  assert.equal(asked, 1);
  assert.equal(body.ok, true);
  assert.equal(body.summary.passed, 1);
  assert.ok(typeof body.runId === 'string' && body.runId.length > 0);
});

test('POST /api/run prefers content.metaData once Phase 1 returns it', async (t) => {
  const ctx = {
    leetcode: {
      getContent: async () => ({
        content: {
          metaData: META, // the amendment: already parsed to an object
          exampleTestcases: QUESTION.exampleTestcases,
          descriptionHtml: QUESTION.content,
        },
      }),
    },
  };
  const server = await serve(ctx);
  t.after(() => server.close());
  const { body } = await post(server, '/api/run', {
    slug: 'two-sum',
    code: 'class Solution:\n    def twoSum(self, nums, target):\n        return [0, 1]\n',
  });
  assert.equal(body.summary.passed, 1);
});

test('a slug that is not in the catalog is a 404 before anything is spawned', async (t) => {
  const server = await serve({ catalog: { get: () => null } });
  t.after(() => server.close());
  const { status, body } = await post(server, '/api/run', { slug: 'nope', code: 'x' });
  assert.equal(status, 404);
  assert.equal(body.error.code, 'PROBLEM_NOT_FOUND');
});

test('a problem that was never downloaded, with LeetCode unreachable, is a plain 503', async (t) => {
  const server = await serve({
    leetcode: {
      getContent: async () => {
        throw new Error('offline');
      },
    },
  });
  t.after(() => server.close());
  const { status, body } = await post(server, '/api/run', { slug: 'two-sum', code: 'x' });
  assert.equal(status, 503);
  assert.equal(body.error.code, 'LEETCODE_UNREACHABLE');
  assert.match(body.error.message, /open the problem once while online/i);
  assert.ok(!/stack|Error:/.test(body.error.message), 'the message is for a human');
});

test('a malformed body is a 400, not a 500', async (t) => {
  const server = await serve({});
  t.after(() => server.close());
  assert.equal((await post(server, '/api/run', '{oops')).status, 400);
  assert.equal((await post(server, '/api/run', { code: 'x' })).status, 400);
});

test('POST /api/run/cancel stops a run that is hanging', async (t) => {
  const ctx = {
    leetcode: {
      getContent: async () => ({ content: { metaData: META, exampleTestcases: '[2,7,11,15]\n9', descriptionHtml: '' } }),
    },
  };
  const server = await serve(ctx);
  t.after(() => server.close());

  const running = post(server, '/api/run', {
    slug: 'two-sum',
    runId: 'test-run-1',
    timeoutMs: 30000,
    code: 'class Solution:\n    def twoSum(self, nums, target):\n        while True:\n            pass\n',
  });
  await new Promise((r) => setTimeout(r, 800));
  const cancel = await post(server, '/api/run/cancel', { runId: 'test-run-1' });
  assert.equal(cancel.body.cancelled, 1);

  const { body } = await running;
  assert.equal(body.ok, false);
  assert.equal(body.error.kind, 'cancelled');
});

test('cancelling nothing is fine', async (t) => {
  const server = await serve({});
  t.after(() => server.close());
  const { status, body } = await post(server, '/api/run/cancel', { runId: 'ghost' });
  assert.equal(status, 200);
  assert.equal(body.cancelled, 0);
});
