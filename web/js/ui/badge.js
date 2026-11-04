import { el } from '../dom.js';
export function createBadge(text, tone = 'neutral', { dot = false } = {}) {
  return el('span', { class: `ui-badge ui-badge--${tone}` }, [dot ? el('span', { class: 'ui-live-dot', 'aria-hidden': 'true' }) : null, text]);
}
export const createCountBadge = count => el('span', { class: 'ui-count', text: count });
