import { el } from '../dom.js';
import { createMenu } from './menu.js';
const normalize = item => Array.isArray(item) ? { value: String(item[0]), label: String(item[1]) }
  : { ...item, value: String(item.value ?? item.id), label: String(item.label ?? item.name ?? item.text ?? item.value) };
export function createSelect({ label, options = [], groups = [], value, onChange = () => {}, compact = false } = {}) {
  let items = options.map(normalize), grouped = groups.map(group => ({ ...group, options: group.options.map(normalize) }));
  const all = () => grouped.length ? grouped.flatMap(group => group.options) : items;
  let current = String(value ?? all()[0]?.value ?? ''), disabled = false;
  const button = el('button', { type: 'button', class: 'ui-select-button', 'aria-label': label });
  const root = el('div', { class: 'ui-select' + (compact ? ' is-compact' : '') }, button);
  const menu = createMenu({ anchor: button, label, radio: true, onSelect: item => {
    current = item.value; paint();
    onChange({ target: root }); root.dispatchEvent(new Event('change', { bubbles: true }));
  } });
  function paint() {
    const selected = all().find(item => item.value === current);
    button.textContent = `${selected?.icon ? selected.icon + ' ' : ''}${selected?.label || 'Choose…'}`;
    button.setAttribute('aria-label', `${label}: ${selected?.label || 'Choose'}`);
    const checked = item => ({ ...item, checked: item.value === current });
    if (grouped.length) menu.setGroups(grouped.map(group => ({ ...group, options: group.options.map(checked) })));
    else menu.setItems(items.map(checked));
  }
  button.addEventListener('click', () => menu.isOpen ? menu.close(true) : menu.open());
  button.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); menu.open(event.key === 'ArrowUp' || event.key === 'End' ? 'end' : 'start');
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); menu.open(); menu.dispatchEvent(new KeyboardEvent('keydown', { key: event.key, bubbles: true }));
    }
  });
  Object.defineProperty(root, 'value', { get: () => current, set: value => { current = String(value); paint(); } });
  Object.defineProperty(root, 'disabled', { get: () => disabled, set: value => { disabled = Boolean(value); button.disabled = disabled; if (disabled) menu.close(false); } });
  Object.defineProperty(root, 'options', { get: all });
  root.setOptions = options => { items = options.map(normalize); grouped = []; paint(); };
  root.setGroups = groups => { grouped = groups.map(group => ({ ...group, options: group.options.map(normalize) })); items = []; paint(); };
  root.focus = () => button.focus(); root.dispose = () => menu.dispose(); root.button = button; root.menu = menu;
  paint(); return root;
}
