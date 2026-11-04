import { el } from '../dom.js';
import { createCountBadge } from './badge.js';
export function createTabs(tabs, value, onChange = () => {}) {
  const root = el('div', { class: 'ui-tabs', role: 'tablist' });
  const buttons = tabs.map(tab => el('button', { type: 'button', role: 'tab', class: 'ui-tab' }, [
    el('span', { text: tab.label }), tab.count == null ? null : createCountBadge(tab.count),
    tab.live ? el('span', { class: 'ui-live-dot', 'aria-label': 'Live' }) : null,
  ]));
  root.append(...buttons);
  root.setValue = next => {
    value = next;
    buttons.forEach((button, index) => { const selected = tabs[index].id === value; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
  };
  buttons.forEach((button, index) => button.addEventListener('click', () => { root.setValue(tabs[index].id); onChange(tabs[index].id); }));
  root.addEventListener('keydown', event => {
    const index = buttons.indexOf(document.activeElement);
    if (index < 0 || !['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus(); buttons[next].click();
  });
  root.buttons = buttons; root.setValue(value); return root;
}
