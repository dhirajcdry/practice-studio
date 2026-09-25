// Filesystem locations. One place, so tests can point at fixtures.
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const SERVER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const STUDIO_DIR = path.resolve(SERVER_DIR, '..');

export const DATA_DIR = path.join(STUDIO_DIR, 'data');
export const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
export const SOLUTIONS_INDEX_FILE = path.join(DATA_DIR, 'solutions-index.json');
export const VENDOR_ROOT = path.join(STUDIO_DIR, 'vendor', 'neetcode-solutions');
export const WEB_DIR = path.join(STUDIO_DIR, 'web');

/**
 * The workspace: every solution, attempt, chat and note this tool has.
 *
 * `STUDIO_HOME` points it somewhere else. That exists because a browser check that drives
 * the real UI drives the real editor, and the editor saves — the toolbar check typed into
 * contains-duplicate and its Reset wrote the stub over a working solution. The attempt
 * snapshots got it back, which is luck, not a design. Checks now run against a scratch
 * workspace and cannot reach this one.
 */
export const HOME_ROOT = process.env.STUDIO_HOME
  ? path.resolve(process.env.STUDIO_HOME)
  : path.join(os.homedir(), 'LeetCodeTutor');
/** Where the daily mirror writes, or null for no mirror. See server/mirror/daily.mjs. */
export const MIRROR_DIR = process.env.STUDIO_MIRROR_DIR
  ? path.resolve(process.env.STUDIO_MIRROR_DIR)
  : null;
export const LEETCODE_CACHE_DIR = path.join(HOME_ROOT, 'cache', 'leetcode');

export const PORT = Number(process.env.STUDIO_PORT || 4173);
export const HOST = '127.0.0.1';
