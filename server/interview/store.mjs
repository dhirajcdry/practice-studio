import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { HttpError, isSafeSlug } from '../http-util.mjs';
export const validId = id => typeof id === 'string' && /^[0-9]{13}-[a-f0-9]{8}$/.test(id);
export function validate(slug, id = null) {
  if (!isSafeSlug(slug) || (id !== null && !validId(id))) throw new HttpError(400, 'BAD_REQUEST', 'Invalid interview identity.');
}
export class InterviewStore {
  constructor({ root }) { this.root = root; }
  base(slug) { validate(slug); return path.join(this.root, 'problems', slug, 'interviews'); }
  dir(slug, id) { validate(slug, id); return path.join(this.base(slug), id); }
  async create(slug, id, state) {
    await fs.mkdir(this.base(slug), { recursive: true });
    await fs.mkdir(this.dir(slug, id));
    await this.writeState(slug, id, state);
  }
  async writeState(slug, id, state) {
    const file = path.join(this.dir(slug, id), 'interview.json');
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n'); await fs.rename(temporary, file); }
    finally { await fs.rm(temporary, { force: true }); }
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
  async list(slug) {
    try { return (await fs.readdir(this.base(slug))).filter(validId).sort(); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }
}
