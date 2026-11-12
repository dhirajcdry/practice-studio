import { el, replace } from '../dom.js';

export function moveActive(items, index, delta) {
  const enabled = items.map((item, i) => ({ item, i })).filter(x => !x.item.disabled);
  if (!enabled.length) return -1;
  const position = enabled.findIndex(x => x.i === index);
  if (position < 0) return delta < 0 ? enabled.at(-1).i : enabled[0].i;
  return enabled[(position + delta + enabled.length) % enabled.length].i;
}
export function typeaheadIndex(items, query, from = -1) {
  for (let offset = 1; offset <= items.length; offset++) {
    const index = (from + offset) % items.length;
    if (!items[index].disabled && items[index].label.toLocaleLowerCase().startsWith(query.toLocaleLowerCase())) return index;
  }
  return -1;
}
let sequence = 0;
/** A single floating menu. Options are data; all text goes through dom.js. */
export function createMenu({ anchor, label, items = [], groups = [], onSelect = () => {}, radio = false } = {}) {
  let flat = [], buttons = [], opened = false, active = -1, search = '', searchTimer;
  let data = { items, groups };
  const root = el('div', { id: `ui-menu-${++sequence}`, class: 'ui-menu', role: 'menu', 'aria-label': label, hidden: true });
  anchor.setAttribute('aria-haspopup', 'menu'); anchor.setAttribute('aria-expanded', 'false'); anchor.setAttribute('aria-controls', root.id);
  function focus(index) {
    if (index < 0) return;
    active = index;
    buttons.forEach((button, i) => { button.tabIndex = i === index ? 0 : -1; });
    buttons[index]?.focus({ preventScroll: true }); buttons[index]?.scrollIntoView({ block: 'nearest' });
  }
  // An icon is text, or a function returning a fresh node (a node can only live in one place).
  const glyph = icon => !icon ? null : el('span', { class: 'ui-menu-icon', 'aria-hidden': 'true' }, typeof icon === 'function' ? icon() : String(icon));
  function render() {
    flat = []; buttons = [];
    const option = item => {
      const index = flat.length; flat.push(item);
      const role = item.role || (radio ? 'menuitemradio' : 'menuitem');
      const button = el('button', { class: 'ui-menu-item', type: 'button', role, tabindex: '-1', disabled: item.disabled,
        ...(role === 'menuitemradio' ? { 'aria-checked': String(Boolean(item.checked)) } : {}),
        onclick: () => { if (item.disabled) return; close(true); onSelect(item); },
        onfocus: () => { active = index; },
      }, [glyph(item.icon),
        el('span', { class: 'ui-menu-label', text: item.label }), item.hint ? el('span', { class: 'ui-menu-hint', text: item.hint }) : null,
        el('span', { class: 'ui-menu-check', 'aria-hidden': 'true', text: item.checked ? '✓' : '' })]);
      buttons.push(button); return button;
    };
    replace(root, data.groups.length ? data.groups.map(group => el('div', { role: 'group', 'aria-label': group.label }, [
      group.label ? el('div', { class: 'ui-menu-heading' }, [glyph(group.icon), el('span', { text: group.label })]) : null, ...(group.options || group.items || []).map(option),
    ])) : data.items.map(option));
  }
  function close(restore = true) {
    if (!opened) return;
    opened = false; root.hidden = true; anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('focusin', outsideFocus, true);
    window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', scroll, true);
    clearTimeout(searchTimer); search = ''; root.remove();
    if (restore && anchor.isConnected) anchor.focus();
  }
  const outside = event => { if (!root.contains(event.target) && !anchor.contains(event.target)) close(false); };
  const outsideFocus = event => { if (!root.contains(event.target) && !anchor.contains(event.target)) close(false); };
  const dismiss = () => close(true);
  const scroll = event => { if (!root.contains(event.target)) close(true); };
  function open(edge) {
    if (opened || anchor.disabled) return;
    render(); opened = true; root.hidden = false; anchor.setAttribute('aria-expanded', 'true');
    // The top layer avoids clipping by panes, dialogs, and theme transforms.
    root.setAttribute('popover', 'manual'); document.body.append(root);
    if (root.showPopover) root.showPopover();
    const rect = anchor.getBoundingClientRect();
    const gap = parseFloat(getComputedStyle(anchor).getPropertyValue('--space-1')) || 4;
    root.style.maxWidth = `${innerWidth - gap * 2}px`;
    root.style.minWidth = `${Math.min(rect.width, innerWidth - gap * 2)}px`;
    root.style.maxHeight = `${Math.max(0, innerHeight - gap * 2)}px`;
    const box = root.getBoundingClientRect();
    const below = innerHeight - rect.bottom - gap * 2, above = rect.top - gap * 2;
    const flip = box.height > below && above > below;
    root.style.maxHeight = `${Math.max(0, flip ? above : below)}px`;
    root.style.left = `${Math.max(gap, Math.min(rect.left, innerWidth - box.width - gap))}px`;
    root.style.top = `${flip ? Math.max(gap, rect.top - Math.min(box.height, above) - gap) : rect.bottom + gap}px`;
    focus(edge === 'end' ? flat.findLastIndex(item => !item.disabled) : edge === 'start' ? flat.findIndex(item => !item.disabled) : flat.findIndex(item => item.checked && !item.disabled) >= 0 ? flat.findIndex(item => item.checked && !item.disabled) : flat.findIndex(item => !item.disabled));
    document.addEventListener('pointerdown', outside, true); document.addEventListener('focusin', outsideFocus, true);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', scroll, true);
  }
  function keydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    else if (event.key === 'Tab') close(false);
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      focus(event.key === 'Home' ? flat.findIndex(item => !item.disabled) : event.key === 'End' ? flat.findLastIndex(item => !item.disabled) : moveActive(flat, active, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault(); clearTimeout(searchTimer); search += event.key;
      let found = typeaheadIndex(flat, search, active);
      if (found < 0 && [...search].every(char => char === search[0])) { search = search[0]; found = typeaheadIndex(flat, search, active); }
      focus(found); searchTimer = setTimeout(() => { search = ''; }, 600);
    }
  }
  root.addEventListener('keydown', keydown);
  root.open = open; root.close = close; root.dispose = () => close(false);
  root.setItems = items => { data = { items, groups: [] }; close(false); };
  root.setGroups = groups => { data = { items: [], groups }; close(false); };
  Object.defineProperty(root, 'isOpen', { get: () => opened });
  return root;
}
