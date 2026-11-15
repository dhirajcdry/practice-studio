// A short note about something that just happened, on the Accepted card's surface
// (`.fx-toast` in fx.css), anchored inside the pane it is about.
//
// It never takes focus: its buttons keep focus where it was when clicked, so a note over
// the editor cannot cost the cursor or a shortcut. It is announced politely, leaves after
// a few seconds (held while the pointer or focus is on it), and has its own dismiss.
import { el } from '../dom.js';
import { icon } from './icon.js';

const TOAST_MS = 4000;

/**
 * @param {{ head: string, body?: string, action?: { label: string, onClick: () => void },
 *   host: HTMLElement, ms?: number, onDismiss?: () => void }} options
 * @returns {{ node: HTMLElement, dismiss: () => void }}
 */
export function showToast({ head, body = '', action = null, host, ms = TOAST_MS, onDismiss = null }) {
  let timer = 0, gone = false;
  const keepFocus = event => event.preventDefault();       // a click must not move focus here
  const button = (attrs, children) => el('button', { type: 'button', onmousedown: keepFocus, ...attrs }, children);
  const headEl = el('strong', { class: 'fx-toast-head' });
  const bodyEl = body ? el('span', { class: 'fx-toast-meta is-filled' }) : null;
  const node = el('div', { class: 'fx-toast fx-toast--note', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }, [
    el('span', { class: 'fx-toast-text' }, [headEl, bodyEl]),
    action ? button({ class: 'btn btn--quiet fx-toast-action', text: action.label, onclick: () => { action.onClick(); dismiss(); } }) : null,
    button({ class: 'btn btn--icon fx-toast-x', 'aria-label': 'Dismiss', onclick: () => dismiss() }, icon('close', 14)),
  ]);
  function dismiss() {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 200);
    onDismiss?.();
  }
  const hold = () => clearTimeout(timer);
  const release = () => { clearTimeout(timer); if (!gone && !node.matches(':hover, :focus-within')) timer = setTimeout(dismiss, ms); };
  node.addEventListener('pointerenter', hold);
  node.addEventListener('pointerleave', release);
  node.addEventListener('focusin', hold);
  node.addEventListener('focusout', release);
  host.append(node);
  // Text after insertion, so the live region announces it; two frames so the entrance plays.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (gone) return;
    headEl.textContent = head;
    if (bodyEl) bodyEl.textContent = body;
    node.classList.add('is-in');
  }));
  timer = setTimeout(dismiss, ms);
  return { node, dismiss };
}
