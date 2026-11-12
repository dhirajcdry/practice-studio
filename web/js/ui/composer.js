import { el } from '../dom.js';
import { tooltip } from '../tooltip.js';
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
  button.classList.remove('btn--quiet', 'btn--secondary', 'btn--icon');
  button.classList.add('btn', 'btn--primary', 'ui-composer-send');
  button.setAttribute('aria-label', label);
  button.classList.remove('btn--lg');
  button.removeAttribute('title');
  tooltip(button, label === 'Stop' ? 'Stop reply' : `${label} (⌘ / Ctrl + Enter)`);
  button.replaceChildren(icon('send', 15));
  return button;
}

// Recalculate for text AND width changes (resizing a pane, changing modes or
// restoring a draft). Never grow the page; the input scrolls at its CSS cap.
export function bindComposerInput(input) {
  input.classList.add('ui-composer-input');
  input.rows = 1;
  let frame = 0;
  function measure() {
    if (!input.isConnected || !input.getClientRects().length) return;
    const style = getComputedStyle(input);
    // Measuring a zero-height live input expands its sibling transcript, which
    // clamps scrollTop near the bottom before the input grows back. Measure an
    // out-of-flow copy so editor scroll/periodic paints cannot move the transcript.
    const probe = input.cloneNode(false);
    probe.removeAttribute('id'); probe.removeAttribute('name');
    probe.setAttribute('aria-hidden', 'true'); probe.tabIndex = -1;
    probe.value = input.value;
    Object.assign(probe.style, { position: 'absolute', visibility: 'hidden',
      pointerEvents: 'none', width: style.width, height: '0px', minHeight: '0px', maxHeight: 'none' });
    input.after(probe);
    const height = probe.scrollHeight;
    probe.remove();
    input.style.height = Math.min(parseFloat(style.maxHeight) || 180,
      Math.max(parseFloat(style.minHeight) || 36, height)) + 'px';
  }
  function resize() { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); }
  let width = -1;
  const observer = new ResizeObserver(entries => {
    const next = entries[0].contentRect.width;
    if (next !== width) { width = next; resize(); }
  });
  observer.observe(input);
  input.addEventListener('input', resize);
  window.addEventListener('resize', resize);
  return { resize, dispose() {
    cancelAnimationFrame(frame); observer.disconnect(); input.removeEventListener('input', resize);
    window.removeEventListener('resize', resize);
  } };
}

// Keep the existing capture controller and callbacks intact. Only relocate its
// chrome: words stay with the draft, errors outside the compact control rail.
export function mountComposerDictation(composer, control) {
  control.root.classList.add('ui-dictation');
  const button = control.root.querySelector('.vc-talk');
  button?.classList.add('btn--icon'); button?.classList.remove('btn--quiet');
  if (button) tooltip(button, () => button.getAttribute('aria-label'));
  const actions = composer.querySelector('.ui-composer-actions');
  actions.prepend(control.root);
  composer.querySelector('.ui-composer-body').append(control.preview);
  composer.before(control.status);
}
