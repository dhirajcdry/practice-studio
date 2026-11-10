import { el } from '../dom.js';
import { createPopover } from './popover.js';
import { icon } from './icon.js';

export function mockTimeReading(minutes, elapsedMs) {
  const remaining = minutes * 60000 - elapsedMs;
  const seconds = Math.floor(Math.abs(remaining) / 1000);
  const value = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  return { text: `${remaining <= 0 ? '+' : ''}${value}`, label: remaining <= 0 ? 'overtime' : 'remaining', remaining };
}

// Only the clock lives in the header. Choices, editing and errors stay in its popover.
export function createMockTimeControls({ clock, extend, onChange = () => {} }) {
  let disabled = true, saving = false, pending = null, gone = false, custom = false;
  const button = el('button', { class: 'btn btn--quiet btn--sm mock-add-time', type: 'button', 'aria-label': 'Add time', disabled: true,
    onclick: () => { if (popover.isOpen) popover.close(); else { paint(); popover.open(); } } }, [clock, icon('chevron', 12)]);
  const input = el('input', { class: 'mock-time-input', type: 'number', min: '1', max: '240', step: '1', value: '15', 'aria-label': 'Minutes to add', required: true });
  const add = el('button', { class: 'btn btn--primary btn--sm', type: 'submit', text: 'Add' });
  const form = el('form', { class: 'mock-time-custom', hidden: true, onsubmit: event => { event.preventDefault(); if (form.reportValidity()) void save(Number(input.value)); } }, [input, el('span', { class: 'dim', text: 'min' }), add]);
  const choices = el('div', { class: 'mock-time-choices' }, [
    ...[15, 20].map(minutes => el('button', { class: 'ui-menu-item', type: 'button', text: `+${minutes} min`, onclick: () => save(minutes) })),
    el('button', { class: 'ui-menu-item', type: 'button', text: 'Custom…', onclick: () => { custom = true; paint(); input.focus(); input.select(); } }),
  ]);
  const message = el('p', { class: 'mock-time-message dim', role: 'status', hidden: true });
  const retry = el('button', { class: 'btn btn--quiet btn--sm', type: 'button', text: 'Retry', hidden: true, onclick: () => save(pending.minutes) });
  const popover = createPopover({ anchor: button, label: 'Add time', className: 'mock-time-popover',
    content: [el('div', { class: 'ui-menu-heading', text: 'Add time' }), choices, form, message, retry],
    focus: () => pending ? retry : custom ? input : choices.querySelector('button'),
  });
  const root = el('div', { class: 'mock-time-controls' }, button);
  button.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); paint(); popover.open(); }
  });
  function paint() {
    button.disabled = disabled || saving;
    input.disabled = add.disabled = disabled || saving || Boolean(pending);
    retry.disabled = disabled || saving;
    choices.hidden = custom || Boolean(pending);
    form.hidden = !custom || Boolean(pending);
    message.hidden = !pending;
    retry.hidden = !pending || saving;
    choices.querySelectorAll('button').forEach(node => { node.disabled = disabled || saving; });
  }
  async function save(minutes) {
    if (disabled || saving || gone) return;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) return;
    pending ||= { minutes, requestId: crypto.randomUUID() };
    let restoreFocus = false;
    saving = true; message.textContent = 'Adding time…'; paint(); onChange();
    try {
      await extend(pending);
      if (gone) return;
      pending = null; custom = false; restoreFocus = popover.isOpen; popover.close(false);
    } catch (error) {
      if (!gone) message.textContent = error.message || 'Could not add time.';
    } finally { saving = false; if (!gone) { paint(); onChange(); if (restoreFocus) button.focus(); } }
  }
  return { root, get saving() { return saving; }, update({ disabled: value, hidden = false, label }) {
    disabled = value; root.hidden = hidden; if (label) button.setAttribute('aria-label', `${label}. Add time`);
    paint(); if (hidden) popover.close(false);
  }, dispose() { gone = true; popover.dispose(); } };
}
