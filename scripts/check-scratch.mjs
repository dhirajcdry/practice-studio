// The older browser checks must never save into the learner's live workspace.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function startScratch(port, slug = 'contains-duplicate') {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-check-home-'));
  const cache = path.join(home, 'cache', 'leetcode');
  const code = 'class Solution:\n    def containsDuplicate(self, nums):\n        return len(nums) != len(set(nums))\n';
  let server;
  let log = '';
  const cleanup = async () => {
    if (server && server.exitCode === null && !server.signalCode) {
      await new Promise(resolve => {
        const timer = setTimeout(() => { server.kill('SIGKILL'); resolve(); }, 3000);
        server.once('exit', () => { clearTimeout(timer); resolve(); });
        server.kill();
      });
    }
    await fsp.rm(home, { recursive: true, force: true });
  };
  try {
    await fsp.mkdir(cache, { recursive: true });
    await fsp.writeFile(path.join(cache, `${slug}.json`), JSON.stringify({ question: {
      title: 'Contains Duplicate', titleSlug: slug, difficulty: 'Easy', questionId: '217',
      content: '<p>Synthetic example: return whether the array contains a duplicate.</p>',
      metaData: JSON.stringify({ name: 'containsDuplicate', params: [{ name: 'nums', type: 'integer[]' }], return: { type: 'boolean' } }),
      exampleTestcases: '[1,2,3]\n[1,1]', codeSnippets: [{ langSlug: 'python3', code }],
    } }));
    await fsp.mkdir(path.join(home, 'problems', slug), { recursive: true });
    await fsp.writeFile(path.join(home, 'problems', slug, 'solution.py'), code);
    server = spawn(process.execPath, ['--input-type=module', '--eval',
      "globalThis.fetch = async () => { throw Error('Network disabled in browser check'); }; const m = await import('./server/index.mjs'); m.start();"], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_MIRROR_DIR: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    server.on('error', error => { log += error.message; });
    server.stderr.on('data', data => { log = (log + data).slice(-4000); });
    const origin = `http://127.0.0.1:${port}`;
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null || server.signalCode) throw Error(`Scratch server exited: ${log}`);
      try {
        if ((await fetch(`${origin}/api/health`)).ok) return { home, server, origin, cleanup };
      } catch { /* bounded readiness retry */ }
      await sleep(100);
    }
    throw Error(`Scratch server did not become ready: ${log}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
}
