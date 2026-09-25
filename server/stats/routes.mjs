// Phase 6 route table — the dashboard's only endpoint.
//
// Wired into the router by the main agent per the contract's integration rule; nothing
// here touches app.mjs or index.mjs.
//
//   GET /api/stats  → everything the progress dashboard shows, in one payload
//
// Handlers take (req, res, ctx). From ctx we use, all optionally:
//   ctx.catalog                          Phase 1 catalog — supplies the denominators
//   ctx.homeRoot / ctx.paths.HOME_ROOT   workspace root override, for tests
//   ctx.log                              console-shaped logger
// Anything missing falls back to a sane default so the table works against a bare ctx.
//
// One request reads a few hundred small files at most, and the numbers must be current
// the moment a run finishes — so there is no cache. If the workspace ever grows to the
// point where this is slow, the honest fix is an index the server maintains on write,
// not a stale number served fast.

import { sendJson } from '../http-util.mjs';
import { HOME_ROOT } from '../paths.mjs';
import { buildStats } from './aggregate.mjs';

export async function handleGetStats(req, res, ctx) {
  const root = ctx?.homeRoot ?? ctx?.paths?.HOME_ROOT ?? HOME_ROOT;
  const catalog = ctx?.catalog ?? null;

  const stats = await buildStats({ root, catalog });

  // The absolute path of someone's home directory is not something the page needs; the
  // shape of the workspace is. Send the display form only.
  const payload = {
    ...stats,
    workspace: { ...stats.workspace, root: '~/LeetCodeTutor' },
  };
  return sendJson(res, 200, payload);
}

export const routes = {
  'GET /api/stats': handleGetStats,
};

export default routes;
