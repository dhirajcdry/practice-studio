import fs from 'node:fs/promises';

/** Stop a check child and remove its disposable Chrome profile safely. */
export async function cleanupChrome(child, profile) {
  if (child && child.exitCode === null && child.signalCode === null) {
    await new Promise((resolve, reject) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      const timeout = setTimeout(() => {
        clearTimeout(force); reject(new Error('Chrome did not exit; its profile was retained.'));
      }, 6000);
      child.once('exit', () => { clearTimeout(force); clearTimeout(timeout); resolve(); });
      child.kill();
    });
  }
  if (profile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
