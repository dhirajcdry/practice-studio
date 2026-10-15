// Small, defensive localStorage drafts for conversational composers.
export const DRAFT_PREFIX = 'studio.coach.draft.v1:';

const listeners = new Map();
const memory = new Map();
export function watchDraft(slug, listener) {
  if (!listeners.has(slug)) listeners.set(slug, new Set());
  listeners.get(slug).add(listener);
  return () => {
    listeners.get(slug)?.delete(listener);
    if (!listeners.get(slug)?.size) listeners.delete(slug);
  };
}
function notify(slug, text) { for (const listener of listeners.get(slug) || []) listener(text); }

function key(slug) { return DRAFT_PREFIX + String(slug || ''); }
export function readDraft(slug) {
  if (memory.has(slug)) return memory.get(slug);
  try {
    const raw = localStorage.getItem(key(slug));
    const value = raw ? JSON.parse(raw) : null;
    return typeof value?.text === 'string' ? value : null;
  } catch { return memory.get(slug) || null; }
}
export function saveDraft(slug, text) {
  const value = String(text ?? '');
  const draft = { text: value, updatedAt: new Date().toISOString() };
  memory.set(slug, draft);
  try { localStorage.setItem(key(slug), JSON.stringify(draft)); } catch { /* retain this page's draft */ }
  notify(slug, value);
  return value;
}
export function clearDraft(slug) {
  memory.set(slug, null);
  try { localStorage.removeItem(key(slug)); } catch { /* private browsing */ }
  notify(slug, '');
}

// Read at delivery time: the learner may already have returned and typed more while
// an old panel's final transcription was still in flight. A captured textarea is stale.
export function appendDraft(slug, text) {
  const existing = readDraft(slug)?.text || '';
  return saveDraft(slug, existing + (existing && !/\s$/.test(existing) ? ' ' : '') + text);
}
