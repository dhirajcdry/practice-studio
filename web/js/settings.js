// Settings: the theme, and how the editor reads.
//
// Everything here is stored locally and applied before first paint, so choosing a theme
// never costs a flash of the previous one.

import { el, replace } from './dom.js';
import { createSpeaker } from './speech.js';
import { NATURAL_VOICES, voicePreferences, saveVoicePreferences } from './speech-preferences.js';
import { CHORDS } from './shortcuts.js';
import { createCoachModelPicker } from './coach-model.js';

const STORE_KEY = 'studio.settings.v1';

// A family keeps its character in either appearance.
export const THEMES = [
  { id: 'studio', name: 'Studio', blurb: 'Clean and docked. Panes meet edge to edge.', light: { paper: '#F3F4F6', ink: '#111111', accent: '#355DCC' }, dark: { paper: '#121212', ink: '#E8E8E8', accent: '#91A7FF' } },
  { id: 'desk', name: 'Desk', blurb: 'Soft and rounded. Panes float on warm paper.', light: { paper: '#F6F4F0', ink: '#181818', accent: '#AC5636' }, dark: { paper: '#171513', ink: '#EEE8E0', accent: '#E2875F' } },
  { id: 'editorial', name: 'Editorial', blurb: 'Serif prose, double rules, a printed page.', light: { paper: '#F4EFE6', ink: '#1A1614', accent: '#9B2C2C' }, dark: { paper: '#16120F', ink: '#ECE3D4', accent: '#E07B6E' } },
  { id: 'ink', name: 'Ink', blurb: 'Banded headers, heavy rules, no rounding.', light: { paper: '#EDEDEA', ink: '#0A0A0A', accent: '#1B49F5' }, dark: { paper: '#0B0B0B', ink: '#F4F4F0', accent: '#6E8BFF' } },
  { id: 'terminal', name: 'Terminal', blurb: 'Split panes, a status line, [ bracketed ] controls.', light: { paper: '#F3F1E7', ink: '#17301F', accent: '#9E5C00' }, dark: { paper: '#0D0D0D', ink: '#D9DED9', accent: '#5FD38D' } },
  { id: 'nebula', name: 'Nebula', blurb: 'An observatory readout: bracketed frames, lit controls.', art: true, light: { paper: '#F6F3FB', ink: '#1D1733', accent: '#6B3FD4' }, dark: { paper: '#0B0A1A', ink: '#ECE8FF', accent: '#B69CFF' } },
  { id: 'horizon', name: 'Event Horizon', blurb: 'Art deco in gold: double rules, Didot, gilt buttons.', art: true, light: { paper: '#FBF6EC', ink: '#22180C', accent: '#B4600A' }, dark: { paper: '#08070A', ink: '#F3ECE0', accent: '#FFB25C' } },
  { id: 'abyss', name: 'Abyss', blurb: 'Rounded and soft-lit, like something glowing in the deep.', art: true, light: { paper: '#EEF8F8', ink: '#0B2A33', accent: '#00808A' }, dark: { paper: '#04101A', ink: '#DDF6F7', accent: '#3FF0D0' } },
  { id: 'dunes', name: 'Twin Suns', blurb: 'Matte field kit: survey stripes, two suns, two shadows.', art: true, light: { paper: '#FBF2E8', ink: '#2A1A10', accent: '#C2491D' }, dark: { paper: '#08141A', ink: '#E9E4DA', accent: '#FF9A62' } },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

export function isDark() {
  return current.mode === 'dark' || (current.mode === 'system' && systemPrefersDark());
}

function systemPrefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** What the operating system is set to, when nothing has been chosen here yet. */
function systemPrefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch { return false; }
}

const DEFAULTS = { theme: 'studio', mode: 'system', codeSize: 14, motion: true, typingFx: true, typingSparks: false, celebrations: true, coachPictures: 'auto' };
// Codex pictures spend the user's image quota, so how eagerly the coach may make one is his call.
export const PICTURE_MODES = ['auto', 'ask', 'off'];
const LEGACY = { paper: ['studio', 'light'], slate: ['studio', 'dark'], editorial: ['editorial', 'light'], ink: ['ink', 'light'], blueprint: ['studio', 'dark'], phosphor: ['terminal', 'dark'] };

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    let theme = THEMES.some(t => t.id === raw.theme) ? raw.theme : DEFAULTS.theme;
    let mode = ['system', 'light', 'dark'].includes(raw.mode) ? raw.mode : undefined;
    if (!THEMES.some(t => t.id === raw.theme) && LEGACY[raw.theme]) [theme, mode] = LEGACY[raw.theme];
    return {
      theme, mode: mode || DEFAULTS.mode,
      codeSize: Number(raw.codeSize) >= 10 && Number(raw.codeSize) <= 20 ? Number(raw.codeSize) : DEFAULTS.codeSize,
      // Never chosen here: follow the system's reduce-motion setting rather than assume.
      motion: typeof raw.motion === 'boolean' ? raw.motion : !systemPrefersReducedMotion(),
      typingFx: raw.typingFx !== false,
      // The reveal is the typing effect; sparks are an extra he opts into.
      typingSparks: raw.typingSparks === true,
      celebrations: raw.celebrations !== false,
      coachPictures: PICTURE_MODES.includes(raw.coachPictures) ? raw.coachPictures : DEFAULTS.coachPictures,
    };
  } catch {
    return { ...DEFAULTS }; // private browsing: it works, it just forgets
  }
}

let current = read();
const listeners = new Set();
try {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change', () => {
    if (current.mode !== 'system') return;
    apply();
    for (const fn of listeners) fn(getSettings());
  });
} catch { /* browser without media queries */ }

export function getSettings() { return { ...current, dark: isDark() }; }
export function onSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function setSetting(key, value) {
  if (current[key] === value) return;
  if (!['theme', 'mode', 'codeSize', 'motion', 'typingFx', 'typingSparks', 'celebrations', 'coachPictures'].includes(key)) return;
  if (key === 'coachPictures' && !PICTURE_MODES.includes(value)) return;
  if (key === 'theme' && !THEMES.some(t => t.id === value)) return;
  if (key === 'mode' && !['system', 'light', 'dark'].includes(value)) return;
  current = { ...current, [key]: value };
  const { theme, mode, codeSize, motion, typingFx, typingSparks, celebrations, coachPictures } = current;
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ theme, mode, codeSize, motion, typingFx, typingSparks, celebrations, coachPictures })); } catch { /* forgets */ }
  const commit = () => { apply(); for (const fn of listeners) fn(getSettings()); };
  // A new theme or appearance crossfades instead of repainting in one jarring frame, which
  // also hides the frame where the page has switched and Monaco has not yet. Only these two
  // keys: the code-size slider fires on every pixel of a drag. Opacity only, so it stays
  // on with motion off.
  if ((key === 'theme' || key === 'mode') && typeof document.startViewTransition === 'function') {
    try { document.startViewTransition(commit); return; } catch { /* fall through */ }
  }
  commit();
}

/** Put the settings onto the document. Safe to call at any time, including before boot. */
export function apply() {
  const root = document.documentElement;
  for (const name of [...document.body.classList]) {
    if (name.startsWith('theme-')) document.body.classList.remove(name);
  }
  document.body.classList.add(`theme-${current.theme}`);
  document.body.classList.toggle('theme-art', Boolean(themeById(current.theme).art));
  // Monaco cannot read CSS variables, so a dark theme has to be told explicitly.
  document.body.classList.toggle('is-dark', isDark());
  root.style.setProperty('--code-size', `${current.codeSize}px`);
  document.body.classList.toggle('motion-off', current.motion === false);
}

/** Pin the opposite appearance without changing the family. */
export function toggleDark() { setSetting('mode', isDark() ? 'light' : 'dark'); }

/* ------------------------------- the panel -------------------------------- */

function themeCard(theme, onPick) {
  const chosen = current.theme === theme.id;
  const previewStyle = `--pl-paper:${theme.light.paper};--pl-ink:${theme.light.ink};--pl-accent:${theme.light.accent};--pd-paper:${theme.dark.paper};--pd-ink:${theme.dark.ink};--pd-accent:${theme.dark.accent}${theme.art ? `;--pl-art:url(img/themes/${theme.id}-light.jpg);--pd-art:url(img/themes/${theme.id}-dark.jpg)` : ''}`;
  return el('button', {
    class: 'set-card set-theme', type: 'button', 'aria-pressed': String(chosen),
    onclick: () => onPick(theme.id),
  }, [
    el('div', {
      class: 'theme-preview', 'data-theme-preview': theme.id, 'aria-hidden': 'true', ...(theme.art ? { 'data-art': '' } : {}), style: previewStyle,
    }, ['light', 'dark'].map((mode) => el('i', { class: `theme-half ${mode}` }, [
      el('b', { class: 'theme-title-line' }),
      el('b', { class: 'theme-text-line' }),
      el('b', { class: 'theme-text-line' }),
      el('b', { class: 'theme-accent-bar' }),
    ]))),
    el('div', { class: 'set-cardname', text: theme.name }),
    el('div', { class: 'set-cardblurb', text: theme.blurb }),
  ]);
}

function keyRow(keys, what) {
  return el('div', { class: 'set-keyrow' }, [
    el('kbd', { class: 'mono', text: keys }),
    el('span', { class: 'set-keywhat', text: what }),
  ]);
}

let voicePreview = null;
let coachPicker = null;
let panel = null;
let opener = null;
let scrim = null;
let stopPanelUpdates = null;

export function closeSettings() {
  voicePreview?.dispose(); voicePreview = null;
  stopPanelUpdates?.(); stopPanelUpdates = null;
  coachPicker?.dispose(); coachPicker = null;
  if (panel) { panel.remove(); panel = null; }
  if (scrim) { scrim.remove(); scrim = null; }
  document.body.classList.remove('settings-open');
  if (opener?.isConnected) opener.focus();
  opener = null;
}

export function openSettings() {
  if (panel) { closeSettings(); return; }

  opener = document.activeElement;
  const themeCards = el('div', { class: 'set-cards set-themes' });
  const modeSeg = el('div', { class: 'set-seg', role: 'group', 'aria-label': 'Appearance' });
  const pictureSeg = el('div', { class: 'set-seg', role: 'group', 'aria-label': 'Coach pictures' });
  const PICTURE_LABELS = { auto: 'Auto', ask: 'Ask first', off: 'Off' };
  const rerender = () => {
    replace(pictureSeg, PICTURE_MODES.map((mode) => el('button', {
      type: 'button', text: PICTURE_LABELS[mode],
      'aria-pressed': String(current.coachPictures === mode), onclick: () => setSetting('coachPictures', mode),
    })));
    replace(modeSeg, ['system', 'light', 'dark'].map((mode) => el('button', {
      type: 'button', text: mode[0].toUpperCase() + mode.slice(1),
      'aria-pressed': String(current.mode === mode), onclick: () => setSetting('mode', mode),
    })));
    replace(themeCards, THEMES.map((t) => themeCard(t, (id) => setSetting('theme', id))));
  };
  rerender();
  stopPanelUpdates = onSettingsChange(rerender);

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
  const toggle = (key, label) => el('label', { class: 'set-row' }, [
    el('span', { class: 'set-rowname', text: label }),
    el('span', { class: 'spacer' }),
    el('input', {
      type: 'checkbox', class: 'set-check', 'aria-label': label,
      ...(current[key] ? { checked: 'checked' } : {}),
      onchange: (event) => setSetting(key, event.target.checked),
    }),
  ]);

  const voicePrefs = voicePreferences();
  const voiceEngine = el('select', { 'aria-label': 'Speech output', onchange: event => {
    saveVoicePreferences({ engine: event.target.value }); voicePreview?.cancel();
    voicePicker.disabled = event.target.value === 'system';
  } }, [['natural', 'Natural (on-device)'], ['system', 'System']].map(([value, text]) =>
    el('option', { value, text, selected: voicePrefs.engine === value })));
  const voicePicker = el('select', { 'aria-label': 'Natural voice', disabled: voicePrefs.engine === 'system',
    onchange: event => { saveVoicePreferences({ voice: event.target.value }); voicePreview?.cancel(); },
  }, NATURAL_VOICES.map(([value, text]) => el('option', { value, text, selected: voicePrefs.voice === value })));
  const speedValue = el('span', { class: 'mono dim set-value', text: `${voicePrefs.speed.toFixed(1)}×` });
  const voiceSpeed = el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(voicePrefs.speed),
    class: 'set-range', 'aria-label': 'Speech speed', oninput: event => {
      const speed = Number(event.target.value); saveVoicePreferences({ speed }); speedValue.textContent = `${speed.toFixed(1)}×`;
    },
  });
  const preview = el('button', { class: 'ws-mini', type: 'button', text: '▶ Preview', 'aria-label': 'Preview voice', onclick: () => {
    voicePreview ??= createSpeaker(); voicePreview.cancel();
    voicePreview.say('Let’s walk through your approach. What would you try first?');
  } });
  const voiceSection = el('section', { class: 'set-voice', 'aria-label': 'Voice' }, [
    el('div', { class: 'mono dim set-label', text: 'Voice' }),
    el('label', { class: 'set-row' }, [el('span', { class: 'set-rowname', text: 'Speech output' }), voiceEngine]),
    el('div', { class: 'set-row' }, [voicePicker, preview]),
    el('label', { class: 'set-row' }, [el('span', { class: 'set-rowname', text: 'Speed' }), voiceSpeed, speedValue]),
    el('p', { class: 'set-cardblurb', text: 'Natural voices run on this Mac. If unavailable, the system voice is used.' }),
  ]);
  coachPicker = createCoachModelPicker();
  panel = el('aside', { class: 'settings', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' }, [
    el('div', { class: 'set-head' }, [
      el('span', { class: 'mono dim', text: 'Settings' }),
      el('span', { class: 'spacer' }),
      el('button', { class: 'ws-mini', type: 'button', text: 'Done', onclick: closeSettings }),
    ]),
    el('div', { class: 'set-body' }, [
      el('div', { class: 'mono dim set-label', text: 'Coach' }),
      coachPicker.root,
      el('p', { class: 'set-cardblurb', text: 'Applies to new coach and system-design replies. Each provider uses its own sign-in and limits. Automatic note updates are available with Claude.' }),
      el('div', { class: 'mono dim set-label', text: 'Coach pictures' }), pictureSeg,
      el('p', { class: 'set-cardblurb', text: 'Illustrations are drawn here instantly and cost nothing. Pictures are painted by Codex in about 30–60 seconds and use your ChatGPT image allowance. Auto paints as soon as the coach asks for one; Ask first shows a button; Off shows only the description.' }),
      voiceSection,
      el('div', { class: 'mono dim set-label', text: 'Appearance' }), modeSeg,
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
      toggle('typingFx', 'Typing effects: each character reveals itself as you type'),
      toggle('typingSparks', 'Sparks too: a few sparks and a soft glow at the caret'),
      toggle('celebrations', 'Celebrate accepted submissions'),
      el('div', { class: 'mono dim set-label', text: 'Keys' }),
      // Listed, not configurable. A shortcut you can rebind is a shortcut you have to
      // remember twice; what this is for is answering "what was it again".
      el('div', { class: 'set-keys' }, [
        ...CHORDS.map((c) => keyRow(c.label, `Show or hide ${c.what}`)),
        keyRow('⌘← · ⌘→', 'Move to the previous or next problem'),
        keyRow('⌘↵', 'Submit to LeetCode'),
        keyRow("⌘'", 'Run the example cases here'),
        keyRow('⌘S', 'Save to disk now'),
      ]),
    ]),
  ]);

  scrim = el('div', { class: 'set-scrim', onclick: closeSettings });
  document.body.append(scrim, panel);
  document.body.classList.add('settings-open');
  panel.querySelector('button').focus();
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
  button.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  button.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

document.addEventListener('keydown', (event) => {
  // Keep keyboard focus inside the modal while the background is covered.
  if (event.key === 'Tab' && panel) {
    const controls = [...panel.querySelectorAll('button,select,input,[tabindex="0"]')]
      .filter(node => !node.disabled && node.getClientRects().length);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }
  if (event.key === 'Escape' && panel) { event.preventDefault(); closeSettings(); }
});

apply();
