// View controls only change layout. They never recreate an editor or conversation.
import { el } from './dom.js';
import { setOpen, isOpen } from './coach.js';

const paths = {
  problem: 'M4 3h12v14H4z M7 7h6 M7 10h6 M7 13h4',
  coach: 'M3 4h14v10H9l-4 3v-3H3z M7 8h6 M7 11h4',
  results: 'M3 4h14v12H3z M6 7l3 3-3 3 M11 13h3',
};
function icon(name) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', paths[name]); path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.25');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); return svg;
}
function paint() {
  const states = { problem: !document.body.classList.contains('hide-problem'), coach: isOpen(), results: !document.body.classList.contains('hide-results') };
  for (const button of document.querySelectorAll('[data-pane]'))
    button.setAttribute('aria-pressed', String(states[button.dataset.pane]));
}
export function workspaceRail() {
  const items = [
    ['problem', 'Problem statement', () => document.querySelector('.prob-toggle')?.click()],
    ['coach', 'AI coach', () => setOpen(!isOpen(), { focus: false })],
    ['results', 'Test results', () => window.dispatchEvent(new CustomEvent('studio:toggle-results'))],
  ];
  return el('nav', { class: 'workspace-rail', 'aria-label': 'Workspace panels' }, [
    ...items.map(([id, label, onclick]) => el('button', { type: 'button', title: label, 'aria-label': label,
      'data-pane': id, 'aria-pressed': 'false', onclick }, [icon(id), el('span', {text:label})])),
  ]);
}
new MutationObserver(paint).observe(document.body, { attributes:true, attributeFilter:['class'] });
// Rendered controls arrive after the route's class changes.
window.addEventListener('hashchange', () => requestAnimationFrame(paint));
