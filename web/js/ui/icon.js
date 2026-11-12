// Stroke icons drawn in currentColor, so every theme colours them like text.
const NS = 'http://www.w3.org/2000/svg';
const PATHS = {
  check: 'M5 12l4 4L19 6',
  bug: 'M8 9h8v8a4 4 0 0 1-8 0V9Z M9 9V6h6v3 M4 10l4 2 M20 10l-4 2 M4 18l4-2 M20 18l-4-2 M12 10v10',
  code: 'M8 6l-6 6 6 6 M16 6l6 6-6 6 M14 4l-4 16',
  image: 'M3 4h18v16H3z M3 17l6-7 4 5 3-3 5 6 M16 8h.01',

  copy: 'M9 9h12v12H9z M15 9V3H3v12h6',
  stop: 'M6 6h12v12H6z',
  edit: 'M4 16l-1 5 5-1L20 8l-4-4L4 16Z M14 6l4 4',
  forward: 'M9 6l6 6-6 6',
  minus: 'M5 12h14',
  fit: 'M4 9V4h5 M20 9V4h-5 M4 15v5h5 M20 15v5h-5',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  plus: 'M12 5v14 M5 12h14',
  send: 'M12 19V5 M5 12l7-7 7 7',
  speaker: 'M11 5 6 9H3v6h3l5 4V5Z M15.5 8.5a5 5 0 0 1 0 7 M18.5 5.5a9 9 0 0 1 0 13',
  pause: 'M9 5v14 M15 5v14',
  play: 'M7 5v14l12-7L7 5Z',
  mic: 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3',
  'mic-off': 'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z M5 11a7 7 0 0 0 14 0 M12 18v3 M4 4l16 16',
  keyboard: 'M3 7h18v10H3z M7 11h.01 M11 11h.01 M15 11h.01 M8 14h8',
  back: 'M15 6l-6 6 6 6',
  chevron: 'M6 9l6 6 6-6',
  print: 'M7 9V3h10v6 M7 17H4v-7h16v7h-3 M7 14h10v7H7z',
  close: 'M6 6l12 12 M18 6 6 18',
  report: 'M6 3h9l3 3v15H6z M9 12h6 M9 16h6 M9 8h3',
  sidebar: 'M4 5h16v14H4z M15 5v14',
  wrap: 'M4 6h16 M4 12h13a3 3 0 0 1 0 6h-5 M14 15.5 11.5 18l2.5 2.5 M4 18h4',
  reset: 'M4 12a8 8 0 1 0 2.4-5.7 M4 4v4.5h4.5',
  shuffle: 'M16 3h5v5 M4 20 21 3 M21 16v5h-5 M15 15l6 6 M4 4l5 5',
};
export function icon(name, size = 16) {
  const svg = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.75', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'ui-icon' })) svg.setAttribute(k, v);
  for (const d of PATHS[name].split(/ (?=M)/)) {
    const path = document.createElementNS(NS, 'path'); path.setAttribute('d', d); svg.append(path);
  }
  return svg;
}
