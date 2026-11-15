import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HttpError, sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { readProblemDir, statusOf, msOf } from './aggregate.mjs';
import { shelveCode, unshelveCode } from './sprint-code.mjs';

const FILE = 'tracker.json';
let writeQueue = Promise.resolve();

async function readState(root) {
  try {
    const state = JSON.parse(await fsp.readFile(path.join(root, FILE), 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).some((k) => k !== 'resetAt')
      || (state.resetAt !== null && msOf(state.resetAt) === null)) {
      throw new Error('Invalid tracker state');
    }
    return { resetAt: state.resetAt ?? null };
  } catch (error) {
    if (error?.code === 'ENOENT') return { resetAt: null };
    throw new HttpError(500, 'TRACKER_READ_FAILED', 'The tracker state could not be read.');
  }
}

async function saveState(root, state) {
  await fsp.mkdir(root, { recursive: true });
  const file = path.join(root, FILE);
  const tmp = `${file}.${randomUUID()}.tmp`;
  try { await fsp.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); await fsp.rename(tmp, file); }
  finally { await fsp.rm(tmp, { force: true }).catch(() => {}); }
}

function catalogSlugs(catalog) {
  return (catalog?.problems ?? []).map((p) => p.slug ?? p.leetcodeSlug).filter((s) => typeof s === 'string');
}

async function body(req) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += Buffer.byteLength(chunk); if (size > 8192) throw new HttpError(413, 'BODY_TOO_LARGE', 'The request body is too large.'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'BAD_REQUEST', 'The request body must be JSON.'); }
}

function after(record, resetAt) {
  const cutoff = msOf(resetAt);
  if (cutoff === null) return record;
  const freshEvents = record.allEvents.filter((e) => e.type !== 'problem_opened' && msOf(e.at) !== null && msOf(e.at) > cutoff);
  const freshAttempts = record.attemptStamps.filter((at) => msOf(at) > cutoff);
  const acceptedEvent = freshEvents.find((e) => e.type === 'verdict' && (e.data?.accepted === true || e.data?.status_code === 10 || e.data?.statusCode === 10 || ['accepted'].includes(String(e.data?.verdict ?? e.data?.status ?? '').trim().toLowerCase())));
  const acceptedMeta = record.verdicts.find((v) => String(v.verdict).trim().toLowerCase() === 'accepted' && msOf(v.at) !== null && msOf(v.at) > cutoff);
  const localPass = freshEvents.find((e) => e.type === 'run_result' && (() => { const d = e.data?.summary && typeof e.data.summary === 'object' ? e.data.summary : e.data; return Number.isFinite(d?.passed) && Number.isFinite(d?.total) && d.total > 0 && d.passed === d.total; })());
  return { ...record, allEvents: freshEvents, eventCount: freshEvents.length, attempts: freshAttempts.length, attemptStamps: freshAttempts, hasNotes: false, hasMeta: false, hasSolutionFile: false, accepted: acceptedEvent ? { at: acceptedEvent.at, source: 'session log' } : acceptedMeta ? { at: acceptedMeta.at, source: 'meta.json' } : null, localPassAt: localPass?.at ?? null };
}

export async function handleGetTracker(req, res, ctx) {
  const root = ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
  const state = await readState(root);
  const problems = [];
  for (const slug of catalogSlugs(ctx?.catalog)) {
    const record = await readProblemDir(root, slug);
    const resetAt = state.resetAt;
    const view = resetAt ? after(record, resetAt) : record;
    const item = { slug, status: statusOf(view) };
    if (resetAt) item.resetAt = resetAt;
    problems.push(item);
  }
  return sendJson(res, 200, { resetAt: state.resetAt, problems });
}

async function mutate(req, res, ctx, restore) {
  const input = await body(req);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 0) {
    throw new HttpError(400, 'BAD_REQUEST', 'The tracker request body must be an empty JSON object.');
  }
  const root = ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    const state = await readState(root);
    const before = state.resetAt;
    state.resetAt = restore ? null : new Date().toISOString();
    // A fresh round opens every problem on its starter; undo puts the shelved code back.
    let code;
    if (restore) code = before ? await unshelveCode(root, before) : { restored: [], kept: [] };
    else code = { shelved: await shelveCode(root, state.resetAt) };
    await saveState(root, state);
    // The reset date decides what the tracker shows, so every change to it is traceable.
    console.log(`[tracker] ${new Date().toISOString()} reset date ${restore ? 'cleared' : 'set'}: ${before ?? 'none'} -> ${state.resetAt ?? 'none'}; code ${restore ? `restored ${code.restored.length}, kept ${code.kept.length}` : `shelved ${code.shelved.length}`} (${req.headers?.referer || 'no referer'})`);
    return { resetAt: state.resetAt, code };
  });
  const { resetAt, code } = await writeQueue;
  return sendJson(res, 200, { resetAt, restored: restore, code: {
    shelved: code.shelved?.length ?? 0, restored: code.restored?.length ?? 0, kept: code.kept?.length ?? 0 } });
}

export const handleResetTracker = (req, res, ctx) => mutate(req, res, ctx, false);
export const handleRestoreTracker = (req, res, ctx) => mutate(req, res, ctx, true);
