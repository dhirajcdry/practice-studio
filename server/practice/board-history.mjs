import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_ELEMENTS = 2000;
const MAX_BYTES = 1_500_000;

function sceneText(elements) {
  if (!Array.isArray(elements) || elements.length > MAX_ELEMENTS || elements.some(e => !e || typeof e !== 'object' || Array.isArray(e))) {
    throw new Error('The board history scene is invalid.');
  }
  const text = JSON.stringify(elements);
  if (text.length > MAX_BYTES) throw new Error('The board history scene is too large.');
  return text;
}

export function sceneHash(elements) {
  return crypto.createHash('sha256').update(sceneText(elements)).digest('hex');
}

async function readExisting(file) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('The saved board is corrupted.');
    sceneText(parsed);
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('The saved board is corrupted.');
    throw error;
  }
}

/** Preserve a scene by content hash. Existing history is immutable and deduplicated. */
export async function archiveBoardScene(directory, elements) {
  const text = sceneText(elements);
  const hash = crypto.createHash('sha256').update(text).digest('hex');
  const history = path.join(directory, 'board-history');
  await fs.mkdir(history, { recursive: true });
  const file = path.join(history, `${hash}.json`);
  // Publish a complete snapshot atomically. An interrupted write must not leave
  // a partial file that future saves mistake for an archived scene.
  const temporary = path.join(history, `.${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, text + '\n', { flag: 'wx' });
    try { await fs.link(temporary, file); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (await fs.readFile(file, 'utf8') !== text + '\n') throw new Error('The board history snapshot is corrupted.');
    }
  } finally { await fs.rm(temporary, { force: true }); }
  return { hash, file };
}

/** Archive both scenes before the current board can be replaced. Caller owns the write lock. */
export async function preserveBeforeBoardWrite(directory, nextElements) {
  sceneText(nextElements);
  const file = path.join(directory, 'elements.json');
  const previous = await readExisting(file);
  if (previous) await archiveBoardScene(directory, previous);
  await archiveBoardScene(directory, nextElements);
  return previous;
}
