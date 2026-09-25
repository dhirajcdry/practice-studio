// Studio server — Phase 1 (Browse).
// Node 23 ESM, node:http, zero runtime dependencies. Binds 127.0.0.1 only: this process
// will later execute code and hold a LeetCode session, so it must not be reachable.

import http from 'node:http';

import {
  CATALOG_FILE,
  SOLUTIONS_INDEX_FILE,
  VENDOR_ROOT,
  WEB_DIR,
  LEETCODE_CACHE_DIR,
  HOST,
  PORT,
} from './paths.mjs';
import { loadSolutionStore } from './solutions.mjs';
import { loadCatalog, validateCatalog } from './catalog.mjs';
import { LeetCodeContentCache } from './leetcode.mjs';
import { StaticSite } from './static.mjs';
import { createApp } from './app.mjs';

export function boot({ quiet = false } = {}) {
  const solutions = loadSolutionStore(SOLUTIONS_INDEX_FILE, VENDOR_ROOT);
  const catalog = loadCatalog(CATALOG_FILE, solutions);
  const leetcode = new LeetCodeContentCache({ cacheDir: LEETCODE_CACHE_DIR });
  const site = new StaticSite(WEB_DIR);
  const app = createApp({ catalog, solutions, leetcode, site });
  return { solutions, catalog, leetcode, site, app };
}

function report(catalog, solutions, site) {
  const withPython = catalog.neetcode250.filter((p) => p.hasPythonSolution).length;
  const withArticle = catalog.neetcode250.filter((p) => p.hasArticle).length;

  console.log(`  problems (neetcode250): ${catalog.neetcode250.length}   (expected 250)`);
  console.log(`  patterns:               ${catalog.patterns.length}   (expected 18)`);
  console.log(`  python solutions:       ${withPython}/${catalog.neetcode250.length}`);
  console.log(`  articles:               ${withArticle}/${catalog.neetcode250.length}`);
  console.log(`  solutions commit:       ${solutions.commit ?? 'unknown'}`);
  console.log(`  client:                 ${site.available ? WEB_DIR : 'not built yet (placeholder page served)'}`);

  for (const w of validateCatalog(catalog)) {
    console.warn(`\n  !! WARNING: ${w}\n`);
  }
  if (solutions.vendorRootReal === null) {
    console.warn(`\n  !! WARNING: vendor directory missing at ${VENDOR_ROOT} — solutions and articles will 404.\n`);
  }
}

export function start() {
  console.log('Studio server — Phase 1 (Browse)');
  const { catalog, solutions, leetcode, site, app } = boot();
  report(catalog, solutions, site);

  const server = http.createServer(app);

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  server.listen(PORT, HOST, () => {
    console.log(`\n  listening on http://${HOST}:${PORT}  (loopback only)\n`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\nPort ${PORT} is already in use. Stop the other Studio server, or set STUDIO_PORT.\n`);
      process.exit(1);
    }
    console.error('Server error:', err);
    process.exit(1);
  });

  // A LeetCode hiccup must never take the process down.
  process.on('unhandledRejection', (reason) => {
    console.error('[studio] unhandled rejection (ignored, server still up):', reason);
  });

  const shutdown = () => {
    console.log('\nShutting down.');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) start();
