// Write the attempt document the moment the attempt ends.
//
// A file you have to remember to regenerate is a file that is out of date when you need
// it. `attempt_ended` is the one unambiguous "this is finished" signal in the whole app,
// so it is what triggers the write.
//
// Best-effort, and deliberately so: the raw logs are already on disk by the time this
// runs, so a failure here costs a rendering that `npm run attempts` recreates. It must
// never be able to break the event write that triggered it.

import fsp from 'node:fs/promises';
import path from 'node:path';

import { onSessionEvent } from '../coach/sessions.mjs';
import { gatherAttempt } from './assemble.mjs';
import { renderAttempt } from './render.mjs';

/** ISO instants make poor directory names off macOS. */
export function dirNameFor(attemptId) {
  return String(attemptId).replace(/[:.]/g, '-');
}

export async function writeAttemptDoc({ root, slug, attemptId, title = null }) {
  const attempt = await gatherAttempt({ root, slug, attemptId });
  if (!attempt) return null;
  const outDir = path.join(root, 'problems', slug, 'attempts', dirNameFor(attemptId));
  await fsp.mkdir(outDir, { recursive: true });
  const file = path.join(outDir, 'attempt.md');
  await fsp.writeFile(file, renderAttempt(attempt, { title }), 'utf8');
  return file;
}

let armed = false;

export function armAttemptWriter({ root, catalog = null, log = console }) {
  if (armed) return;
  armed = true;
  onSessionEvent((slug, event) => {
    if (event.type !== 'attempt_ended') return;
    const attemptId = event.data?.attemptId;
    if (!attemptId) return;
    // Deliberately not awaited: the listener runs inside the event append, and the append
    // is the thing that must not be delayed or broken.
    writeAttemptDoc({ root, slug, attemptId, title: catalog?.get?.(slug)?.title ?? null })
      .then((file) => { if (file) log.warn?.(`[attempts] wrote ${file}`); })
      .catch((err) => log.warn?.(`[attempts] could not assemble ${slug}/${attemptId}: ${err.message}`));
  });
}
