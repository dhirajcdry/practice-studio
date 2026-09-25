// Keeping what the coach said.
//
// Until now the only trace of a conversation was an `asked_coach` event holding the
// question. The answer — which is the part worth rereading, and the part that names the
// mistake — existed only in the browser tab until it was closed. A tutor whose teaching
// evaporates cannot be revisited, and "what did it tell me about this problem last time"
// is the most obvious question to ask of it.
//
// One append-only file per problem, one record per completed turn. Written by the server
// after the turn finishes, because that is the moment both halves and the CLI session id
// are all known. The coach never writes here: this is the record OF it, not BY it.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { isoWithOffset } from './sessions.mjs';

const MAX_STORED_CHARS = 200_000; // a turn this long is a bug, not a lesson

export function chatFile(root, slug) {
  return path.join(root, 'problems', slug, 'chats.jsonl');
}

/**
 * Append one completed turn.
 *
 * Never throws: losing the transcript of a turn must not turn a delivered answer into an
 * error at the user. It is a record, and a record that breaks the thing it records is
 * worse than no record.
 */
export async function appendTurn({ root, slug, turn, log = console }) {
  if (!root || !slug) return { written: false, reason: 'no workspace root' };
  const answer = String(turn.answer ?? '');
  if (!answer.trim() && !String(turn.ask ?? '').trim()) {
    return { written: false, reason: 'nothing was said either way' };
  }

  const record = {
    at: turn.at ?? isoWithOffset(),
    sessionId: turn.sessionId ?? null,
    kind: turn.kind === 'attempt-review' ? 'attempt-review' : 'question',
    attemptId: turn.attemptId ?? null,
    ask: String(turn.ask ?? '').slice(0, MAX_STORED_CHARS),
    answer: answer.slice(0, MAX_STORED_CHARS),
    tools: Array.isArray(turn.tools) ? turn.tools.slice(0, 60) : [],
    // The answer was cut short — kept anyway, but never passed off as a whole one.
    ...(turn.stopped ? { stopped: true } : {}),
  };

  const file = chatFile(root, slug);
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, 'utf8');
    return { written: true };
  } catch (err) {
    log?.warn?.(`[coach] transcript not saved for ${slug}: ${err.message}`);
    return { written: false, reason: err.message };
  }
}

/** Every stored turn, oldest first. A torn line is skipped, never repaired. */
export async function readTurns({ root, slug }) {
  let raw;
  try {
    raw = await fsp.readFile(chatFile(root, slug), 'utf8');
  } catch {
    return [];
  }
  const turns = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') turns.push(parsed);
    } catch {
      // A half-written line from a crash. Skipping it loses one turn; "fixing" it would
      // lose the guarantee that this file is what was actually said.
    }
  }
  return turns;
}

/**
 * Turns grouped into the conversations they belonged to.
 *
 * A thread is one CLI session — which is exactly one attempt, since starting an attempt
 * starts a fresh thread. Grouping by anything else (by day, by problem) would merge two
 * separate reasonings into one transcript and make "resume" ambiguous.
 */
export async function readThreads({ root, slug }) {
  const turns = await readTurns({ root, slug });
  const threads = new Map();

  for (const turn of turns) {
    // Turns from before session ids were recorded, or from a CLI that refused to resume,
    // each stand alone rather than being merged into whatever came before them.
    const key = turn.sessionId || `orphan:${turn.at}`;
    if (!threads.has(key)) {
      threads.set(key, {
        sessionId: turn.sessionId ?? null,
        resumable: Boolean(turn.sessionId),
        attemptId: turn.attemptId ?? null,
        startedAt: turn.at,
        endedAt: turn.at,
        turns: [],
      });
    }
    const thread = threads.get(key);
    thread.endedAt = turn.at;
    if (!thread.attemptId && turn.attemptId) thread.attemptId = turn.attemptId;
    thread.turns.push(turn);
  }

  // Newest first: the conversation you want is almost always the last one.
  return [...threads.values()].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
}
