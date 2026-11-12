import { el } from '../dom.js';
export { createBadge } from './badge.js';
// Content rows are not toolbar buttons: their height comes from their content/inset.
export const createActionRow = ({ content, trailing, onClick, className = '' }) => el('button', {
  type: 'button', class: `ui-action-row ui-row ui-inset ${className}`, onclick: onClick,
}, [el('span', { class: 'ui-row-content' }, content), trailing ? el('span', { class: 'ui-row-trailing' }, trailing) : null]);
export { createTabs } from './tabs.js';
