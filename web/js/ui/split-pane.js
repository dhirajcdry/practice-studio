import { el } from '../dom.js';

// Two-pane workspaces share the existing split visual treatment, but own their
// instance, storage key and responsive breakpoint instead of coding-page globals.
export function installPaneResizer(container, {
  storageKey, minLeft = 360, minRight = 300, breakpoint = 900,
  label = 'Workspace and coach',
} = {}) {
  const [left, right] = container.children;
  const originalColumns = container.style.getPropertyValue('--workspace-columns');
  const originalPosition = container.style.position;
  const media = window.matchMedia(`(max-width: ${breakpoint}px)`);
  let ratio = null, gone = false, endDrag = null;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (Number.isFinite(saved) && saved > 0 && saved < 1) ratio = saved;
  } catch { /* Layout preferences are optional. */ }
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  const handle = el('div', { class: 'split split-col ui-pane-divider', role: 'separator', tabindex: '0',
    'aria-label': `${label} — drag to resize, double-click to reset`, 'aria-orientation': 'vertical',
  });
  container.append(handle);
  const available = () => container.clientWidth - (parseFloat(getComputedStyle(container).columnGap) || 0);
  const disabled = () => media.matches || available() < minLeft + minRight;
  const clamp = (value, total) => Math.max(minLeft, Math.min(total - minRight, value));
  function persist() {
    try { if (ratio === null) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, String(ratio)); } catch {}
  }
  function position() {
    if (gone || handle.hidden) return;
    const box = container.getBoundingClientRect(), a = left.getBoundingClientRect(), b = right.getBoundingClientRect();
    handle.style.left = `${(a.right + b.left) / 2 - box.left}px`;
    handle.style.top = `${a.top - box.top}px`;
    handle.style.height = `${Math.max(a.height, b.height)}px`;
    const total = available();
    handle.setAttribute('aria-valuemin', Math.round(minLeft / total * 100));
    handle.setAttribute('aria-valuemax', Math.round((total - minRight) / total * 100));
    handle.setAttribute('aria-valuenow', Math.round(a.width / total * 100));
    handle.setAttribute('aria-valuetext', `${Math.round(a.width)} pixels workspace, ${Math.round(b.width)} pixels coach`);
  }
  function apply() {
    if (gone) return;
    const stacked = disabled();
    if (stacked) endDrag?.();
    handle.hidden = stacked;
    // CSS owns stacking immediately at the breakpoint; no desktop inline grid
    // may leak into a narrow viewport before this observer runs.
    const columns = stacked || ratio === null ? originalColumns : `${clamp(available() * ratio, available())}px minmax(0,1fr)`;
    if (columns) container.style.setProperty('--workspace-columns', columns);
    else container.style.removeProperty('--workspace-columns');
    position();
  }
  function resize(width) {
    const total = available();
    ratio = clamp(width, total) / total;
    apply();
  }
  function reset() { endDrag?.(); ratio = null; apply(); persist(); }
  handle.addEventListener('dblclick', reset);
  handle.addEventListener('keydown', event => {
    if (disabled() || event.altKey || event.ctrlKey || event.metaKey) return;
    const width = left.getBoundingClientRect().width, step = event.shiftKey ? 72 : 24;
    if (event.key === 'ArrowLeft') resize(width - step);
    else if (event.key === 'ArrowRight') resize(width + step);
    else if (event.key === 'Home') resize(minLeft);
    else if (event.key === 'End') resize(available() - minRight);
    else if (event.key === 'Enter' || event.key === ' ') reset();
    else return;
    event.preventDefault(); event.stopPropagation(); persist();
  });
  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || disabled()) return;
    event.preventDefault(); endDrag?.(); handle.focus({ preventScroll: true });
    const startX = event.clientX, startWidth = left.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-splitting');
    const move = e => { if (e.pointerId === event.pointerId) resize(startWidth + e.clientX - startX); };
    const end = () => {
      endDrag = null;
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      window.removeEventListener('blur', end);
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      document.body.classList.remove('is-splitting'); persist();
    };
    endDrag = end;
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
    window.addEventListener('blur', end);
  });
  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(apply); };
  const observer = new ResizeObserver(schedule);
  observer.observe(container); observer.observe(left);
  media.addEventListener('change', schedule);
  apply();
  return () => {
    gone = true; endDrag?.(); observer.disconnect(); media.removeEventListener('change', schedule); cancelAnimationFrame(frame);
    handle.remove();
    if (originalColumns) container.style.setProperty('--workspace-columns', originalColumns);
    else container.style.removeProperty('--workspace-columns');
    container.style.position = originalPosition;
  };
}
