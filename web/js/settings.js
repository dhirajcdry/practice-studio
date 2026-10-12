// Settings: the theme, and how the editor reads.
//
// Workspace views change the arrangement; colour themes remain independent. Selecting
// a view never remounts Monaco or the coach, so drafts, undo, and streams stay intact.
//
// Everything here is stored locally and applied before first paint, so choosing a theme
// never costs a flash of the previous one.

import { el, replace } from './dom.js';
import { CHORDS } from './shortcuts.js';
import { createCoachModelPicker } from './coach-model.js';

const STORE_KEY = 'studio.settings.v1';

export const WORKSPACES = [
  { id: 'workbench', name: 'Workbench', blurb: 'Docked tools. Everything within reach.' },
  { id: 'focus', name: 'Focus', blurb: 'A quiet canvas for code and conversation.' },
  { id: 'review', name: 'Review', blurb: 'Code on the left. Evidence and feedback on the right.' },
];

// `dark` is what the light/dark switch reads; `mono` is only about the typeface, and
// the two are not the same question — Slate is dark and proportional, Phosphor is dark and monospaced.
export const THEMES = [
  { id: 'paper', name: 'Paper', blurb: 'A quiet canvas. Clean type, soft groups, blue focus.',
    swatch: ['#F3F4F6', '#111111', '#355DCC'], mono: false, dark: false },
  { id: 'editorial', name: 'Editorial', blurb: 'Margin notes. Serif prose, warm paper, red annotations.',
    swatch: ['#F4EFE6', '#1A1614', '#9B2C2C'], mono: false, dark: false },
  { id: 'ink', name: 'Ink', blurb: 'Bold hierarchy. Hard rules, square markers, electric blue.',
    swatch: ['#EDEDEA', '#0A0A0A', '#1B49F5'], mono: false, dark: false },
  { id: 'slate', name: 'Slate', blurb: 'A graphite workbench. Grouped evidence, crisp blue focus.',
    swatch: ['#131518', '#E8EAED', '#91A7FF'], mono: false, dark: true },
  { id: 'blueprint', name: 'Blueprint', blurb: 'Engineering notebook. Cyan guides and layered navy panes.',
    swatch: ['#0B1B2E', '#DCEEFF', '#5FD3F3'], mono: true, dark: true },
  { id: 'phosphor', name: 'Phosphor', blurb: 'A command log. Monospaced replies, compact test evidence.',
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

const DEFAULTS = { theme: 'paper', lightTheme: 'paper', darkTheme: 'slate', workspace: 'workbench', codeSize: 14, motion: true };

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const theme = THEMES.some(t => t.id === raw.theme) ? raw.theme
      : (systemPrefersDark() ? DEFAULTS.darkTheme : DEFAULTS.theme);
    return {
      workspace: WORKSPACES.some(w => w.id === raw.workspace) ? raw.workspace : DEFAULTS.workspace,
      // First run follows the operating system, which is what "dark mode" means
      // everywhere else. After that it follows you, because you chose.
      theme,
      // Which theme to come back to on each side of the switch, so flipping to dark and
      // back does not quietly forget that you had chosen Editorial.
      lightTheme: THEMES.some((t) => t.id === raw.lightTheme && !t.dark) ? raw.lightTheme : (!themeById(theme).dark ? theme : DEFAULTS.lightTheme),
      darkTheme: THEMES.some((t) => t.id === raw.darkTheme && t.dark) ? raw.darkTheme : (themeById(theme).dark ? theme : DEFAULTS.darkTheme),
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
  if (key === 'workspace' && !WORKSPACES.some(w => w.id === value)) return;
  current = { ...current, [key]: value };
  // Picking a theme also records which side of the switch it belongs to.
  if (key === 'theme') {
    current[isDark(current.theme) ? 'darkTheme' : 'lightTheme'] = current.theme;
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
  for (const workspace of WORKSPACES) document.body.classList.toggle(`workspace-${workspace.id}`, current.workspace === workspace.id);
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
    el('div', { class: `set-swatch theme-preview theme-preview-${theme.id}`, 'aria-hidden': 'true', style: `--preview-paper:${theme.swatch[0]};--preview-ink:${theme.swatch[1]};--preview-accent:${theme.swatch[2]}` }, [
      el('i', { class: 'preview-top' }, [el('b'), el('b'), el('b')]),
      el('i', { class: 'preview-rail' }),
      el('i', { class: 'preview-main' }, [el('b'), el('b'), el('b'), el('b')]),
      el('i', { class: 'preview-accent' }),
    ]),
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

let coachPicker = null;
let panel = null;
let scrim = null;

export function closeSettings() {
  coachPicker?.dispose(); coachPicker = null;
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

  coachPicker = createCoachModelPicker();
  panel = el('aside', { class: 'settings', role: 'dialog', 'aria-label': 'Settings' }, [
    el('div', { class: 'set-head' }, [
      el('span', { class: 'mono dim', text: 'Settings' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ws-mini', type: 'button', text: 'Done', onclick: closeSettings }),
    ]),
    el('div', { class: 'set-body' }, [
      el('div', { class: 'mono dim set-label', text: 'Coach' }),
      coachPicker.root,
      el('p', { class: 'set-cardblurb', text: 'Applies to new coach and system-design replies. Each CLI uses its own sign-in and limits. Codex saves chats through Studio; automatic note edits are Claude-only.' }),
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

function settingsGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M9.5 3h5l.6 2.5 2 .9 2.3-.8 2.5 4.3-1.8 1.8v2.3l1.8 1.8-2.5 4.3-2.3-.8-2 .9-.6 2.5h-5l-.6-2.5-2-.9-2.3.8-2.5-4.3 1.8-1.8v-2.3L1.6 9.9l2.5-4.3 2.3.8 2-.9Z M15.5 12.8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 1 1 7 0');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.5');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
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
    class: 'set-open set-settings', type: 'button', title: 'Settings — theme and editor',
    'aria-label': 'Settings',
    onclick: openSettings,
  }, settingsGlyph()));
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
