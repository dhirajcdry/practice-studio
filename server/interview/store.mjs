import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, isSafeSlug } from '../http-util.mjs';
import { problemDir } from '../storage-layout.mjs';
export const validId = id => typeof id === 'string' && /^[0-9]{13}-[a-f0-9]{8}$/.test(id);
export function validate(slug, id = null) {
  if (!isSafeSlug(slug) || (id !== null && !validId(id))) throw new HttpError(400, 'BAD_REQUEST', 'Invalid interview identity.');
}
// State writes to one file go one at a time, so a heartbeat's small patch can never land
// between another write's read and rename. A full snapshot written by a long turn keeps the
// newer heartbeat already on disk: `lastSeenAt` only ever moves forward.
const writes = new Map();
function serialized(file, operation) {
  const next = (writes.get(file) || Promise.resolve()).catch(() => {}).then(operation);
  writes.set(file, next);
  next.finally(() => { if (writes.get(file) === next) writes.delete(file); }).catch(() => {});
  return next;
}
async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export class InterviewStore {
  constructor({ root }) { this.root = root; }
  base(slug) { validate(slug); return path.join(problemDir(this.root, slug), 'interviews'); }
  dir(slug, id) { validate(slug, id); return path.join(this.base(slug), id); }
  async create(slug, id, state) {
    await fs.mkdir(this.base(slug), { recursive: true });
    await fs.mkdir(this.dir(slug, id));
    await this.writeState(slug, id, state);
  }
  async writeState(slug, id, state) {
    const file = path.join(this.dir(slug, id), 'interview.json');
    return serialized(file, async () => {
      const disk = await readJson(file);
      if (Number.isFinite(disk?.lastSeenAt) && Number.isFinite(state.lastSeenAt) && disk.lastSeenAt > state.lastSeenAt) state.lastSeenAt = disk.lastSeenAt;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
    });
  }
  /** Read, change and write the state as one step; `change` returning false writes nothing. */
  async patchState(slug, id, change) {
    const file = path.join(this.dir(slug, id), 'interview.json');
    return serialized(file, async () => {
      const state = await readJson(file);
      if (!state || change(state) === false) return state;
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await fs.rename(temporary, file); }
      finally { await fs.rm(temporary, { force: true }); }
      return state;
    });
  }
  async readState(slug, id) {
    try { return JSON.parse(await fs.readFile(path.join(this.dir(slug, id), 'interview.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async append(slug, id, entry) {
    await fs.appendFile(path.join(this.dir(slug, id), 'turns.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' });
  }
  async readTurns(slug, id) {
    try {
      const raw = await fs.readFile(path.join(this.dir(slug, id), 'turns.jsonl'), 'utf8');
      // Do not repair or silently omit corrupt evidence. Report it so the raw file can
      // be investigated without presenting an incomplete record as complete.
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  // Questions asked about a finished interview live beside its record, never in it:
  // turns.jsonl stays exactly what happened during the interview.
  async appendFollowup(slug, id, entry) {
    await fs.appendFile(path.join(this.dir(slug, id), 'followups.jsonl'), JSON.stringify(entry) + '\n', { flag: 'a' });
  }
  async readFollowups(slug, id) {
    try {
      const raw = await fs.readFile(path.join(this.dir(slug, id), 'followups.jsonl'), 'utf8');
      return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
  async list(slug) {
    try { return (await fs.readdir(this.base(slug))).filter(validId).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
