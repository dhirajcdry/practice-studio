// Settings: the theme, and how the editor reads.
//
// There were three layouts here. They are gone. Three arrangements of the same four panes
// meant three sets of edge cases, three places for a resize bug to hide, and a choice to
// make before doing any work — in exchange for nothing the panes could not do themselves.
// One layout, with every bar collapsible from the keyboard, is the same flexibility
// without the branching: hide the statement and you have Focus, hide it and the rail and
// you have Interview.
//
// Everything here is stored locally and applied before first paint, so choosing a theme
// never costs a flash of the previous one.

import { el, replace } from './dom.js';
import { CHORDS } from './shortcuts.js';

const STORE_KEY = 'studio.settings.v1';

// `dark` is what the light/dark switch reads; `mono` is only about the typeface, and
// the two are not the same question — Slate is dark and serif, Ink is light and heavy.
export const THEMES = [
  { id: 'paper', name: 'Paper', blurb: 'The original. Warm off-white, serif display, quiet.',
    swatch: ['#F7F7F7', '#111111', '#C4401C'], mono: false, dark: false },
  { id: 'editorial', name: 'Editorial', blurb: 'A printed weekly. Laid paper, Palatino, deep red.',
    swatch: ['#F4EFE6', '#1A1614', '#9B2C2C'], mono: false, dark: false },
  { id: 'ink', name: 'Ink', blurb: 'High contrast. Hard rules, hard shadows, electric blue.',
    swatch: ['#EDEDEA', '#0A0A0A', '#1B49F5'], mono: false, dark: false },
  { id: 'slate', name: 'Slate', blurb: 'Paper after dark. Same shapes, the light turned round.',
    swatch: ['#131518', '#E8EAED', '#FF8256'], mono: false, dark: true },
  { id: 'blueprint', name: 'Blueprint', blurb: 'Drafting table. Cyan on navy, on a printed grid.',
    swatch: ['#0B1B2E', '#DCEEFF', '#5FD3F3'], mono: true, dark: true },
  { id: 'phosphor', name: 'Phosphor', blurb: 'A terminal that happens to teach. Scanlines included.',
    swatch: ['#050B07', '#7EFFA8', '#FFC24B'], mono: true, dark: true },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function isDark(theme = null) {
  return themeById(theme ?? current.theme).dark === true;
}

/** What the operating system is set to, when nothing has been chosen here yet. */
function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

const DEFAULTS = { theme: 'paper', lightTheme: 'paper', darkTheme: 'slate', codeSize: 13, motion: true };

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      // First run follows the operating system, which is what "dark mode" means
      // everywhere else. After that it follows you, because you chose.
      theme: THEMES.some((t) => t.id === raw.theme)
        ? raw.theme
        : (systemPrefersDark() ? DEFAULTS.darkTheme : DEFAULTS.theme),
      // Which theme to come back to on each side of the switch, so flipping to dark and
      // back does not quietly forget that you had chosen Editorial.
      lightTheme: THEMES.some((t) => t.id === raw.lightTheme && !t.dark) ? raw.lightTheme : DEFAULTS.lightTheme,
      darkTheme: THEMES.some((t) => t.id === raw.darkTheme && t.dark) ? raw.darkTheme : DEFAULTS.darkTheme,
      codeSize: Number(raw.codeSize) >= 10 && Number(raw.codeSize) <= 20 ? Number(raw.codeSize) : DEFAULTS.codeSize,
      motion: raw.motion !== false,
    };
  } catch {
    return { ...DEFAULTS }; // private browsing: it works, it just forgets
  }
}

let current = read();
const listeners = new Set();

export function getSettings() { return { ...current }; }
export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setSetting(key, value) {
  if (current[key] === value) return;
  current = { ...current, [key]: value };
  // Picking a theme also records which side of the switch it belongs to.
  if (key === 'theme') {
    current[isDark(value) ? 'darkTheme' : 'lightTheme'] = value;
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(current)); } catch { /* forgets */ }
  apply();
  for (const fn of listeners) fn(getSettings());
}

/** Put the settings onto the document. Safe to call at any time, including before boot. */
export function apply() {
  const root = document.documentElement;
  for (const theme of THEMES) {
    document.body.classList.toggle(`theme-${theme.id}`, current.theme === theme.id);
  }
  // Monaco cannot read CSS variables, so a dark theme has to be told explicitly.
  document.body.classList.toggle('is-dark', isDark());
  root.style.setProperty('--code-size', `${current.codeSize}px`);
  document.body.classList.toggle('reduce-motion', current.motion === false);
}

/** Flip between light and dark, each side remembering the theme you last chose on it. */
export function toggleDark(force = null) {
  const next = force === null ? !isDark() : force;
  setSetting('theme', next ? current.darkTheme : current.lightTheme);
}

/* ------------------------------- the panel -------------------------------- */

function themeCard(theme, onPick) {
  const chosen = current.theme === theme.id;
  return el('button', {
    class: 'set-card set-theme', type: 'button', 'aria-pressed': String(chosen),
    onclick: () => onPick(theme.id),
  }, [
    // The swatch is the actual palette, not an approximation of it: canvas, ink, accent.
    el('div', { class: 'set-swatch' }, theme.swatch.map((hex) => el('i', { style: `background:${hex}` }))),
    el('div', { class: 'set-cardname mono', text: theme.name }),
    el('div', { class: 'set-cardblurb', text: theme.blurb }),
  ]);
}

function keyRow(keys, what) {
  return el('div', { class: 'set-keyrow' }, [
    el('kbd', { class: 'mono', text: keys }),
    el('span', { class: 'set-keywhat', text: what }),
  ]);
}

let panel = null;
let scrim = null;

export function closeSettings() {
  if (panel) { panel.remove(); panel = null; }
  if (scrim) { scrim.remove(); scrim = null; }
  document.body.classList.remove('settings-open');
}

export function openSettings() {
  if (panel) { closeSettings(); return; }

  const themeCards = el('div', { class: 'set-cards set-themes' });
  const rerender = () => {
    replace(themeCards, THEMES.map((t) => themeCard(t, (id) => { setSetting('theme', id); rerender(); })));
  };
  rerender();

  const sizeValue = el('span', { class: 'mono dim set-value', text: `${current.codeSize}px` });
  const size = el('input', {
    type: 'range', min: '10', max: '20', step: '1', value: String(current.codeSize),
    class: 'set-range', 'aria-label': 'Editor font size',
    oninput: (event) => {
      const value = Number(event.target.value);
      sizeValue.textContent = `${value}px`;
      setSetting('codeSize', value);
    },
  });

  const motion = el('input', {
    type: 'checkbox', class: 'set-check', 'aria-label': 'Animations',
    ...(current.motion ? { checked: 'checked' } : {}),
    onchange: (event) => setSetting('motion', event.target.checked),
  });

  panel = el('aside', { class: 'settings', role: 'dialog', 'aria-label': 'Settings' }, [
    el('div', { class: 'set-head' }, [
      el('span', { class: 'mono dim', text: 'Settings' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ws-mini', type: 'button', text: 'Done', onclick: closeSettings }),
    ]),
    el('div', { class: 'set-body' }, [
      el('div', { class: 'mono dim set-label', text: 'Theme' }),
      themeCards,
      el('div', { class: 'mono dim set-label', text: 'Editor' }),
      el('label', { class: 'set-row' }, [
        el('span', { class: 'set-rowname', text: 'Code size' }),
        size,
        sizeValue,
      ]),
      el('label', { class: 'set-row' }, [
        el('span', { class: 'set-rowname', text: 'Animations' }),
        el('span', { class: 'spacer' }),
        motion,
      ]),
      el('div', { class: 'mono dim set-label', text: 'Keys' }),
      // Listed, not configurable. A shortcut you can rebind is a shortcut you have to
      // remember twice; what this is for is answering "what was it again".
      el('div', { class: 'set-keys' }, [
        ...CHORDS.map((c) => keyRow(c.label, `Show or hide ${c.what}`)),
        keyRow('⌘↵', 'Submit to LeetCode'),
        keyRow("⌘'", 'Run the example cases here'),
        keyRow('⌘S', 'Save to disk now'),
      ]),
    ]),
  ]);

  scrim = el('div', { class: 'set-scrim', onclick: closeSettings });
  document.body.append(scrim, panel);
  document.body.classList.add('settings-open');
}

/** Sun and moon, drawn rather than typed — an emoji is a different font on every OS. */
function dayNightGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('set-dayglyph');

  const sun = document.createElementNS(ns, 'g');
  sun.classList.add('is-sun');
  const disc = document.createElementNS(ns, 'circle');
  disc.setAttribute('cx', '8'); disc.setAttribute('cy', '8'); disc.setAttribute('r', '3.1');
  disc.setAttribute('fill', 'currentColor');
  const rays = document.createElementNS(ns, 'path');
  rays.setAttribute('d', 'M8 .8v2M8 13.2v2M.8 8h2M13.2 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4');
  rays.setAttribute('stroke', 'currentColor');
  rays.setAttribute('stroke-width', '1.3');
  rays.setAttribute('stroke-linecap', 'round');
  rays.setAttribute('fill', 'none');
  sun.append(disc, rays);

  const moon = document.createElementNS(ns, 'path');
  moon.classList.add('is-moon');
  // A crescent as one path: a disc with a bite taken out by the even-odd rule, so it
  // needs no second colour and works on any background.
  moon.setAttribute('d', 'M13.4 10.3A6 6 0 0 1 5.7 2.6a6 6 0 1 0 7.7 7.7Z');
  moon.setAttribute('fill', 'currentColor');

  svg.append(sun, moon);
  return svg;
}

/** The light/dark switch and the gear, side by side in the top bar. Mounted once. */
export function installSettingsButton(mountEl) {
  if (!mountEl) return;

  const dayNight = el('button', {
    class: 'set-open set-daynight', type: 'button',
    onclick: () => { toggleDark(); paintDayNight(dayNight); },
  }, [dayNightGlyph()]);
  paintDayNight(dayNight);
  // Settings can change the theme too, and the switch must not sit there claiming the
  // opposite of what is on screen.
  onSettingsChange(() => paintDayNight(dayNight));

  mountEl.append(dayNight);
  mountEl.append(el('button', {
    class: 'set-open mono', type: 'button', title: 'Settings — theme and editor',
    'aria-label': 'Settings',
    onclick: openSettings,
  }, '⚙'));
}

function paintDayNight(button) {
  const dark = isDark();
  button.setAttribute('aria-pressed', String(dark));
  // Says what pressing it does, not what it currently is — that is what a person is
  // asking when they hover a toggle.
  const to = dark ? themeById(current.lightTheme).name : themeById(current.darkTheme).name;
  button.title = dark ? `Light mode (${to})` : `Dark mode (${to})`;
  button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && panel) { event.preventDefault(); closeSettings(); }
});

apply();
