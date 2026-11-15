// A chat's title rules, shared by the server (which stores titles) and the page (which
// labels a chat before the server has listed it). Pure functions, no I/O.

export const TITLE_MIN = 3;
export const TITLE_MAX = 60;
const FALLBACK_MAX = 60;

/** One plain line, 3–60 characters, no markdown. Returns the title Studio would store. */
export function validateChatTitle(raw) {
  if (typeof raw !== 'string') return { ok: false, message: 'A chat title must be text.' };
  if (/[\r\n]/.test(raw.trim())) return { ok: false, message: 'A chat title is one line.' };
  const title = raw.replace(/\s+/g, ' ').trim().replace(/^["'“‘]+|["'”’]+$/g, '').trim();
  if (title.length < TITLE_MIN) return { ok: false, message: `A chat title needs at least ${TITLE_MIN} characters.` };
  if (title.length > TITLE_MAX) return { ok: false, message: `A chat title is at most ${TITLE_MAX} characters; this one is ${title.length}.` };
  if (/[`*_#<>\[\]|~]/.test(title) || /^\s*[-+>]\s/.test(title)) return { ok: false, message: 'A chat title is plain words: no markdown, code or HTML.' };
  // Control characters never belong in a label someone reads.
  if (/[\u0000-\u001f\u007f]/.test(title)) return { ok: false, message: 'A chat title cannot contain control characters.' };
  return { ok: true, title };
}

/**
 * A readable label from the learner's own first message, for a chat nobody named.
 * Only ever shortens and tidies what they wrote: it never adds a claim the message
 * does not make.
 */
export function fallbackChatTitle(message, max = FALLBACK_MAX) {
  let text = String(message ?? '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')   // fenced code is context, not a topic
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  // "this.. just hints.. why" reads as separate sentences, so it becomes one.
  text = text.replace(/\s*(?:\.{2,}|…)+\s*/g, '. ').replace(/([!?,;:])\1+/g, '$1').trim();
  text = text.replace(/^[.\s]+/, '').replace(/\.\s*$/, '');
  if (!text) return '';
  text = text.replace(/(^|[.!?]\s+)(\p{Ll})/gu, (_, lead, letter) => lead + letter.toUpperCase());
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s.,;:!?-]+$/, '') + '…';
}

