import { el } from '../dom.js';
export const createBadge = (text, tone = '') => el('span', { class: `ui-badge${tone ? ` ${tone}` : ''}`, text });
// Content rows are not toolbar buttons: their height comes from their content/inset.
export const createActionRow = ({ content, trailing, onClick, className = '' }) => el('button', {
  type: 'button', class: `ui-action-row ui-row ui-inset ${className}`, onclick: onClick,
}, [el('span', { class: 'ui-row-content' }, content), trailing ? el('span', { class: 'ui-row-trailing' }, trailing) : null]);
export const createTabs = (tabs, active, onChange) => { const root = el('div', { class: 'ui-tabs', role: 'tablist' }); tabs.forEach((tab, i) => root.append(el('button', { class: 'ui-tab', type: 'button', role: 'tab', text: tab.label ?? tab, 'aria-selected': String((tab.id ?? tab) === active), onclick: () => { onChange(tab.id ?? tab); [...root.children].forEach((x, j) => x.setAttribute('aria-selected', String(j === i))); } }))); return root; };
