// Phase 4 route table — recording what LeetCode's judge said.
//
// The server never talks to LeetCode's judge. The browser submits, through the Studio
// Connector extension (extension/, docs/SUBMITTING.md), using its own LeetCode sign-in.
// It then hands this route the submission id and LeetCode's raw `/check/` body, and the
// server records them: the submitted code, the session events and meta.json.
//
// Premium problems are judged on neetcode.io instead; those requests say
// `source: 'neetcode'` and carry what the Connector read off NeetCode's page.
//
// Handlers are `(req, res, ctx)`. From `ctx` this module uses, all optionally:
//   ctx.catalog                        an unknown slug is a 404
//   ctx.homeRoot / ctx.paths.HOME_ROOT the workspace root, for meta.json
//   ctx.sessionLog                     the session log (a fresh one by default)
//   ctx.log                            console-shaped logger
// Nothing else. A bare `{}` ctx still works.

import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { SessionLog, isoWithOffset } from '../coach/sessions.mjs';
import { buildVerdict, submissionUrl, buildNeetCodeVerdict, neetcodeUrl } from './verdict.mjs';
import { recordVerdict, logSubmitted, logVerdict, saveSubmittedCode } from './record.mjs';

const MAX_BODY_BYTES = 1024 * 1024;

/** Submissions this process has already recorded, so a repeated call writes nothing twice.
 *  meta.json also refuses a submission id it already holds, which covers restarts. */
const recorded = new Set();

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

/**
 * Record one browser submission.
 *
 * `check` null means the submission went through but no verdict came back: only the
 * `submitted` event and the code are recorded.
 * @returns {Promise<object>} the contract's 200 body; the full verdict when `check` is set
 * @throws {HttpError} on a malformed request or a repeat
 */
export async function recordSubmission({ slug, code, submissionId, check = null, sessionLog = null, homeRoot, log = console }) {
  if (typeof slug !== 'string' || slug === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request did not say which problem it was for.');
  }
  if (typeof code !== 'string' || code.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request did not include the submitted code.');
  }
  const id = typeof submissionId === 'number' ? String(submissionId) : submissionId;
  if (typeof id !== 'string' || !/^[1-9][0-9]*$/.test(id)) {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request did not include a valid LeetCode submission id.');
  }
  // `state: "SUCCESS"` means judging finished. Anything earlier is not a verdict.
  if (check !== null && (typeof check !== 'object' || Array.isArray(check) || check.state !== 'SUCCESS')) {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request carried a judge result that had not finished.');
  }

  const key = `${id}:${check ? 'verdict' : 'submitted'}`;
  if (recorded.has(key)) throw new HttpError(409, 'ALREADY_RECORDED', `Submission ${id} is already recorded.`);
  recorded.add(key);

  const submittedAt = isoWithOffset();
  const url = submissionUrl(id);
  const submittedLog = await logSubmitted(sessionLog, slug, {
    submissionId: id, lang: 'python3', codeBytes: Buffer.byteLength(code, 'utf8'), submissionUrl: url, via: 'browser',
  });
  // The exact bytes that earned this verdict, kept beside it — the editor buffer will
  // have moved on by the time anyone reads the history back.
  const codeFile = await saveSubmittedCode({ root: homeRoot, slug, submissionId: id, code });
  if (!check) {
    return { ok: true, submissionId: id, submissionUrl: url, recorded: { sessionEvents: submittedLog.written, meta: false, note: 'no verdict yet' } };
  }

  const verdict = buildVerdict(check, id);
  const verdictLog = await logVerdict(sessionLog, slug, verdict);
  const meta = homeRoot
    ? await recordVerdict({ root: homeRoot, slug, verdict, at: isoWithOffset(), codeFile })
    : { written: false, reason: 'no workspace root configured' };
  for (const result of [submittedLog, verdictLog, meta]) {
    if (!result.written && result.reason) log?.warn?.(`[judge] ${slug}: verdict recorded only partially — ${result.reason}`);
  }
  return {
    ...verdict,
    submittedAt,
    recorded: {
      sessionEvents: submittedLog.written && verdictLog.written,
      meta: meta.written,
      note: meta.written ? null : (meta.reason ?? null),
    },
  };
}

/** A synthetic, sortable id for a NeetCode submission, which has no id of its own that
 *  we can read. Unique within this process even for two in the same millisecond. */
let lastNeetCodeStamp = 0;
export function neetcodeSubmissionId(now = Date.now()) {
  lastNeetCodeStamp = Math.max(now, lastNeetCodeStamp + 1);
  return `nc-${lastNeetCodeStamp}`;
}

/**
 * Record one premium-problem submission that the Connector made on neetcode.io.
 *
 * `result` is what the Connector read off NeetCode's page (`{ status, passed, total,
 * memory, time, details, url }`), or null when Submit was clicked but no verdict appeared
 * in time: then only the code and the `submitted` event are recorded, as for LeetCode.
 * `requestId` is the page's id for that one click, so a repeated call writes nothing twice.
 */
export async function recordNeetCodeSubmission({ slug, code, result = null, url = null, requestId = null, sessionLog = null, homeRoot, log = console }) {
  if (typeof slug !== 'string' || slug === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request did not say which problem it was for.');
  }
  if (typeof code !== 'string' || code.trim() === '') {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request did not include the submitted code.');
  }
  if (result !== null && (typeof result !== 'object' || Array.isArray(result) || typeof result.status !== 'string' || result.status.trim() === '')) {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request carried a NeetCode result without a verdict.');
  }
  if (requestId !== null && (typeof requestId !== 'string' || requestId.length > 100)) {
    throw new HttpError(400, 'BAD_REQUEST', 'That record request carried an unreadable request id.');
  }
  if (requestId) {
    const key = `neetcode:${requestId}:${result ? 'verdict' : 'submitted'}`;
    if (recorded.has(key)) throw new HttpError(409, 'ALREADY_RECORDED', 'That NeetCode submission is already recorded.');
    recorded.add(key);
  }

  const id = neetcodeSubmissionId();
  const link = neetcodeUrl(result?.url) ?? neetcodeUrl(url);
  const submittedAt = isoWithOffset();
  const submittedLog = await logSubmitted(sessionLog, slug, {
    submissionId: id, lang: 'python3', codeBytes: Buffer.byteLength(code, 'utf8'), submissionUrl: link, via: 'browser', source: 'neetcode',
  });
  const codeFile = await saveSubmittedCode({ root: homeRoot, slug, submissionId: id, code });
  if (!result) {
    return { ok: true, submissionId: id, submissionUrl: link, source: 'neetcode', recorded: { sessionEvents: submittedLog.written, meta: false, note: 'no verdict yet' } };
  }

  const verdict = buildNeetCodeVerdict({ ...result, url: link }, id);
  const verdictLog = await logVerdict(sessionLog, slug, verdict);
  const meta = homeRoot
    ? await recordVerdict({ root: homeRoot, slug, verdict, at: isoWithOffset(), codeFile })
    : { written: false, reason: 'no workspace root configured' };
  for (const r of [submittedLog, verdictLog, meta]) {
    if (!r.written && r.reason) log?.warn?.(`[judge] ${slug}: NeetCode verdict recorded only partially — ${r.reason}`);
  }
  return {
    ...verdict,
    submittedAt,
    recorded: {
      sessionEvents: submittedLog.written && verdictLog.written,
      meta: meta.written,
      note: meta.written ? null : (meta.reason ?? null),
    },
  };
}

/** POST /api/submit/record */
export async function handleRecord(req, res, ctx = {}) {
  const body = await readJsonBody(req);
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (ctx.catalog?.get && slug && !ctx.catalog.get(slug)) {
    throw new HttpError(404, 'PROBLEM_NOT_FOUND', `"${slug}" is not in the NeetCode 250.`);
  }
  const homeRoot = ctx.homeRoot ?? ctx.paths?.HOME_ROOT ?? HOME_ROOT;
  if (body.source === 'neetcode') {
    return sendJson(res, 200, await recordNeetCodeSubmission({
      slug,
      code: body.code,
      result: body.result ?? null,
      url: body.url ?? null,
      requestId: body.requestId ?? null,
      sessionLog: ctx.sessionLog ?? new SessionLog({ root: homeRoot }),
      homeRoot,
      log: ctx.log ?? console,
    }));
  }
  const payload = await recordSubmission({
    slug,
    code: body.code,
    submissionId: body.submissionId,
    check: body.check ?? null,
    sessionLog: ctx.sessionLog ?? new SessionLog({ root: homeRoot }),
    homeRoot,
    log: ctx.log ?? console,
  });
  return sendJson(res, 200, payload);
}

export const routes = {
  'POST /api/submit/record': handleRecord,
};

export default routes;
