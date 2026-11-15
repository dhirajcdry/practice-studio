// What a chat is called.
//
// A conversation's name is Studio's metadata about it, not part of what was said, so it
// lives beside the transcript rather than in it: `chats.jsonl` stays an append-only record
// of turns and is never rewritten to rename anything. The coach names a chat through the
// `name_chat` tool during an ordinary turn (Studio validates and writes it here); the
// learner can rename it by clicking its title above the conversation. A learner's title is theirs: the coach cannot
// replace it. A chat nobody named is shown by a cleaned-up first question, computed when
// the list is read and never stored.

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { problemDir } from '../storage-layout.mjs';
import { TITLE_MIN, TITLE_MAX, validateChatTitle, fallbackChatTitle } from '../../web/js/chat-title.js';

export { TITLE_MIN, TITLE_MAX, validateChatTitle, fallbackChatTitle };

const MAX_SESSION_ID = 200;

export function titlesFile(root, slug) {
  return path.join(problemDir(root, slug), 'chat-titles.json');
}

const validSession = id => typeof id === 'string' && id.length > 0 && id.length <= MAX_SESSION_ID && !id.startsWith('orphan:');

/** `{ [sessionId]: { title, by, at } }`. A missing or unreadable file is no titles. */
export async function readChatTitles(root, slug) {
  try {
    const parsed = JSON.parse(await fsp.readFile(titlesFile(root, slug), 'utf8'));
    const titles = parsed && typeof parsed.titles === 'object' && parsed.titles ? parsed.titles : {};
    const out = {};
    for (const [id, entry] of Object.entries(titles)) {
      if (!validSession(id) || typeof entry?.title !== 'string') continue;
      const checked = validateChatTitle(entry.title);
      if (checked.ok) out[id] = { title: checked.title, by: entry.by === 'learner' ? 'learner' : 'coach', at: String(entry.at || '') };
    }
    return out;
  } catch {
    return {};
  }
}

// One writer per file in this process; the server is the only writer.
const locks = new Map();
function withLock(file, fn) {
  const previous = locks.get(file) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  locks.set(file, next.catch(() => {}));
  return next;
}

/**
 * Name one chat. `by` is 'coach' (the name_chat tool) or 'learner' (a manual rename).
 * The coach cannot replace a learner's title; the learner can replace anything.
 * @returns {Promise<{ok:true, title:string, changed:boolean} | {ok:false, status:number, message:string}>}
 */
export async function setChatTitle(root, slug, sessionId, rawTitle, { by = 'coach', now = () => new Date() } = {}) {
  if (!validSession(sessionId)) return { ok: false, status: 400, message: 'This chat has no saved identity to name.' };
  const checked = validateChatTitle(rawTitle);
  if (!checked.ok) return { ok: false, status: 400, message: checked.message };
  const file = titlesFile(root, slug);
  return withLock(file, async () => {
    const titles = await readChatTitles(root, slug);
    const existing = titles[sessionId];
    if (by !== 'learner' && existing?.by === 'learner') {
      return { ok: false, status: 409, message: `The learner named this chat "${existing.title}". Keep their title.` };
    }
    if (existing?.title === checked.title && (existing.by === by || by !== 'learner')) return { ok: true, title: checked.title, changed: false };
    titles[sessionId] = { title: checked.title, by: by === 'learner' ? 'learner' : 'coach', at: now().toISOString() };
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, titles }, null, 2) + '\n', { mode: 0o600 });
      await fsp.rename(tmp, file);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
    return { ok: true, title: checked.title, changed: true };
  });
}

/** What the list shows for one thread, and where that came from. */
export function displayTitle(thread, titles = {}) {
  const named = thread.sessionId ? titles[thread.sessionId] : null;
  if (named) return { title: named.title, titleSource: named.by };
  for (const turn of thread.turns || []) {
    const cleaned = fallbackChatTitle(turn.ask);
    if (cleaned) return { title: cleaned, titleSource: 'message' };
    if (String(turn.ask ?? '').trim()) return { title: 'Code question', titleSource: 'message' };
  }
  return { title: (thread.turns || []).some(turn => turn.kind === 'attempt-review') ? 'Attempt review' : 'Conversation', titleSource: 'message' };
}
