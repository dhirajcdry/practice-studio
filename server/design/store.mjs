// Where a system design interview is kept.
//
//   ~/LeetCodeTutor/design/<interviewId>/
//     interview.json      the state machine — phase, counts, curveball
//     turns.jsonl         append-only: every question asked and every answer given
//     scenes/<n>.json     the canvas, as it stood, each time it changed
//     interview.md        derived; regenerated from the above and never read back
//
// Two properties, both inherited from the attempt recorder and both load-bearing here.
//
// APPEND-ONLY WHERE IT IS THE RECORD. turns.jsonl and scenes/ are written once and never
// rewritten. They are the only evidence of what was actually asked and drawn, and a
// debrief that grades an edited record grades nothing.
//
// DERIVED WHERE IT IS A VIEW. interview.md is rebuilt from the raw stores, so a bug in
// the renderer costs a regeneration and never a recording.
//
// interview.json is the exception and is deliberately mutable: it is the resumable
// position of the machine, not a record of events. Losing it costs the phase counter,
// which turns.jsonl can rebuild.

import fsp from 'node:fs/promises';
import path from 'node:path';

/** Interview ids are sortable and filename-safe, like session ids. */
export function newInterviewId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

const SAFE_ID = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}-[0-9]{3}Z$/;

/** Never let a request name a directory. */
export function isSafeInterviewId(id) {
  return typeof id === 'string' && SAFE_ID.test(id);
}

export class DesignStore {
  /** @param {{root: string}} opts root is `~/LeetCodeTutor` */
  constructor({ root }) {
    this.root = root;
  }

  dir(id) {
    return path.join(this.root, 'design', id);
  }

  async create(id, state) {
    const dir = this.dir(id);
    await fsp.mkdir(path.join(dir, 'scenes'), { recursive: true });
    await this.writeState(id, state);
    return dir;
  }

  async writeState(id, state) {
    const file = path.join(this.dir(id), 'interview.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);   // a torn state file would lose the interview
  }

  async readState(id) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.dir(id), 'interview.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  /** One turn. Append-only: the record of what was asked and answered. */
  async appendTurn(id, turn) {
    await fsp.appendFile(
      path.join(this.dir(id), 'turns.jsonl'),
      `${JSON.stringify(turn)}\n`,
      { encoding: 'utf8', flag: 'a' },
    );
  }

  async readTurns(id) {
    let raw;
    try {
      raw = await fsp.readFile(path.join(this.dir(id), 'turns.jsonl'), 'utf8');
    } catch {
      return [];
    }
    const out = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      // A torn line loses one turn. "Repairing" it would lose the guarantee that this
      // file is what was written.
      try { out.push(JSON.parse(t)); } catch { /* skip */ }
    }
    return out;
  }

  /** The canvas as it stood. Numbered so the order survives, and never overwritten. */
  async writeScene(id, index, elements) {
    const file = path.join(this.dir(id), 'scenes', `${String(index).padStart(4, '0')}.json`);
    await fsp.writeFile(file, JSON.stringify({ at: new Date().toISOString(), elements }), 'utf8');
    return file;
  }

  async readScenes(id) {
    const dir = path.join(this.dir(id), 'scenes');
    let names;
    try {
      names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      try {
        out.push({ name, ...JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8')) });
      } catch { /* skip an unreadable snapshot rather than fail the debrief */ }
    }
    return out;
  }

  /** Every interview, newest last. */
  async list() {
    try {
      return (await fsp.readdir(path.join(this.root, 'design')))
        .filter(isSafeInterviewId)
        .sort();
    } catch {
      return [];
    }
  }

  /** The one-line problem of each past interview, so a new one is not a repeat. */
  async pastPrompts(limit = 20) {
    const ids = (await this.list()).slice(-limit);
    const out = [];
    for (const id of ids) {
      const state = await this.readState(id);
      if (state?.prompt) out.push(state.prompt);
    }
    return out;
  }
}
