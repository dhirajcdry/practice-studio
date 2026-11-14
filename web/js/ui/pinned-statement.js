import { el, replace } from '../dom.js';
import { icon } from './icon.js';

// The problem as the candidate was given it, pinned above a mock's phase stepper. It is
// only ever handed the PUBLIC statement (`publicProblem().statement`, a design prompt);
// interviewer-only facts and curveballs never reach the client. Two lines, then a drawn
// Show more that opens the rest in place.
export function createPinnedStatement(text = '', { label = 'Problem' } = {}) {
  let open = false;
  const body = el('p', { class: 'ui-pinned-statement-text' });
  const toggle = el('button', { type: 'button', class: 'btn btn--quiet ui-pinned-statement-more', 'aria-expanded': 'false', hidden: true, onclick: () => { open = !open; paint(); } });
  const root = el('section', { class: 'ui-pinned-statement', 'aria-label': label, hidden: true }, [body, toggle]);
  function fit() {
    // Shown only when two lines do not hold it; once open it stays to close it again.
    if (!open) toggle.hidden = body.scrollHeight <= body.clientHeight + 1;
  }
  function paint() {
    root.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    replace(toggle, [el('span', { text: open ? 'Show less' : 'Show more' }), icon('chevron', 14)]);
    fit();
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  observer?.observe(body);
  function set(next) {
    const value = typeof next === 'string' ? next.replace(/\s+/g, ' ').trim() : '';
    if (value === body.textContent && root.hidden === !value) return;
    body.textContent = value; root.hidden = !value; open = false; paint();
  }
  set(text);
  return { root, set, dispose() { observer?.disconnect(); } };
}
