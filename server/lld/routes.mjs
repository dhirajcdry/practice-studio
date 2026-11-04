import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJsonBody } from '../coach/http.mjs';
import { HttpError, sendJson } from '../http-util.mjs';
import { service as interviewService, reserve as reserveInterview } from '../interview/routes.mjs';
import { SCENARIOS, scenario } from './scenarios.mjs';
import { listProblems, publicProblem } from '../learning/selection.mjs';
import { validate } from '../interview/store.mjs';
import { elapsed, observe } from '../interview/state.mjs';
import { runPythonScript } from '../runner/python-script.mjs';
import { listProblemSlugs } from '../storage-layout.mjs';
const canonical = slug => typeof slug === 'string' && slug.startsWith('lld-') ? slug : `lld-${slug}`;
async function owned(svc, slug, id, mutable = false) {
  validate(slug, id);
  const state = await svc.store.readState(slug, id);
  if (!state || state.discipline !== 'lld') throw new HttpError(404, 'NOT_FOUND', 'Interview not found.');
  if (mutable && (state.debriefed || state.endedAt !== null)) throw new HttpError(409, 'FINISHED', 'This interview is finished; its document is read-only.');
  return state;
}
async function list(req, res, ctx) {
  const svc = interviewService(ctx), interviews = [];
  const problems = await listProblems(svc.root, 'lld');
  const slugs = await listProblemSlugs(svc.root, { discipline: 'lld' });
  for (const slug of slugs) for (const id of await svc.store.list(slug)) {
    const state = await svc.store.readState(slug, id);
    if (state?.discipline === 'lld') interviews.push({ id, slug, title: state.title || problems.find(p => p.slug === slug)?.title || slug, startedAt: state.startedAt, debriefed: state.debriefed, pausedAt: state.pausedAt, minutes: state.minutes, mode: state.mode });
  }
  return sendJson(res, 200, { scenarios: problems.map(publicProblem), interviews });
}
async function code(req, res, ctx) {
  const svc = interviewService(ctx), slug = canonical(ctx.params.slug), id = ctx.params.id;
  const state = await owned(svc, slug, id, req.method !== 'GET');
  const file = path.join(svc.store.dir(slug, id), 'code.py');
  if (req.method === 'GET') {
    if (state.debriefed) return sendJson(res, 200, { code: state.lastCode || '' });
    try { return sendJson(res, 200, { code: await fs.readFile(file, 'utf8') }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return sendJson(res, 200, { code: state.lastCode || '' }); }
  }
  const body = await readJsonBody(req);
  if (typeof body.code !== 'string' || body.code.length > 200000) throw new HttpError(400, 'BAD_REQUEST', 'Document must be at most 200000 characters.');
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  try { await fs.writeFile(tmp, body.code); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }); }
  return sendJson(res, 200, { saved: true });
}
async function run(req, res, ctx) {
  const body = await readJsonBody(req), slug = canonical(body.slug), id = body.interviewId, svc = interviewService(ctx);
  validate(slug, id);
  if (typeof body.code !== 'string' || body.code.length > 200000) throw new HttpError(400, 'BAD_REQUEST', 'Document must be at most 200000 characters.');
  const slot = reserveInterview(svc, `${slug}/${id}`);
  try {
    const state = await owned(svc, slug, id, true);
    const result = await runPythonScript(body.code);
    const at = new Date().toISOString(), elapsedMs = elapsed(state), phase = state.phase;
    await svc.store.append(slug, id, { kind: 'buffer', at, elapsedMs, phase, code: body.code });
    const event = { type: 'run_result', executionOnly: true, error: result.status !== 'ok' || result.exitCode !== 0, total: null, failed: result.exitCode === 0 && result.status === 'ok' ? 0 : 1, result };
    await svc.store.append(slug, id, { kind: 'event', at, elapsedMs, phase, event });
    state.lastCode = body.code; observe(state, event); await svc.store.writeState(slug, id, state);
    return sendJson(res, 200, result);
  } finally { slot.release(); }
}
export const routes = { 'GET /api/lld': list, 'GET /api/lld/:slug/:id/code': code, 'PUT /api/lld/:slug/:id/code': code, 'POST /api/lld/run': run };
