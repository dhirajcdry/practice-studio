import { el } from '../dom.js';
import { icon } from './icon.js';
import { button } from './button.js';
import { createMenu } from './menu.js';

const node = value => value instanceof Node ? value : button(value);
const metadata = items => el('div', { class: 'ui-header-meta' }, items.filter(Boolean).map(item => item instanceof Node ? item : el('span', { text: item })));

function actionRail(actions = {}, status) {
  // Existing callers can supply nodes without losing listeners or state.
  if (Array.isArray(actions)) actions = { secondary: actions };
  let secondary = (actions.secondary || []).filter(Boolean).map(node);
  const primary = actions.primary ? node(actions.primary) : secondary.find(item => item.classList.contains('btn--primary'));
  secondary = secondary.filter(item => item !== primary);
  if (!status) {
    status = secondary.find(item => item.matches('.pr-timer,.practice-timer,.mock-time-controls'));
    secondary = secondary.filter(item => item !== status);
  }
  const overflow = (actions.overflow || []).filter(Boolean).map(node);
  const rail = el('div', { class: 'ui-header-actions' }, [status,
    el('div', { class: 'ui-header-secondary' }, secondary), primary || null]);
  if (secondary.length || overflow.length) {
    const more = button({ variant: 'icon', icon: 'more', ariaLabel: 'More actions', className: overflow.length ? 'ui-header-more' : 'ui-header-more ui-header-more-responsive' });
    const menu = createMenu({ anchor: more, label: 'More actions', onSelect: item => item.action.click() });
    more.addEventListener('click', () => {
      if (menu.isOpen) { menu.close(); return; }
      const collapsed = secondary.length && !secondary[0].getClientRects().length;
      menu.setItems([...(collapsed ? secondary : secondary.filter(action => action.classList.contains('ui-overflow-only'))), ...overflow, ...rail.querySelectorAll('.ui-overflow-sources > .ci-learning-notes')].flatMap(action => action.matches('button,a') ? [action] : [...action.querySelectorAll('button,a')]).map(action => ({
        label: action.textContent.trim() || action.getAttribute('aria-label'), disabled: action.disabled || action.hidden,
        action,
      })));
      menu.open();
    });
    rail.append(more, el('div', { hidden: true, class: 'ui-overflow-sources' }, overflow));
  }
  return rail;
}

export function screenHeader({ back, crumb, title, badges = [], meta = [], status, actions = {} }) {
  const backControl = back ? back.href
    ? el('a', { class: `btn btn--icon ui-workspace-back ${back.className || ''}`, href: back.href, 'aria-label': back.label }, icon('back', 15))
    : button({ variant: 'icon', icon: 'back', ariaLabel: back.label, onClick: back.onClick, className: `ui-workspace-back ${back.className || ''}` }) : null;
  return el('header', { class: 'ui-workspace-header ui-screen-header' }, [backControl,
    crumb ? el('span', { class: 'ui-header-crumb', text: `${crumb} /` }) : null,
    el('div', { class: 'ui-workspace-identity' }, [title instanceof Node ? title : el('h1', { text: title }), ...badges, metadata(meta)]),
    actionRail(actions, status)]);
}

export function workspaceHeader({ title, subtitle, backHref, backLabel, actions = [] }) {
  return screenHeader({ title, meta: subtitle ? [subtitle] : [], back: { href: backHref, label: backLabel }, actions });
}

export function dialogHeader({ title, subtitle, meta = [], actions = {}, closeLabel = 'Close', onClose }) {
  return el('header', { class: 'ui-dialog-header' }, [
    el('div', { class: 'ui-dialog-identity' }, [el('h2', { text: title }), metadata([...meta, subtitle])]),
    actionRail(actions),
    el('span', { class: 'ui-header-separator', 'aria-hidden': 'true' }),
    button({ variant: 'icon', icon: 'close', ariaLabel: closeLabel, onClick: onClose, className: 'ui-dialog-close' }),
  ]);
}

export function paneHeader({ title, subtitle, tabs, tools = [] }) {
  return el('header', { class: 'ui-pane-header' }, [tabs || el('strong', { text: title }),
    subtitle instanceof Node ? subtitle : subtitle ? el('span', { class: 'dim', text: subtitle }) : null,
    el('div', { class: 'ui-pane-tools' }, tools.filter(Boolean).map(node))]);
}
