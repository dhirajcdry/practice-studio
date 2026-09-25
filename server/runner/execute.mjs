// Spawning python3, and being able to get rid of it again.
//
// This is the user's own code, run with their consent. The limits here exist so that an
// accidental `while True:` or a runaway allocation does not take the machine down — not to
// defend the machine against its owner.
//
// The one thing that must be exactly right: a runaway that spawns children has to die
// completely. So every run gets its own process group (`detached: true`) and is killed with
// `kill(-pgid)`, never `kill(pid)`.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNNER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DRIVER_SOURCE = path.join(RUNNER_DIR, '_studio_driver.py');
export const DRIVER_BASENAME = '_studio_driver.py';
export const USER_BASENAME = 'solution.py';

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_OUTPUT_CAP = 256 * 1024;

const SANDBOX_PROFILE = '(version 1)\n(allow default)\n(deny network*)\n';

let sandboxChecked = null;

/** macOS ships sandbox-exec; it is the only zero-dependency way to actually deny the
 *  child a socket. Where it is missing we fall back to the driver's socket blocking. */
export function sandboxExecPath() {
  if (process.env.STUDIO_NO_SANDBOX === '1') return null;
  if (sandboxChecked !== null) return sandboxChecked;
  sandboxChecked = null;
  if (process.platform === 'darwin') {
    try {
      fs.accessSync('/usr/bin/sandbox-exec', fs.constants.X_OK);
      sandboxChecked = '/usr/bin/sandbox-exec';
    } catch {
      sandboxChecked = null;
    }
  }
  return sandboxChecked;
}

/** A fresh temp dir holding the driver, the user's code and the sandbox profile. */
export async function makeWorkspace(code) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'studio-run-'));
  const driver = await fsp.readFile(DRIVER_SOURCE, 'utf8');
  await Promise.all([
    fsp.writeFile(path.join(dir, USER_BASENAME), typeof code === 'string' ? code : '', 'utf8'),
    fsp.writeFile(path.join(dir, DRIVER_BASENAME), driver, 'utf8'),
    fsp.writeFile(path.join(dir, 'sandbox.sb'), SANDBOX_PROFILE, 'utf8'),
  ]);
  return dir;
}

export async function removeWorkspace(dir) {
  if (!dir) return;
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** SIGTERM the whole group, then SIGKILL it. Never the bare pid. */
export function killGroup(pid, { signal = 'SIGTERM' } = {}) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // The group may already be gone, or (rarely) we never got one.
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Run the driver once.
 *
 * @returns {Promise<{status:'ok'|'timeout'|'output-limit', code, signal, stdout, stderr,
 *                    stdoutTruncated, ms, pid}>}
 */
export function runDriver({
  dir,
  configPath,
  resultPath,
  phase = 'run',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  outputCapBytes = DEFAULT_OUTPUT_CAP,
  python = process.env.STUDIO_PYTHON || 'python3',
  onSpawn,
} = {}) {
  const sandbox = sandboxExecPath();
  const driverPath = path.join(dir, DRIVER_BASENAME);
  const command = sandbox ?? python;
  // -B only. Not -I/-E: isolated mode drops the script's own directory from sys.path, and
  // the driver has to be able to `import solution` from right beside itself.
  const args = sandbox
    ? ['-f', path.join(dir, 'sandbox.sb'), python, '-B', driverPath]
    : ['-B', driverPath];

  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: dir,
    TMPDIR: dir,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUNBUFFERED: '1',
    STUDIO_CONFIG: configPath,
    STUDIO_RESULT: resultPath,
    STUDIO_PHASE: phase,
  };

  const startedAt = process.hrtime.bigint();

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: dir,
        env,
        detached: true, // its own process group — see killGroup
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        status: 'spawn-failed',
        code: null,
        signal: null,
        stdout: '',
        stderr: String(err?.message ?? err),
        stdoutTruncated: false,
        ms: 0,
        pid: null,
      });
      return;
    }

    if (typeof onSpawn === 'function') onSpawn(child);

    const outChunks = [];
    const errChunks = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let status = 'ok';
    let settled = false;
    let killTimer = null;

    const stopHard = () => {
      killTimer = setTimeout(() => killGroup(child.pid, { signal: 'SIGKILL' }), 250);
      killTimer.unref?.();
      killGroup(child.pid, { signal: 'SIGTERM' });
    };

    const timer = setTimeout(() => {
      if (settled) return;
      status = 'timeout';
      stopHard();
    }, timeoutMs);
    timer.unref?.();

    const capture = (chunks, isOut) => (buf) => {
      if (isOut) {
        if (outBytes < outputCapBytes) {
          chunks.push(buf);
          outBytes += buf.length;
        } else {
          truncated = true;
        }
      } else {
        if (errBytes < outputCapBytes) {
          chunks.push(buf);
          errBytes += buf.length;
        } else {
          truncated = true;
        }
      }
      if (outBytes + errBytes > outputCapBytes && status === 'ok') {
        status = 'output-limit';
        truncated = true;
        stopHard();
      }
    };

    child.stdout.on('data', capture(outChunks, true));
    child.stderr.on('data', capture(errChunks, false));
    child.stdout.on('error', () => {});
    child.stderr.on('error', () => {});

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Whatever happened, make sure nothing the child spawned outlives it.
      killGroup(child.pid, { signal: 'SIGKILL' });
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({
        status,
        code,
        signal,
        stdout: Buffer.concat(outChunks).toString('utf8').slice(0, outputCapBytes),
        stderr: Buffer.concat(errChunks).toString('utf8').slice(0, outputCapBytes),
        stdoutTruncated: truncated,
        ms,
        pid: child.pid,
      });
    };

    child.on('error', (err) => {
      errChunks.push(Buffer.from(String(err?.message ?? err)));
      if (status === 'ok') status = 'spawn-failed';
      finish(null, null);
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/** Read the driver's result envelope. A missing or half-written file is not a crash. */
export async function readResult(resultPath) {
  let text;
  try {
    text = await fsp.readFile(resultPath, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
