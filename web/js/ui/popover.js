import { el } from '../dom.js';

let sequence = 0;
// A small nonmodal editor in the top layer; never expands its toolbar anchor.
export function createPopover({ anchor, label, content, className = '', focus, bounds }) {
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
    position();
    (focus?.() || root.querySelector('button,input'))?.focus();
  }
  let frame = 0;
  function position() {
    if (!opened) return;
    const gap = 4, rect = anchor.getBoundingClientRect();
    const boundary = bounds?.()?.getBoundingClientRect() || { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
    const left = Math.max(gap, boundary.left + gap), right = Math.min(innerWidth - gap, boundary.right - gap);
    const top = Math.max(gap, boundary.top + gap), bottom = Math.min(innerHeight - gap, boundary.bottom - gap);
    root.style.maxWidth = `${Math.max(0, right - left)}px`;
    const below = bottom - rect.bottom - gap, above = rect.top - top - gap;
    root.style.maxHeight = `${Math.max(0, bounds ? below : Math.max(below, above))}px`;
    const box = root.getBoundingClientRect();
    root.style.left = `${Math.max(left, Math.min(rect.right - box.width, right - box.width))}px`;
    root.style.top = `${!bounds && box.height > below ? Math.max(top, rect.top - box.height - gap) : Math.max(top, Math.min(rect.bottom + gap, bottom - box.height))}px`;
  }
  const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(position); });
  observer.observe(root);
  const dismiss = () => close(false);
  root.addEventListener('toggle', event => { opened = event.newState === 'open'; anchor.setAttribute('aria-expanded', String(opened)); });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  const blur = event => { if (!root.contains(event.target) && !anchor.contains(event.target)) close(false); };
  document.addEventListener('focusin', blur);
  window.addEventListener('resize', dismiss);
  return { root, open, close, get isOpen() { return opened; }, dispose() {
    close(false); observer.disconnect(); cancelAnimationFrame(frame); root.remove(); document.removeEventListener('focusin', blur); window.removeEventListener('resize', dismiss);
  } };
}
