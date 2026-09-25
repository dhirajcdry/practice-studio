// The user's working buffer: ~/LeetCodeTutor/problems/<slug>/solution.py
//
// This file is the one irreplaceable thing in Studio. Everything else — the catalog, the
// cached descriptions, the index — can be regenerated from scratch. Their code cannot.
// So: atomic writes only, never overwrite an existing buffer with a stub, and never write
// it from any path except an explicit PUT from the editor.

import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';

const MAX_CODE_BYTES = 1024 * 1024; // a solution file is never a megabyte; refuse the pathological case

// ctx.homeRoot / ctx.paths.HOME_ROOT — workspace root override, for tests. The same
// idiom the stats and coach routes use, so a test can point at a scratch workspace
// rather than at the one holding real work.
function rootOf(ctx) {
  return ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
}

function problemDir(ctx, slug) {
  return path.join(rootOf(ctx), 'problems', slug);
}

function solutionFile(ctx, slug) {
  return path.join(problemDir(ctx, slug), 'solution.py');
}

async function readJsonBody(req, limitBytes = MAX_CODE_BYTES + 4096) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      throw new HttpError(413, 'BAD_REQUEST', 'That file is larger than this editor accepts.');
    }
    chunks.push(chunk);
  }
  if (total === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'The request body was not valid JSON.');
  }
}

/** Write via temp file + rename so a crash mid-write cannot truncate their work. */
async function writeAtomic(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

/**
 * The Python stub from LeetCode's codeSnippets, so a fresh problem opens with a real
 * signature rather than an empty editor.
 */
function pythonStubFrom(content) {
  const snippets = content?.codeSnippets;
  if (!Array.isArray(snippets)) return null;
  const py = snippets.find((s) => s?.langSlug === 'python3') || snippets.find((s) => s?.langSlug === 'python');
  return typeof py?.code === 'string' && py.code.trim() ? py.code : null;
}

const GENERIC_STUB = 'class Solution:\n    def solve(self):\n        pass\n';

/**
 * How long this route will wait for a starting stub before giving up on it.
 *
 * The editor gives up on the whole request after 8s and falls back to keeping the buffer
 * in the browser — which is what "NOT SAVING TO DISK" means. A LeetCode fetch is allowed
 * 15s. So on a cache miss with no signal, the one route that carries the user's code lost
 * a race it should never have been in: their file was on disk, readable, and the response
 * was held up by a nicety.
 *
 * Two seconds is far longer than a disk read and far shorter than the browser's patience.
 * The fetch is not cancelled — it carries on and fills the cache, so the next open has it.
 */
const STARTER_BUDGET_MS = 2000;

/** LeetCode's starter for this problem. Cache-first, so this costs no network once the
 *  problem has been opened, and offline simply means the generic one. */
async function starterFor(ctx, slug, { budgetMs = STARTER_BUDGET_MS } = {}) {
  let timer = null;
  const giveUp = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), budgetMs);
    timer.unref?.();
  });
  try {
    const result = await Promise.race([
      ctx.leetcode.getContent(slug).catch(() => null),
      giveUp,
    ]);
    return result ? pythonStubFrom(result.content) : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function handleGetCode(req, res, ctx) {
  const slug = ctx.params.slug;
  const file = solutionFile(ctx, slug);

  try {
    const [text, stat] = await Promise.all([fs.readFile(file, 'utf8'), fs.stat(file)]);
    return sendJson(res, 200, {
      code: text,
      language: 'python',
      updatedAt: stat.mtime.toISOString(),
      isStub: false,
      // The starter goes out even when there is a buffer, which is the only case where
      // Reset means anything. Sending it only when the editor was ALREADY showing it made
      // the button vanish the moment you wrote something — the one time you want it.
      stub: (await starterFor(ctx, slug)) ?? GENERIC_STUB,
    });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }

  // No buffer yet. Offer the stub — but do NOT write it to disk. Writing here would mean
  // merely opening a problem creates a file, and "does a buffer exist" stops meaning
  // "has this person started".
  const stub = await starterFor(ctx, slug);

  return sendJson(res, 200, {
    code: stub ?? GENERIC_STUB,
    stub: stub ?? GENERIC_STUB,
    language: 'python',
    updatedAt: null,
    isStub: true,
    stubSource: stub ? 'leetcode' : 'generic',
  });
}

async function handlePutCode(req, res, ctx) {
  const slug = ctx.params.slug;
  const body = await readJsonBody(req);

  if (typeof body.code !== 'string') {
    throw new HttpError(400, 'BAD_REQUEST', 'Expected a "code" string in the request body.');
  }
  if (Buffer.byteLength(body.code, 'utf8') > MAX_CODE_BYTES) {
    throw new HttpError(413, 'BAD_REQUEST', 'That file is larger than this editor accepts.');
  }

  const file = solutionFile(ctx, slug);
  await writeAtomic(file, body.code);
  const stat = await fs.stat(file);
  return sendJson(res, 200, { updatedAt: stat.mtime.toISOString() });
}

/**
 * Snapshot the exact bytes that were run into attempts/<iso>.py.
 *
 * ARCHITECTURE §2 makes attempts/ the server's, and the coach is explicitly denied write
 * access to it — so if this does not run, that history simply stops existing. Called from
 * the router around POST /api/run.
 *
 * Best-effort by design: a snapshot failure must never stop the user's code from running.
 */
export async function snapshotAttempt(slug, code, log = console, ctx = null) {
  if (typeof slug !== 'string' || !slug || typeof code !== 'string' || !code.trim()) return null;
  try {
    const dir = path.join(problemDir(ctx, slug), 'attempts');
    await fs.mkdir(dir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(dir, `${stamp}.py`);

    // Skip if identical to the most recent attempt — running twice without editing
    // should not fill the folder with duplicates.
    const existing = (await fs.readdir(dir)).filter((n) => n.endsWith('.py')).sort();
    if (existing.length) {
      const prev = await fs.readFile(path.join(dir, existing[existing.length - 1]), 'utf8');
      if (prev === code) return null;
    }

    await fs.writeFile(file, code, 'utf8');
    return file;
  } catch (err) {
    log.warn?.(`[workspace] could not snapshot attempt for ${slug}: ${err.message}`);
    return null;
  }
}

export const routes = {
  'GET /api/problems/:slug/code': handleGetCode,
  'PUT /api/problems/:slug/code': handlePutCode,
};
