import { el, replace } from '../dom.js';
import { icon } from './icon.js';

// One stepper for every mock: equal-width steps, a drawn check on finished ones and the
// accent on the current one. Passive (LLD, coding) it is a list the interviewer moves;
// with onSelect (system design) each step is a real button the candidate presses to
// tell the interviewer where they are. Both look the same.
export function createPhaseStepper({ phases, label = 'Interview phase', onSelect = null, stepClass = '', className = '' }) {
  let current = null, disabled = false;
  const steps = phases.map(([key, text]) => {
    const name = el('span', { class: 'ui-phase-label', text });
    const mark = el('span', { class: 'ui-phase-mark', 'aria-hidden': 'true' });
    const done = el('span', { class: 'ui-sr-only' });
    const body = onSelect
      ? el('button', { class: `ui-phase-step-button ${stepClass}`.trim(), type: 'button', dataset: { phase: key }, onclick: () => { if (!disabled) onSelect(key); } }, [mark, name, done])
      : el('span', { class: `ui-phase-step-body ${stepClass}`.trim(), dataset: { phase: key } }, [mark, name, done]);
    return { key, item: el('li', { class: 'ui-phase-step', dataset: { phase: key } }, body), body, mark, done, state: '' };
  });
  const root = el('ol', { class: `ui-phase-stepper${onSelect ? ' is-interactive' : ''} ${className}`.trim(), 'aria-label': label }, steps.map(step => step.item));
  function update({ current: next = current, disabled: off = disabled } = {}) {
    current = next; disabled = off;
    const at = Math.max(0, phases.findIndex(([key]) => key === current));
    for (const [index, step] of steps.entries()) {
      const state = index < at ? 'done' : index === at ? 'current' : 'next';
      // Only a step whose state changed is repainted, so a 1 s tick never churns the DOM.
      if (step.state !== state) {
        step.state = state; step.item.dataset.state = state;
        replace(step.mark, state === 'done' ? icon('check', 12) : []);
        step.done.textContent = state === 'done' ? ', finished' : '';
        if (state === 'current') step.body.setAttribute('aria-current', 'step');
        else step.body.removeAttribute('aria-current');
      }
      if (onSelect && step.body.disabled !== disabled) step.body.disabled = disabled;
    }
  }
  update({ current: phases[0]?.[0] });
  // Equal columns, as many as fit the longest label with its check; when they do not all
  // fit, the rows are balanced (seven steps wrap as 4 + 3, never 6 + 1 or 3 + 3 + 1).
  let columns = 0;
  function fit() {
    const width = root.clientWidth;
    if (!width) return;
    const style = getComputedStyle(root);
    const gap = parseFloat(style.columnGap) || 0;
    // The widest label, with room for it to turn bold when it is current.
    const room = steps.reduce((most, step) => Math.max(most, step.body.querySelector('.ui-phase-label').scrollWidth), 0) * 1.06 + 2;
    let fits = steps.length;
    while (fits > 1 && (width - gap * (fits - 1)) / fits < room) fits--;
    const next = Math.ceil(steps.length / Math.ceil(steps.length / fits));
    if (next !== columns) { columns = next; root.style.setProperty('--phase-columns', String(next)); }
  }
  root.style.setProperty('--phase-columns', String(steps.length));
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  // Labels too: a theme or font change alters their width without resizing the list.
  for (const node of [root, ...root.querySelectorAll('.ui-phase-label')]) observer?.observe(node);
  document.fonts?.ready.then(fit);
  return { root, update, get current() { return current; }, dispose() { observer?.disconnect(); } };
}
