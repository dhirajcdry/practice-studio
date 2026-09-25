// The session event log: `~/LeetCodeTutor/problems/<slug>/sessions/<id>.jsonl`.
//
// Append-only. Nothing in this file ever opens a session log for writing without 'a', and
// nothing ever rewrites a line. That is the whole point: this log is the only record of
// what actually happened, and a log you edit is a log you cannot trust. A malformed line
// (hand-edited, or a torn write from a power cut) is skipped on read rather than being
// "repaired" — losing one event is better than silently rewriting history.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** The event vocabulary from the contract. Unknown types are rejected rather than stored,
 *  so a client typo does not quietly create a category nobody ever queries. */
export const EVENT_TYPES = Object.freeze([
  'problem_opened',
  'first_keystroke',
  'ran_locally',
  'run_result',
  'revealed_solution',
  'revealed_article',
  'asked_coach',
  'recorded_audio',
  'submitted',
  'verdict',
  // An attempt is the window between these two: press record, solve, press stop. It is
  // the unit an interview is graded in, so it is the unit the coach reviews.
  'attempt_started',
  'attempt_ended',
]);

const EVENT_TYPE_SET = new Set(EVENT_TYPES);

/** A gap longer than this starts a new session. Walking away for lunch and coming back is
 *  two sittings, and reporting it as one 90-minute solve would be a lie. */
export const SESSION_GAP_MS = 45 * 60 * 1000;

export function isKnownEventType(type) {
  return typeof type === 'string' && EVENT_TYPE_SET.has(type);
}

/** ISO-8601 with the machine's real UTC offset, e.g. 2026-07-25T11:54:05.818-07:00.
 *  The contract asks for a timezone; "Z" would be correct but throws away the fact that
 *  the user was practising at 11pm, which is exactly the kind of thing this log is for. */
export function isoWithOffset(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** Session ids are sortable and filename-safe: 2026-07-25T18-54-05-818Z. */
export function newSessionId(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// One append queue per absolute file path. Node's fs.appendFile with O_APPEND is already
// atomic for writes under PIPE_BUF on POSIX, but a session event carrying a full traceback
// is not small, so concurrent appends are serialised in-process as well. Cross-process
// safety still rests on O_APPEND, which is the right primitive for a single-line record.
const appendQueues = new Map();

function enqueueAppend(file, line) {
  const previous = appendQueues.get(file) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => fsp.appendFile(file, line, { encoding: 'utf8', flag: 'a' }));
  // The queue holds a never-rejecting tail so one failed append cannot poison the chain.
  appendQueues.set(file, next.catch(() => {}));
  return next;
}

/**
 * Watchers of the event log. Module-level rather than per-instance because several
 * modules construct their own SessionLog and every one of them should be observable.
 */
const appendListeners = new Set();

export function onSessionEvent(listener) {
  appendListeners.add(listener);
  return () => appendListeners.delete(listener);
}

export class SessionLog {
  /** @param {{ root: string }} opts root is `~/LeetCodeTutor` */
  constructor({ root }) {
    this.root = root;
  }

  problemDir(slug) {
    return path.join(this.root, 'problems', slug);
  }

  sessionsDir(slug) {
    return path.join(this.problemDir(slug), 'sessions');
  }

  /** Session files, oldest first. Missing directory is not an error — it just means the
   *  user has never opened this problem. */
  async listSessionFiles(slug) {
    const dir = this.sessionsDir(slug);
    let names;
    try {
      names = await fsp.readdir(dir);
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith('.jsonl'))
      .sort()
      .map((n) => ({ id: n.slice(0, -'.jsonl'.length), file: path.join(dir, n) }));
  }

  /** Parse one .jsonl file. Unparseable lines are skipped, never rewritten. */
  async readSessionFile(file) {
    let raw;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    const events = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object') events.push(parsed);
      } catch {
        // A torn or hand-edited line. Skipping it loses one event; "fixing" it would
        // lose the guarantee that this file is what was actually written.
      }
    }
    return events;
  }

  /** Every session for a problem, in the contract's `GET /api/sessions/:slug` shape. */
  async readSessions(slug) {
    const files = await this.listSessionFiles(slug);
    const sessions = [];
    for (const { id, file } of files) {
      const events = await this.readSessionFile(file);
      sessions.push({
        id,
        startedAt: events[0]?.at ?? null,
        endedAt: events[events.length - 1]?.at ?? null,
        events,
      });
    }
    return sessions;
  }

  /**
   * The session an event belongs to: the newest one, unless it has gone quiet for longer
   * than SESSION_GAP_MS or the event is a `problem_opened` (which always starts a sitting).
   * @returns {Promise<string>} session id
   */
  async currentSessionId(slug, { now = Date.now(), startNew = false } = {}) {
    const files = await this.listSessionFiles(slug);
    const latest = files[files.length - 1];
    if (!latest || startNew) return newSessionId(new Date(now));

    const events = await this.readSessionFile(latest.file);
    const lastAt = events[events.length - 1]?.at;
    if (!lastAt) return latest.id;
    const lastMs = Date.parse(lastAt);
    if (Number.isNaN(lastMs) || now - lastMs > SESSION_GAP_MS) {
      return newSessionId(new Date(now));
    }
    return latest.id;
  }

  /**
   * The attempt currently open for this problem, or null.
   *
   * An `attempt_started` with no `attempt_ended` after it. Read from the log rather than
   * held in memory, so a server restart mid-attempt does not lose the thread.
   */
  async openAttemptId(slug) {
    const files = await this.listSessionFiles(slug);
    const latest = files[files.length - 1];
    if (!latest) return null;
    let open = null;
    for (const event of await this.readSessionFile(latest.file)) {
      if (event.type === 'attempt_started' && event.data?.attemptId) open = event.data.attemptId;
      else if (event.type === 'attempt_ended') open = null;
    }
    return open;
  }

  /**
   * Append one event. The only write path for these files.
   *
   * Every event that happens while an attempt is open is stamped with its id. This used to
   * be the caller's job and the caller could not do it: the recorder holds the attempt id
   * in a module-private variable, so `ran_locally` and `submitted` went out as `{}` and
   * nothing said which attempt a run belonged to. Reconstructing an attempt then meant a
   * time-window join, which is sound but which nobody was ever going to write. Stamping
   * here means it cannot be forgotten and cannot drift.
   *
   * @param {string} slug
   * @param {string} type one of EVENT_TYPES
   * @param {object} [data]
   * @returns {Promise<{ sessionId: string, event: object }>}
   */
  async appendEvent(slug, type, data, { now = Date.now() } = {}) {
    if (!isKnownEventType(type)) {
      throw new Error(`Unknown session event type "${type}".`);
    }
    const sessionId = await this.currentSessionId(slug, {
      now,
      startNew: type === 'problem_opened',
    });
    const dir = this.sessionsDir(slug);
    await fsp.mkdir(dir, { recursive: true });

    const event = { at: isoWithOffset(new Date(now)), type };
    if (data !== undefined && data !== null) event.data = data;

    // `attempt_ended` is deliberately included — it names the attempt it closes — and an
    // id the caller supplied is never overwritten, because the caller knows things this
    // does not (a late verdict belongs to the attempt that submitted it).
    if (type !== 'attempt_started' && !event.data?.attemptId) {
      const open = await this.openAttemptId(slug);
      if (open) event.data = { ...(event.data ?? {}), attemptId: open };
    }

    const file = path.join(dir, `${sessionId}.jsonl`);
    // JSON.stringify cannot emit a bare newline, so one event is guaranteed to be one line.
    await enqueueAppend(file, `${JSON.stringify(event)}\n`);

    // Every meaningful thing that happens passes through here, which makes it the one
    // place worth watching. Listeners must not be able to break the write that triggered
    // them — the log is the record, a mirror of it is a convenience.
    for (const listener of appendListeners) {
      try { listener(slug, event); } catch { /* a broken listener is not a lost event */ }
    }
    return { sessionId, event };
  }

  /** The most recent event of a given type across the current session, for context
   *  assembly. Returns null when there is none. */
  async latestEventOfType(slug, type) {
    const files = await this.listSessionFiles(slug);
    for (let i = files.length - 1; i >= 0; i -= 1) {
      const events = await this.readSessionFile(files[i].file);
      for (let j = events.length - 1; j >= 0; j -= 1) {
        if (events[j].type === type) return events[j];
      }
    }
    return null;
  }

  /** Events of the newest session only — "this sitting". */
  async currentSessionEvents(slug) {
    const files = await this.listSessionFiles(slug);
    const latest = files[files.length - 1];
    if (!latest) return { id: null, events: [] };
    return { id: latest.id, events: await this.readSessionFile(latest.file) };
  }
}

/**
 * Where the per-problem `claude` session id is remembered, so opening a problem you
 * touched last week resumes THAT conversation.
 *
 * Deliberately its own file: `meta.json` belongs to the server's problem store and
 * `sessions/*.jsonl` is append-only, so neither is a place to keep a mutable pointer.
 */
export class CoachSessionStore {
  constructor({ root }) {
    this.root = root;
  }

  file(slug) {
    return path.join(this.root, 'problems', slug, 'coach-session.json');
  }

  async read(slug) {
    try {
      const raw = await fsp.readFile(this.file(slug), 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.sessionId === 'string' && parsed.sessionId !== '') {
        return parsed;
      }
      return null;
    } catch {
      // Missing or corrupt: start a fresh conversation rather than failing the turn.
      return null;
    }
  }

  async write(slug, record) {
    const file = this.file(slug);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, file);
  }

  /** Record that a turn completed against `sessionId`. */
  async remember(slug, sessionId) {
    const existing = (await this.read(slug)) ?? {};
    await this.write(slug, {
      sessionId,
      createdAt: existing.createdAt ?? isoWithOffset(),
      updatedAt: isoWithOffset(),
      turns: (Number(existing.turns) || 0) + 1,
    });
  }

  /** Forget a session id that the CLI refused to resume. */
  async forget(slug) {
    try {
      await fsp.unlink(this.file(slug));
    } catch {
      /* nothing to forget */
    }
  }
}

/** Synchronous existence check, used only where an async hop buys nothing. */
export function existsSync(file) {
  try {
    fs.accessSync(file);
    return true;
  } catch {
    return false;
  }
}
