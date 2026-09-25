// What this problem remembers: every submission, and every conversation about it.
//
// Lives inside the coach panel rather than beside it, because the question it answers —
// "what happened last time I was here?" — is the same question the coach exists for. A
// separate tab would put the record of the teaching somewhere other than the teaching.
//
// Read-only by construction. Nothing here writes, deletes, or resubmits; the one action
// is resuming a past conversation, which is just the next turn of a thread that already
// exists. Everything rendered is escaped through the same markdown renderer the coach
// uses, because a stored coach answer is still model output.

import { el, clear, replace } from './dom.js';
import { renderMarkdown } from './markdown.js';
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

function codeBlock(code) {
  return el('pre', { class: 'hist-code' }, el('code', { text: code }));
}

/**
 * A collapsed row that opens in place. Nothing is fetched again to open it.
 *
 * `extra` sits beside the head rather than inside it — an action buried one expand deep
 * is an action nobody knows exists, and a button cannot be nested in a button.
 */
function disclosure(head, buildBody, { open = false, extra = null } = {}) {
  const body = el('div', { class: 'hist-body', hidden: !open });
  let built = open;
  if (open) body.append(buildBody());

  const button = el('button', {
    class: 'hist-head', type: 'button', 'aria-expanded': String(open),
    onclick: () => {
      const show = body.hidden;
      if (show && !built) { body.append(buildBody()); built = true; }
      body.hidden = !show;
      button.setAttribute('aria-expanded', String(show));
    },
  }, head);

  return el('div', { class: 'hist-item' }, [
    el('div', { class: 'hist-row' }, [button, extra].filter(Boolean)),
    body,
  ]);
}

function submissionRow(s, now) {
  const head = [
    el('span', { class: 'tag ' + (s.accepted ? 'easy' : 'hard'), text: s.accepted ? 'Accepted' : (s.verdict || 'Rejected') }),
    el('span', { class: 'mono dim hist-when', text: when(s.at, now) }),
    el('span', { class: 'mono dim hist-detail', text: verdictLine(s) }),
  ];

  return disclosure(head, () => {
    const parts = [];
    if (s.code) {
      parts.push(codeBlock(s.code));
    } else {
      // Submissions made before the code was kept, and any whose copy failed to write.
      // Saying so beats showing an empty box that looks like an empty solution.
      parts.push(el('p', { class: 'hist-note', text: 'The code for this submission was not kept — it predates the history view.' }));
    }
    if (s.submissionUrl) {
      parts.push(el('a', {
        class: 'hist-link mono', href: s.submissionUrl, target: '_blank', rel: 'noreferrer noopener',
        text: 'View on LeetCode ↗',
      }));
    }
    return el('div', { class: 'hist-sub' }, parts);
  });
}

function threadRow(thread, now, { onResume }) {
  const first = thread.turns[0];
  const isReview = thread.turns.some((t) => t.kind === 'attempt-review');
  const label = isReview ? 'Attempt review' : (first?.ask || 'Conversation');

  const head = [
    el('span', { class: 'tag quiet', text: isReview ? 'Review' : 'Chat' }),
    el('span', { class: 'mono dim hist-when', text: when(thread.startedAt, now) }),
    el('span', { class: 'hist-title', text: label.length > 70 ? `${label.slice(0, 70)}…` : label }),
    el('span', { class: 'mono dim hist-detail', text: `${thread.turns.length} turn${thread.turns.length === 1 ? '' : 's'}` }),
  ];

  return disclosure(head, () => {
    const parts = [];
    for (const turn of thread.turns) {
      if (turn.ask && turn.ask.trim()) {
        parts.push(el('div', { class: 'hist-ask' }, el('p', { text: turn.ask })));
      } else if (turn.kind === 'attempt-review') {
        parts.push(el('div', { class: 'mono dim hist-marker', text: 'Attempt ended — reviewed end to end' }));
      }
      const answer = el('div', { class: 'hist-answer rich' });
      answer.append(renderMarkdown(turn.answer || ''));
      parts.push(answer);
    }
    if (!thread.resumable) {
      parts.push(el('p', { class: 'hist-note', text: 'This conversation cannot be continued — it has no session left to resume.' }));
    }
    return el('div', { class: 'hist-thread' }, parts);
  }, {
    extra: thread.resumable
      ? el('button', {
        class: 'ws-mini hist-resume', type: 'button', text: 'Continue',
        title: 'Reopen this conversation and keep talking in it',
        onclick: () => onResume(thread),
      })
      : null,
  });
}

/**
 * Render the history for one problem into `mount`.
 * @param {{slug:string, onResume:(thread:object)=>void}} options
 */
export function renderHistory(mount, { slug, onResume, now = new Date() }) {
  replace(mount, el('div', { class: 'mono dim hist-loading', text: 'Loading…' }));

  return loadHistory(slug).then((data) => {
    clear(mount);
    if (!data.ok) {
      mount.append(el('p', { class: 'hist-note', text: 'The history could not be loaded — the studio server is not answering.' }));
      return;
    }
    if (!data.submissions.length && !data.threads.length) {
      mount.append(el('p', { class: 'hist-note', text: 'Nothing yet. Submissions and conversations for this problem will collect here.' }));
      return;
    }

    if (data.submissions.length) {
      mount.append(el('div', { class: 'mono dim hist-section', text: `Submissions · ${data.submissions.length}` }));
      for (const s of data.submissions) mount.append(submissionRow(s, now));
    }
    if (data.threads.length) {
      mount.append(el('div', { class: 'mono dim hist-section', text: `Conversations · ${data.threads.length}` }));
      for (const t of data.threads) mount.append(threadRow(t, now, { onResume }));
    }
  });
}
