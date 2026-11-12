import { el } from '../dom.js';

// Persistent buttons retain keyboard focus when a preference is saved.
export function segmented({ label, options, value, onChange, className = '' }) {
  const buttons = options.map(({ id, label: text }) => el('button', {
    type: 'button', class: 'btn btn--quiet', text, dataset: { value: id },
    onclick: () => onChange(id),
  }));
  const root = el('div', { class: `segmented ${className}`, role: 'group', 'aria-label': label }, buttons);
  root.setValue = next => buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.value === next)));
  root.setValue(value);
  return root;
}
