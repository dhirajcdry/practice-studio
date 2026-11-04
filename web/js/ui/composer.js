import { el } from '../dom.js';
import { icon } from './icon.js';

// One surface owns input, transient feedback, and a trailing control rail. Keep
// it in normal pane flow: its actual height is automatically reserved by flex.
export function createComposer({ className = '', content = [], leading = [], trailing = [], notices = [] }) {
  const footer = el('div', { class: 'ui-composer-footer' }, [
    el('div', { class: 'ui-composer-options' }, leading),
    el('div', { class: 'ui-composer-actions' }, trailing),
  ]);
  return el('div', { class: `ui-composer ${className}` }, [
    el('div', { class: 'ui-composer-body' }, [...content, ...notices]), footer,
  ]);
}

export function composerSend(button, label = 'Send') {
  button.classList.add('btn', 'btn--primary', 'ui-composer-send');
  button.setAttribute('aria-label', label);
  button.title = `${label} (⌘ / Ctrl + Enter)`;
  button.replaceChildren(icon('send', 18));
  return button;
}

// Recalculate for text AND width changes (resizing a pane, changing modes or
// restoring a draft). Never grow the page; the input scrolls at its CSS cap.
export function bindComposerInput(input) {
  input.classList.add('ui-composer-input');
  input.rows = 1;
  function resize() {
    if (!input.isConnected || !input.getClientRects().length) return;
    const style = getComputedStyle(input);
    input.style.height = '0px';
    input.style.height = Math.min(parseFloat(style.maxHeight) || 180,
      Math.max(parseFloat(style.minHeight) || 36, input.scrollHeight)) + 'px';
  }
  let width = -1;
  const observer = new ResizeObserver(entries => {
    const next = entries[0].contentRect.width;
    if (next !== width) { width = next; resize(); }
  });
  observer.observe(input);
  input.addEventListener('input', resize);
  window.addEventListener('resize', resize);
  return { resize, dispose() {
    observer.disconnect(); input.removeEventListener('input', resize);
    window.removeEventListener('resize', resize);
  } };
}
