// The runner's route table. The main agent wires this into the router; nothing here
// touches server/app.mjs or server/index.mjs.
//
//   import { routes as runnerRoutes } from './runner/routes.mjs';
//
// Handlers are `(req, res, ctx)`. From `ctx` this module uses:
//   ctx.catalog   — optional; when present, an unknown slug is a 404 before anything runs
//   ctx.leetcode  — the LeetCodeContentCache, for metaData + description (cache-first,
//                   so this works with the network down once a problem has been opened)
// and nothing else. Both are optional in the sense that a caller can instead pass
// `metaData` / `descriptionHtml` in the request body (that is how the tests drive it).

import { HttpError, sendJson } from '../http-util.mjs';
import { parseMetaData, classifyProblem } from './meta.mjs';
import { createRunControl, runCode, DEFAULT_TIMEOUT_MS } from './run.mjs';
import { buildCases } from './testcases.mjs';
import { readCases, writeCases, linesPerCase, whyNotRunnable } from './cases.mjs';

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/** Runs currently in flight, so POST /api/run/cancel has something to kill. */
const active = new Map(); // id -> { control, slug }

let seq = 0;
function nextRunId() {
  seq += 1;
  return `run-${Date.now().toString(36)}-${seq}`;
}

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'BODY_TOO_LARGE', 'That request was too large to read.');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'That request body could not be read as JSON.');
  }
}

/** metaData + description, cache-first. Returns null when we truly cannot get them. */
async function loadProblemContext(ctx, slug, body) {
  const fromBody = parseMetaData(body.metaData);
  if (fromBody) {
    return {
      metaData: fromBody,
      exampleTestcases: body.exampleTestcases ?? null,
      descriptionHtml: body.descriptionHtml ?? null,
      pythonStub: typeof body.pythonStub === 'string' ? body.pythonStub : null,
    };
  }
  if (!ctx?.leetcode?.getContent) return null;

  let result;
  try {
    result = await ctx.leetcode.getContent(slug);
  } catch {
    return null;
  }
  const content = result?.content ?? null;
  // `content.metaData` is the contract's Phase 1 amendment. Until it lands, the raw
  // question object carries the same string, so the runner works either way.
  const metaData = parseMetaData(content?.metaData ?? result?.question?.metaData);
  if (!metaData) return null;
  return {
    metaData,
    exampleTestcases: content?.exampleTestcases ?? result?.question?.exampleTestcases ?? null,
    descriptionHtml: content?.descriptionHtml ?? result?.question?.content ?? null,
    // LeetCode's own python3 starter. Used only to settle what `manual` means for this
    // problem — see stub.mjs.
    pythonStub: pythonSnippetOf(result?.question?.codeSnippets ?? content?.codeSnippets),
  };
}

function pythonSnippetOf(snippets) {
  if (!Array.isArray(snippets)) return null;
  const hit = snippets.find((s) => s?.langSlug === 'python3') ?? snippets.find((s) => s?.langSlug === 'python');
  return typeof hit?.code === 'string' ? hit.code : null;
}

export async function handleRun(req, res, ctx = {}) {
  const body = await readJsonBody(req);
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (slug === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That run request did not say which problem it was for.');
  }
  if (ctx.catalog?.get && !ctx.catalog.get(slug)) {
    throw new HttpError(404, 'PROBLEM_NOT_FOUND', `"${slug}" is not in the NeetCode 250.`);
  }
  if (typeof body.code !== 'string') {
    throw new HttpError(400, 'BAD_REQUEST', 'That run request did not include any code.');
  }

  const problem = await loadProblemContext(ctx, slug, body);
  if (problem === null) {
    throw new HttpError(
      503,
      'LEETCODE_UNREACHABLE',
      'This problem has not been downloaded yet and LeetCode could not be reached, so there is nothing to run against. Open the problem once while online and local runs will work offline after that.',
    );
  }

  const timeoutMs = clampTimeout(body.timeoutMs);
  const runId = typeof body.runId === 'string' && body.runId !== '' ? body.runId : nextRunId();
  const control = createRunControl();
  active.set(runId, { control, slug });

  let result;
  try {
    result = await runCode({
      code: body.code,
      slug,
      metaData: problem.metaData,
      testcases: typeof body.testcases === 'string' ? body.testcases : undefined,
      // Aligned to the cases in `testcases`. Present when the browser is running a list
      // it assembled itself — examples plus whatever you added.
      expectedOverrides: Array.isArray(body.expected) ? body.expected : undefined,
      exampleTestcases: problem.exampleTestcases,
      descriptionHtml: problem.descriptionHtml,
      pythonStub: problem.pythonStub,
      timeoutMs,
      control,
    });
  } finally {
    active.delete(runId);
  }

  return sendJson(res, 200, { runId, ...result });
}

export async function handleCancel(req, res) {
  const body = await readJsonBody(req);
  let cancelled = 0;
  for (const [id, entry] of active) {
    const match =
      (typeof body.runId === 'string' && body.runId === id) ||
      (typeof body.slug === 'string' && body.slug === entry.slug) ||
      (body.runId === undefined && body.slug === undefined);
    if (match) {
      entry.control.cancel();
      cancelled += 1;
    }
  }
  return sendJson(res, 200, { ok: true, cancelled });
}

function clampTimeout(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(30000, Math.max(500, Math.round(value)));
}

/**
 * GET /api/problems/:slug/testcases — the cases a local run will use, without running.
 *
 * Deliberately the same `buildCases` the runner calls, from the same content. Parsing
 * them a second time for display would let the panel show cases that differ from the
 * ones actually executed, which is worse than showing nothing.
 */
export async function handleTestcases(req, res, ctx) {
  const slug = requireSlug(ctx);

  const problem = await loadProblemContext(ctx, slug, {});
  if (!problem) {
    return sendJson(res, 200, {
      cases: [],
      extra: [],
      runnable: false,
      reason: 'The problem has not been opened yet, so its examples are not cached.',
    });
  }

  const shape = classifyProblem(problem.metaData, { pythonStub: problem.pythonStub, slug });
  if (shape.kind === 'unsupported') {
    // `runnable: false` so the editor states the reason and stops there. Offering to add a
    // case for a problem the runner cannot drive is an invitation to type one out and then
    // be told, on Run, that it was never going to work.
    return sendJson(res, 200, { cases: [], extra: [], runnable: false, reason: shape.message });
  }

  const perCase = linesPerCase(shape);
  const built = buildCases({
    perCase,
    testcases: problem.exampleTestcases,
    descriptionHtml: problem.descriptionHtml,
    // So the Expected box shows the same value the run will compare against, rather than
    // LeetCode's prose form of it.
    prefixExpected: shape.answerFrom?.sizeFromReturn === true,
  });
  const examples = built.ok
    ? built.cases.map((c, index) => ({
      index,
      input: c.input ?? null,
      // Absent rather than guessed: LeetCode publishes expected outputs only inside the
      // description prose, and some problems simply do not have one to scrape.
      expected: c.expected ?? null,
      source: 'example',
    }))
    : [];

  const mine = ctx?.homeRoot ? await readCases({ root: ctx.homeRoot, slug }) : [];

  return sendJson(res, 200, {
    cases: examples,
    extra: mine,
    runnable: true,
    // The parameter names, so the editor can label the boxes the way the signature does
    // instead of calling them "line 1" and "line 2".
    params: shape.kind === 'design' ? ['calls', 'arguments'] : shape.params.map((p) => p.name ?? p),
    perCase,
    ...(built.ok ? {} : { reason: built.message }),
  });
}

/**
 * PUT /api/problems/:slug/testcases — replace the cases you added.
 *
 * Whole-list replacement, not append: the editor holds the list, and a partial API would
 * mean two ideas of what the list is. The examples are never touched by this.
 */
export async function handleSaveTestcases(req, res, ctx) {
  const slug = requireSlug(ctx);
  const root = ctx?.homeRoot;
  if (!root) throw new HttpError(503, 'NO_WORKSPACE', 'There is no workspace to save test cases into.');

  const body = await readJsonBody(req);
  const wanted = Array.isArray(body.cases) ? body.cases : [];

  // Refused where it was typed, with the reason, rather than accepted here and failed
  // later as a confusing grouping error across the whole run.
  const problem = await loadProblemContext(ctx, slug, body);
  if (problem) {
    const shape = classifyProblem(problem.metaData, { pythonStub: problem.pythonStub, slug });
    if (shape.kind !== 'unsupported') {
      const perCase = linesPerCase(shape);
      for (const [i, c] of wanted.entries()) {
        const why = whyNotRunnable(c?.input ?? '', perCase);
        if (why) throw new HttpError(400, 'BAD_TESTCASE', `Case ${i + 1}: ${why}`);
      }
    }
  }

  const saved = await writeCases({ root, slug, cases: wanted });
  return sendJson(res, 200, { cases: saved });
}

function requireSlug(ctx) {
  const slug = ctx?.params?.slug;
  if (typeof slug !== 'string' || slug === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That problem address could not be understood.');
  }
  return slug;
}

export const routes = {
  'POST /api/run': handleRun,
  'POST /api/run/cancel': handleCancel,
  'GET /api/problems/:slug/testcases': handleTestcases,
  'PUT /api/problems/:slug/testcases': handleSaveTestcases,
};

export default routes;
