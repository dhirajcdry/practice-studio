import { el } from '../dom.js';
import { icon } from './icon.js';

// A title owns the remaining space; actions always have their own trailing rail.
export function workspaceHeader({ title, subtitle, backHref, backLabel, actions = [] }) {
  return el('header', { class: 'ui-workspace-header' }, [
    el('a', { class: 'ui-workspace-back icon-btn', href: backHref, 'aria-label': backLabel, title: backLabel }, icon('back')),
    el('div', { class: 'ui-workspace-identity' }, [
      el('h1', { text: title }),
      typeof subtitle === 'string' ? el('p', { class: 'dim', text: subtitle }) : subtitle,
    ]),
    el('div', { class: 'ui-header-actions' }, actions),
  ]);
}

export function dialogHeader({ title, subtitle, actions = [], closeLabel = 'Close', onClose }) {
  return el('header', { class: 'ui-dialog-header' }, [
    el('div', { class: 'ui-dialog-identity' }, [el('h2', { text: title }), subtitle ? el('p', { text: subtitle }) : null]),
    el('div', { class: 'ui-header-actions' }, [
      ...actions,
      el('button', { type: 'button', class: 'icon-btn ui-dialog-close', 'aria-label': closeLabel, onclick: onClose }, icon('close')),
    ]),
  ]);
}
