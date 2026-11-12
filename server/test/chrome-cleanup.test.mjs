import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanupChrome } from '../../scripts/chrome-cleanup.mjs';

test('profile cleanup waits for a delayed child shutdown before removing its files', async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-cleanup-test-'));
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    process.on('SIGTERM', () => setTimeout(() => {
      fs.writeFileSync(process.argv[1] + '/last-write', 'shutdown');
      process.exit(0);
    }, 50));
    process.stdout.write('ready');
    setInterval(() => {}, 1000);
  `, profile], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await once(child.stdout, 'data');
    await cleanupChrome(child, profile);
    assert.equal(child.exitCode, 0);
    await assert.rejects(fs.stat(profile), { code: 'ENOENT' });
  } finally {
    child.kill('SIGKILL');
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
