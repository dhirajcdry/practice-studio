import { el } from '../dom.js';
import { button } from './button.js';
import { createMenu } from './menu.js';

export function recordActions({ onOpen, onNotes, onPractice }) {
  const more = button({ variant: 'icon', icon: 'more', ariaLabel: 'Interview actions' });
  const menu = createMenu({ anchor: more, label: 'Interview actions', items: [
    ...(onNotes ? [{ label: 'Learning notes', run: onNotes }] : []),
    { label: 'Practise from this mock', run: onPractice },
  ], onSelect: item => item.run() });
  more.addEventListener('click', () => menu.open());
  return el('div', { class: 'ui-record-actions' }, [button({ label: 'Open', variant: 'secondary', onClick: onOpen, className: 'record-open' }), more]);
}

export function recordMeta(items) {
  return el('div', { class: 'ui-meta' }, items.filter(Boolean).map(text => el('span', { text })));
}
