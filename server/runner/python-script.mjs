// The same isolated execution path for learner and coach runs of an LLD document.
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeWorkspace, removeWorkspace, runDriver } from './execute.mjs';
export async function runPythonScript(code) {
  if (typeof code !== 'string' || code.length > 200000) throw Error('A Python document of at most 200000 characters is required.');
  let dir;
  try {
    dir = await makeWorkspace(code);
    await fs.writeFile(path.join(dir, '_studio_driver.py'), 'import runpy, socket\ndef denied(*a, **k): raise PermissionError("Network access is disabled in Studio")\nsocket.socket=denied\nsocket.create_connection=denied\nrunpy.run_path("solution.py", run_name="__main__")\n');
    const raw = await runDriver({ dir, configPath: path.join(dir, 'unused.json'), resultPath: path.join(dir, 'unused-result.json') });
    return { status: raw.status, exitCode: raw.code, stdout: raw.stdout, stderr: raw.stderr, timedOut: raw.status === 'timeout', truncated: raw.stdoutTruncated, ms: raw.ms };
  } finally { await removeWorkspace(dir); }
}
