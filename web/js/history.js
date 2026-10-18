// Recent conversations for the composer and its history popover. Opening a thread
// resumes the saved conversation without replacing the mounted composer.
import { el, replace } from './dom.js';
import { loadHistory } from './api.js';

/** "3 minutes ago", "yesterday 14:20", "Jul 24 09:15" — precision that matches distance. */
export function when(iso, now = new Date()) {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return '';
  const mins = Math.round((now.getTime() - at) / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;

  const date = new Date(at);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) return `today ${clock}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday ${clock}`;

  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${clock}`;
}

/** One line for a verdict, saying how close it got when it did not pass. */
export function verdictLine(s) {
  if (s.accepted) {
    const bits = [];
    if (Number.isFinite(s.runtimeMs)) bits.push(`${s.runtimeMs} ms`);
    if (Number.isFinite(s.beatsRuntimePct)) bits.push(`beats ${Math.round(s.beatsRuntimePct)}%`);
    if (Number.isFinite(s.memoryMb)) bits.push(`${s.memoryMb} MB`);
    return bits.join(' · ');
  }
  // A rejection is only useful with the number attached: 41/64 and 1/64 are different
  // mistakes, and "Wrong Answer" alone hides which one you made.
  if (Number.isFinite(s.testsPassed) && Number.isFinite(s.testsTotal)) {
    return `${s.testsPassed} of ${s.testsTotal} tests`;
  }
  return '';
}

export async function renderHistory(mount, { slug, onResume, current = null, disabled = false, limit = 5, now = new Date(), heading = 'Recent chats' }) {
  const data = await loadHistory(slug);
  if (!mount.isConnected) return;
  if (!data.ok) {
    replace(mount, el('p', { class: 'dim', text: 'Recent chats could not be loaded.' }));
    return;
  }
  const threads = data.threads;
  function paint(all = false) {
    const rows = (all ? threads : threads.slice(0, limit)).map(thread => el('button', {
      type: 'button', class: 'recent-chat hover-surface hover-divided', disabled,
      onclick: () => onResume(thread),
    }, [
      el('span', { class: 'recent-title', text: thread.turns[0]?.ask || 'Attempt review' }),
      el('span', { class: 'mono dim', text: `${when(thread.startedAt, now)} · ${thread.turns.length} turn${thread.turns.length === 1 ? '' : 's'}` }),
      thread.turns.some(t => t.kind === 'attempt-review') ? el('span', { class: 'submission-tag', text: 'Review' }) : null,
      thread.sessionId === current ? el('span', { class: 'submission-tag current', text: 'Current' }) : null,
    ]));
    replace(mount, threads.length ? [el('div', { class: 'chat-history-heading', text: heading === 'Past chats' ? `${heading} · ${threads.length}` : heading }), ...rows,
      !all && threads.length > limit ? el('button', { class: 'ws-mini', text: `Show all (${threads.length})`, onclick: () => paint(true) }) : null] : []);
  }
  paint();
}

// Calendar separators orient a reopened thread without explaining the composer.
export function threadDate(iso, now = new Date()) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '';
  const clock = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `Today ${clock}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `Yesterday ${clock}`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
