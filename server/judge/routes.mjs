// Phase 4 route table — the judge.
//
// Wired into the router by the main agent per the contract's Integration rule; nothing in
// this directory touches server/app.mjs or server/index.mjs.
//
//   import { routes as judgeRoutes } from './judge/routes.mjs';
//
// Handlers are `(req, res, ctx)`. From `ctx` this module uses, all optionally:
//   ctx.catalog                        an unknown slug is a 404 before any network happens
//   ctx.leetcode                       the Phase 1 content cache, for the internal
//                                      question_id without an extra round trip
//   ctx.homeRoot / ctx.paths.HOME_ROOT the workspace root, for meta.json
//   ctx.log                            console-shaped logger
// Nothing else. A bare `{}` ctx still works.

import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { SessionLog } from '../coach/sessions.mjs';
import { QuestionIdCache, JudgeError } from './client.mjs';
import { submitToJudge } from './submit.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

/** One process-lifetime cache of internal question ids, shared across requests. */
let questionIds = null;
let questionIdsKey = null;

function cacheFor(ctx) {
  const key = ctx?.leetcode ?? null;
  if (questionIds === null || questionIdsKey !== key) {
    questionIds = new QuestionIdCache({ leetcode: key ?? null });
    questionIdsKey = key;
  }
  return questionIds;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'BODY_TOO_LARGE', 'That submission was too large to read.');
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', 'That request body could not be read as JSON.');
  }
}

export async function handleSubmit(req, res, ctx = {}) {
  const body = await readJsonBody(req);
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (slug === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That submit request did not say which problem it was for.');
  }
  if (ctx.catalog?.get && !ctx.catalog.get(slug)) {
    throw new HttpError(404, 'PROBLEM_NOT_FOUND', `"${slug}" is not in the NeetCode 250.`);
  }

  const homeRoot = ctx.homeRoot ?? ctx.paths?.HOME_ROOT ?? HOME_ROOT;
  const sessionLog = ctx.sessionLog ?? new SessionLog({ root: homeRoot });

  // The shared id cache belongs to the real fetch. A test that injects its own fetch gets
  // a fresh cache so a stub can never be answered from a live-fetched id, or vice versa.
  const overrides = ctx.judgeOverrides ?? {};
  const ids = ctx.questionIds ?? (overrides.fetchImpl ? undefined : cacheFor(ctx));

  try {
    const payload = await submitToJudge({
      slug,
      code: body.code,
      leetcode: ctx.leetcode ?? null,
      questionIds: ids,
      sessionLog,
      homeRoot,
      log: ctx.log ?? console,
      ...overrides,
    });
    return sendJson(res, 200, payload);
  } catch (err) {
    if (err instanceof JudgeError) {
      // The error envelope from API-CONTRACT.md, plus the submission id on a timeout —
      // an honest timeout has to name the submission it left running.
      const error = { code: err.code, message: err.message };
      if (err.submissionId !== undefined) {
        error.submissionId = err.submissionId;
        error.submissionUrl = err.submissionUrl;
      }
      return sendJson(res, err.status, { error });
    }
    throw err;
  }
}

export const routes = {
  'POST /api/submit': handleSubmit,
};

export default routes;
