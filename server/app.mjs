// The router. Every API response shape here is fixed by docs/API-CONTRACT.md.

import { HttpError, sendJson, sendError, checkLoopback, isSafeSlug } from './http-util.mjs';
import { LeetCodeError } from './leetcode.mjs';
import { Readable } from 'node:stream';
import { HOME_ROOT, MIRROR_DIR } from './paths.mjs';
import { routes as runnerRoutes } from './runner/routes.mjs';
import { routes as coachRoutes } from './coach/routes.mjs';
import { routes as workspaceRoutes, snapshotAttempt } from './workspace/routes.mjs';
import { routes as statsRoutes } from './stats/routes.mjs';
import { routes as asrRoutes } from './asr/routes.mjs';
import { routes as judgeRoutes } from './judge/routes.mjs';
import { routes as designRoutes } from './design/routes.mjs';
import { scheduleMirror } from './mirror/daily.mjs';
import { SessionLog, onSessionEvent } from './coach/sessions.mjs';
import { armAttemptWriter } from './attempts/watch.mjs';

// Modules are built independently and each exports a plain route table; the router is the
// single place they meet. Keys are 'METHOD /path/with/:params'.
const MODULE_ROUTES = {
  ...runnerRoutes,
  ...coachRoutes,
  ...workspaceRoutes,
  ...statsRoutes,
  ...asrRoutes,
  ...judgeRoutes,
  ...designRoutes,
};

const sessionLog = new SessionLog({ root: HOME_ROOT });

// Mirror to iCloud as the work happens. The laptop can close at any moment, so this
// cannot wait for a daily job — it rides the event log instead.
let mirrorArmed = false;
function armMirror(catalog, log) {
  if (mirrorArmed) return;
  mirrorArmed = true;
  // An attempt document is written the moment the attempt ends, so the coach never has to
  // reconstruct a sitting from six stores to answer a question about it.
  armAttemptWriter({ root: HOME_ROOT, catalog, log });
  if (MIRROR_DIR) {
    const mirror = { root: HOME_ROOT, catalog, dir: MIRROR_DIR, log };
    onSessionEvent(() => scheduleMirror(mirror));
    scheduleMirror(mirror); // one write at boot, so today's file exists
  }
}

/** Match 'POST /api/run' or 'GET /api/sessions/:slug' against a real request. */
function matchModuleRoute(method, segments) {
  for (const [key, handler] of Object.entries(MODULE_ROUTES)) {
    const spaceAt = key.indexOf(' ');
    if (key.slice(0, spaceAt) !== method) continue;

    const pattern = key.slice(spaceAt + 1).split('/').filter(Boolean);
    if (pattern.length !== segments.length) continue;

    const params = {};
    let ok = true;
    for (let i = 0; i < pattern.length; i += 1) {
      if (pattern[i].startsWith(':')) {
        params[pattern[i].slice(1)] = segments[i];
      } else if (pattern[i] !== segments[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler, params };
  }
  return null;
}

function notFound(message) {
  return new HttpError(404, 'NOT_FOUND', message);
}

/**
 * Read the /api/run body so we can snapshot the exact bytes being run, then hand the
 * handler a stream that replays it. The runner reads the body itself, so we must not
 * consume it destructively.
 *
 * Snapshotting is best-effort: if it fails, the run still proceeds. Losing a history
 * entry is a nuisance; refusing to run someone's code is not acceptable.
 */
async function teeRunBodyAndSnapshot(req, log, homeRoot) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 2 * 1024 * 1024) break; // pathological; let the handler reject it
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  try {
    const body = JSON.parse(buffer.toString('utf8'));
    await snapshotAttempt(body?.slug, body?.code, log, { homeRoot });
    // The runner does not log; if this does not happen here, "ran_locally" never gets
    // recorded and the dashboard's struggle signals can never fill in.
    if (typeof body?.slug === 'string' && body.slug) {
      await sessionLog.appendEvent(body.slug, 'ran_locally', {}).catch(() => {});
    }
  } catch {
    // Unparseable body is the handler's problem to report, not ours to crash on.
  }

  const replay = Readable.from(buffer.length ? [buffer] : []);
  replay.headers = req.headers;
  replay.method = req.method;
  replay.url = req.url;
  replay.socket = req.socket;
  replay.on('error', () => {});

  let slug = null;
  try {
    slug = JSON.parse(buffer.toString('utf8'))?.slug ?? null;
  } catch {
    slug = null;
  }
  return { req: replay, slug: typeof slug === 'string' ? slug : null };
}

/**
 * Record the outcome of a run. The runner returns its result to the client and does not
 * write to the log, so the outcome is only observable here, on the way out.
 *
 * Records what actually happened — including a run that failed to compile. A log that
 * only remembers successes is worse than no log for spotting where someone struggles.
 */
function tapRunResult(res, slug, log) {
  const chunks = [];
  const { write, end } = res;

  res.write = function (chunk, ...rest) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return write.call(this, chunk, ...rest);
  };

  res.end = function (chunk, ...rest) {
    if (chunk && typeof chunk !== 'function') {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      sessionLog
        .appendEvent(slug, 'run_result', {
          ok: body?.ok === true,
          passed: body?.summary?.passed ?? null,
          total: body?.summary?.total ?? null,
          totalMs: body?.summary?.totalMs ?? null,
          errorKind: body?.error?.kind ?? null,
        })
        .catch(() => {});
    } catch {
      // A non-JSON response is not something to crash the response path over.
    }
    return end.call(this, chunk, ...rest);
  };
}

/**
 * @param {object} deps
 * @param {import('./catalog.mjs').Catalog} deps.catalog
 * @param {import('./solutions.mjs').SolutionStore} deps.solutions
 * @param {import('./leetcode.mjs').LeetCodeContentCache} deps.leetcode
 * @param {import('./static.mjs').StaticSite} deps.site
 * @returns {(req, res) => void} a node:http request listener
 */
export function createApp({ catalog, solutions, leetcode, site, log = console, homeRoot = HOME_ROOT }) {
  armMirror(catalog, log);
  async function handleApi(req, res, url) {
    const segments = url.pathname.split('/').filter(Boolean); // ['api', 'problems', ...]

    // Module routes first: they own the non-GET verbs, and their handlers read the
    // request body themselves, so nothing here may consume the stream before them.
    const matched = matchModuleRoute(req.method, segments);
    if (matched) {
      for (const value of Object.values(matched.params)) {
        if (!isSafeSlug(value)) {
          throw new HttpError(400, 'BAD_REQUEST', 'That address could not be understood.');
        }
      }
      const ctx = {
        catalog,
        solutions,
        leetcode,
        log,
        params: matched.params,
        paths: { HOME_ROOT: homeRoot },
        homeRoot,
      };
      // attempts/ belongs to the server — the coach is explicitly denied it — so the
      // snapshot has to happen here, on the way in, or that history never gets written.
      if (req.method === 'POST' && url.pathname === '/api/run') {
        const prepared = await teeRunBodyAndSnapshot(req, log, homeRoot);
        req = prepared.req;
        if (prepared.slug) tapRunResult(res, prepared.slug, log);
      }
      return matched.handler(req, res, ctx);
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'That address does not accept this method.');
    }

    if (segments.length === 2 && segments[1] === 'health') {
      return sendJson(res, 200, {
        ok: true,
        problemCount: catalog.problems.length,
        patternCount: catalog.patterns.length,
        catalogSource: catalog.source,
        solutionsCommit: solutions.commit,
      });
    }

    if (segments.length === 2 && segments[1] === 'problems') {
      return sendJson(res, 200, { problems: catalog.problems, patterns: catalog.patterns });
    }

    if (segments.length >= 3 && segments[1] === 'problems') {
      let slug;
      try {
        slug = decodeURIComponent(segments[2]);
      } catch {
        throw new HttpError(400, 'BAD_REQUEST', 'That problem address could not be understood.');
      }
      if (!isSafeSlug(slug)) {
        throw new HttpError(404, 'PROBLEM_NOT_FOUND', 'That problem is not in the NeetCode 250.');
      }
      const entry = catalog.get(slug);
      if (!entry) {
        throw new HttpError(
          404,
          'PROBLEM_NOT_FOUND',
          `"${slug}" is not in the NeetCode 250, which is the only list this phase shows.`,
        );
      }

      if (segments.length === 3) return handleProblem(res, entry);
      if (segments.length === 4 && segments[3] === 'solution') return handleSolution(res, entry);
      if (segments.length === 4 && segments[3] === 'article') return handleArticle(res, entry);
    }

    throw notFound('That address does not exist on this server.');
  }

  async function handleProblem(res, entry) {
    const solutionLangs = solutions.languagesFor(entry);
    const articlePath = solutions.articlePathFor(entry);

    let content = null;
    try {
      const result = await leetcode.getContent(entry.slug);
      content = result.content;
      if (result.error) {
        log.warn?.(
          `[leetcode] serving cached ${entry.slug} (stale): ${result.error.message}`,
        );
      }
    } catch (err) {
      if (err instanceof LeetCodeError) {
        throw new HttpError(
          503,
          'LEETCODE_UNREACHABLE',
          `${err.message} The description could not be loaded — everything else in the app still works.`,
        );
      }
      throw err;
    }

    return sendJson(res, 200, {
      slug: entry.slug,
      catalog: entry,
      content,
      solution: {
        available: solutionLangs.has('python'),
        language: solutionLangs.has('python') ? 'python' : null,
      },
      article: { available: articlePath !== null },
    });
  }

  async function handleSolution(res, entry) {
    const langs = solutions.languagesFor(entry);
    const hit = langs.get('python');
    if (!hit) {
      throw new HttpError(
        404,
        'SOLUTION_NOT_AVAILABLE',
        'There is no Python reference solution for this problem in the NeetCode repository.',
      );
    }
    const code = await solutions.readVendorFile(hit.path);
    if (code === null) {
      throw new HttpError(
        404,
        'SOLUTION_NOT_AVAILABLE',
        'The Python reference solution is listed for this problem but its file could not be read.',
      );
    }
    return sendJson(res, 200, {
      language: 'python',
      code,
      sourcePath: hit.path,
      license: solutions.license,
    });
  }

  async function handleArticle(res, entry) {
    const relPath = solutions.articlePathFor(entry);
    if (!relPath) {
      throw new HttpError(
        404,
        'ARTICLE_NOT_AVAILABLE',
        'There is no written explanation for this problem in the NeetCode repository.',
      );
    }
    const markdown = await solutions.readVendorFile(relPath);
    if (markdown === null) {
      throw new HttpError(
        404,
        'ARTICLE_NOT_AVAILABLE',
        'The written explanation is listed for this problem but its file could not be read.',
      );
    }
    return sendJson(res, 200, { markdown, sourcePath: relPath, license: solutions.license });
  }

  return function requestListener(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1');
    } catch {
      return sendError(res, 400, 'BAD_REQUEST', 'That request address could not be understood.');
    }

    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');

    const rejection = checkLoopback(req);
    if (rejection !== null) {
      return sendError(res, 403, 'FORBIDDEN_ORIGIN', rejection);
    }

    const run = isApi
      ? handleApi(req, res, url)
      : req.method === 'GET' || req.method === 'HEAD'
        ? site.serve(req, res, url.pathname)
        : Promise.reject(new HttpError(405, 'METHOD_NOT_ALLOWED', 'Only GET is supported.'));

    Promise.resolve(run).catch((err) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        return sendError(res, err.status, err.code, err.message);
      }
      // Never leak a stack trace to the page; the message is user-facing.
      log.error?.('[studio] unhandled request error:', err);
      return sendError(
        res,
        500,
        'INTERNAL_ERROR',
        'Something went wrong inside the Studio server. The details are in its console output.',
      );
    });
  };
}
