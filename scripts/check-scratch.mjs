// The older browser checks must never save into the learner's live workspace.
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', error => reject(Error(`Port ${port} is occupied; refusing to reuse a process (${error.code}).`)));
    probe.listen(port, '127.0.0.1', () => probe.close(resolve));
  });
}

export async function seedProblem(home, slug) {
  const twoSum = slug === 'two-sum';
  const code = twoSum ? 'class Solution:\n    def twoSum(self, nums, target):\n        return []\n'
    : 'class Solution:\n    def containsDuplicate(self, nums):\n        return len(nums) != len(set(nums))\n';
  const cache = path.join(home, 'cache', 'leetcode');
  await fsp.mkdir(cache, { recursive: true });
  await fsp.writeFile(path.join(cache, `${slug}.json`), JSON.stringify({ question: {
    title: twoSum ? 'Two Sum' : 'Contains Duplicate', titleSlug: slug, difficulty: 'Easy', questionId: twoSum ? '1' : '217',
    content: '<p>Synthetic browser-check problem. Explain the approach and consider edge cases.</p>',
    metaData: JSON.stringify({ name: twoSum ? 'twoSum' : 'containsDuplicate',
      params: [{ name: 'nums', type: 'integer[]' }, ...(twoSum ? [{ name: 'target', type: 'integer' }] : [])],
      return: { type: twoSum ? 'integer[]' : 'boolean' } }),
    exampleTestcases: twoSum ? '[2,7,11,15]\n9' : '[1,2,3]\n[1,1]', codeSnippets: [{ langSlug: 'python3', code }],
  } }));
  await fsp.mkdir(path.join(home, 'problems', slug), { recursive: true });
  await fsp.writeFile(path.join(home, 'problems', slug, 'solution.py'), code);
}

export async function startScratch(port, slug = 'contains-duplicate', extraEnv = {}) {
  await requireFreePort(port);
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-check-home-'));
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
    await seedProblem(home, slug);
    if (extraEnv.STUDIO_COACH_PROVIDER) {
      await fsp.writeFile(path.join(home, 'coach-settings.json'), JSON.stringify({ provider: extraEnv.STUDIO_COACH_PROVIDER, model: 'default' }));
    }
    server = spawn(process.execPath, ['--input-type=module', '--eval',
      "globalThis.fetch = async () => { throw Error('Network disabled in browser check'); }; const m = await import('./server/index.mjs'); m.start();"], {
      cwd: path.resolve(new URL('..', import.meta.url).pathname),
      env: { ...process.env, STUDIO_HOME: home, STUDIO_PORT: String(port), STUDIO_MIRROR_DIR: '', STUDIO_CODEX_BINARY: '/nonexistent/check-codex', STUDIO_COACH_BINARY: '/nonexistent/check-claude', ...extraEnv },
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
