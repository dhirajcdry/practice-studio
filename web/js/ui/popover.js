import { el } from '../dom.js';

let sequence = 0;
// A small nonmodal editor in the top layer; never expands its toolbar anchor.
export function createPopover({ anchor, label, content, className = '', focus }) {
  const root = el('div', { id: `ui-popover-${++sequence}`, class: `ui-menu ${className}`, popover: 'auto', role: 'dialog', 'aria-label': label }, content);
  anchor.setAttribute('aria-haspopup', 'dialog');
  anchor.setAttribute('aria-expanded', 'false');
  anchor.setAttribute('aria-controls', root.id);
  let opened = false;
  function close(restore = true) {
    if (!opened) return;
    root.hidePopover(); opened = false;
    anchor.setAttribute('aria-expanded', 'false');
    if (restore && anchor.isConnected) anchor.focus();
  }
  function open() {
    if (anchor.disabled || opened) return;
    if (!root.isConnected) document.body.append(root);
    root.showPopover(); opened = true;
    anchor.setAttribute('aria-expanded', 'true');
    const gap = parseFloat(getComputedStyle(anchor).getPropertyValue('--space-1')) || 4;
    const rect = anchor.getBoundingClientRect();
    root.style.maxWidth = `${innerWidth - gap * 2}px`;
    const box = root.getBoundingClientRect();
    root.style.left = `${Math.max(gap, Math.min(rect.right - box.width, innerWidth - box.width - gap))}px`;
    root.style.top = `${rect.bottom + box.height + gap <= innerHeight ? rect.bottom + gap : Math.max(gap, rect.top - box.height - gap)}px`;
    (focus?.() || root.querySelector('button,input'))?.focus();
  }
  const dismiss = () => close(false);
  root.addEventListener('toggle', event => { opened = event.newState === 'open'; anchor.setAttribute('aria-expanded', String(opened)); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  const blur = event => { if (!root.contains(event.target) && !anchor.contains(event.target)) close(false); };
  document.addEventListener('focusin', blur);
  window.addEventListener('resize', dismiss);
  return { root, open, close, get isOpen() { return opened; }, dispose() {
    close(false); root.remove(); document.removeEventListener('focusin', blur); window.removeEventListener('resize', dismiss);
  } };
}
