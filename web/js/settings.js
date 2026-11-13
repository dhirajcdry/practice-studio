import { segmented } from './ui/segmented.js';
import { THEMES, themeById, LAYOUTS } from './themes.js';
import { dialogHeader } from './ui/headers.js';
import { openContextInspector } from './context-inspector.js';
// Settings: the theme, and how the editor reads.
//
// Everything here is stored locally and applied before first paint, so choosing a theme
// never costs a flash of the previous one.

import { el, replace } from './dom.js';
import { openCoachingInstructions } from './coaching-instructions.js';
import { createSpeaker } from './speech.js';
import { NATURAL_VOICES, voicePreferences, saveVoicePreferences, autoSendEnabled, saveAutoSend } from './speech-preferences.js';
import { CHORDS } from './shortcuts.js';
import { createCoachModelPicker } from './coach-model.js';
import { createSelect } from './ui/select.js';
import { REPORT_DIFFICULTIES, reportDifficultyLabel } from './interview-format.js';

const STORE_KEY = 'studio.settings.v1';

// Shuffle's local preference is independent of appearance settings.
const SHUFFLE_KEY = 'studio.shuffle-source.v1';
export function getShuffleSource() {
  try { return localStorage.getItem(SHUFFLE_KEY) === 'leetcode' ? 'leetcode' : 'studio'; }
  catch { return 'studio'; }
}
let shuffleSource = getShuffleSource();
export function shuffleSourceSetting() { return shuffleSource; }
function shuffleSourceControl() {
  return createSelect({ label: 'Shuffle picks from', value: shuffleSource,
    options: [['studio', "Studio's problems"], ['leetcode', 'All of LeetCode']],
    onChange: event => {
      shuffleSource = event.target.value === 'leetcode' ? 'leetcode' : 'studio';
      try { localStorage.setItem(SHUFFLE_KEY, shuffleSource); } catch { /* forgets */ }
      for (const fn of listeners) fn(getSettings());
    },
  });
}

// A family keeps its character in either appearance. The list lives in themes.js.
export { THEMES, themeById };

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
const LEGACY = { paper: 'studio', slate: 'studio', editorial: 'studio', ink: 'studio', blueprint: 'studio', phosphor: 'studio', nebula: 'studio', horizon: 'studio', abyss: 'studio' };

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    let theme = THEMES.some(t => t.id === raw.theme) ? raw.theme : DEFAULTS.theme;
    let mode = ['system', 'light', 'dark'].includes(raw.mode) ? raw.mode : undefined;
    if (!THEMES.some(t => t.id === raw.theme) && LEGACY[raw.theme]) theme = LEGACY[raw.theme];
    if (!mode && ['paper', 'slate', 'blueprint', 'phosphor'].includes(raw.theme)) mode = raw.theme === 'paper' ? 'light' : 'dark';
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
    try { document.startViewTransition(commit).ready.catch(() => { /* superseded by a newer theme choice */ }); return; } catch { /* fall through */ }
  }
  commit();
}

/** Put the settings onto the document. Safe to call at any time, including before boot. */
export function apply() {
  const root = document.documentElement;
  for (const name of [...document.body.classList]) {
    if (name.startsWith('theme-')) document.body.classList.remove(name);
  }
  const family = themeById(current.theme);
  document.body.classList.add(`theme-${family.id}`);
  document.body.classList.toggle('theme-art', Boolean(family.art));
  // Pane structure is styled per layout, never per family, so a new family needs no layout CSS.
  for (const layout of LAYOUTS) document.body.classList.toggle(`layout-${layout}`, layout === family.layout);
  // Monaco cannot read CSS variables, so a dark theme has to be told explicitly.
  document.body.classList.toggle('is-dark', isDark());
  root.style.setProperty('--code-size', `${current.codeSize}px`);
  document.body.classList.toggle('motion-off', current.motion === false);
}

/** Pin the opposite appearance without changing the family. */
export function toggleDark() { setSetting('mode', isDark() ? 'light' : 'dark'); }

/* ------------------------------- the panel -------------------------------- */

/** The thumbnail shape a theme row may give as `preview` (docs/UI.md, Themes). */
const PREVIEW_KEYS = ['gap', 'radius', 'border', 'shadow', 'frame', 'bar'];

function themeCard(theme, onPick) {
  const chosen = current.theme === theme.id;
  // On the halves, not the card: a value naming --preview-ink must resolve where that is defined.
  const shape = Object.entries(theme.preview || {}).filter(([key, value]) => PREVIEW_KEYS.includes(key) && value)
    .map(([key, value]) => `--pv-${key}:${value}`).join(';');
  const previewStyle = `--pl-paper:${theme.light.paper};--pl-ink:${theme.light.ink};--pl-accent:${theme.light.accent};--pd-paper:${theme.dark.paper};--pd-ink:${theme.dark.ink};--pd-accent:${theme.dark.accent}`;
  return el('button', {
    class: 'ui-action-row set-card set-theme ui-inset', type: 'button', 'aria-pressed': String(chosen),
    onclick: () => onPick(theme.id),
  }, [
    el('div', {
      class: 'theme-preview', 'data-theme-preview': theme.id, 'data-layout': theme.layout, 'aria-hidden': 'true', ...(theme.art ? { 'data-art': '' } : {}), style: previewStyle,
    }, ['light', 'dark'].map((mode) => el('i', { class: `theme-half ${mode}`, ...(shape ? { style: shape } : {}) }, [
      el('b', { class: 'theme-preview-bar' }),
      el('span', { class: 'theme-preview-panes' }, [el('b'), el('b'), el('b')]),
    ]))),
    el('div', { class: 'set-cardname', text: theme.name }),
    el('div', { class: 'set-cardblurb', text: theme.blurb }),
  ]);
}

/** One keycap per key: "⌘B" set as a single 11px mono chip was not readable. */
function keyRow(keys, what) {
  const combos = (Array.isArray(keys) ? keys : [keys]).map(combo => el('span', { class: 'set-combo' },
    [...combo].map(key => el('kbd', { text: key }))));
  return el('div', { class: 'set-keyrow' }, [
    el('span', { class: 'set-keywhat', text: what }),
    el('span', { class: 'set-keycaps' }, combos),
  ]);
}

/** One setting: its name and a line of explanation on the left, its control on the right. */
function settingRow(name, hint, control, { tag = 'div', extra = null } = {}) {
  return el(tag, { class: 'set-row' }, [
    el('span', { class: 'set-rowtext' }, [
      el('span', { class: 'set-rowname', text: name }),
      hint ? el('span', { class: 'set-rowhint', text: hint }) : null,
      extra,
    ]),
    el('span', { class: 'set-control' }, control),
  ]);
}

async function reportDifficultyRequest(options) {
  const response = await fetch('/api/report/difficulty', { ...options, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error(`Report difficulty request failed: ${response.status}`);
  const { difficulty } = await response.json();
  if (!reportDifficultyLabel(difficulty)) throw Error('Unknown report difficulty');
  return difficulty;
}

// Settled before a reopened panel reads, so it can't show the value being replaced.
let difficultySave = Promise.resolve();

/** Reports are written on the server, so this choice lives there, not in localStorage. */
function createReportDifficultyControl() {
  let selected = null, loaded = false, saving = false;
  const notice = el('div', { class: 'coach-model-notice set-notice', role: 'status', hidden: true });
  const say = (text) => { notice.textContent = text; notice.hidden = !text; };
  const seg = segmented({ label: 'Report difficulty', className: 'set-seg', options: REPORT_DIFFICULTIES, value: null, onChange: id => { void choose(id); } });
  seg.setAttribute('aria-busy', 'true');
  const buttons = [...seg.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; button.dataset.difficulty = button.dataset.value; });
  // The buttons stay mounted so keyboard focus survives a save.
  const paint = () => {
    seg.setAttribute('aria-busy', String(!loaded || saving));
    for (const button of buttons) {
      button.disabled = !loaded;
      button.setAttribute('aria-pressed', String(button.dataset.difficulty === selected));
    }
  };
  async function choose(id) {
    if (!loaded || saving || id === selected) return;
    const previous = selected;
    selected = id; saving = true; say(''); paint();
    const save = reportDifficultyRequest({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ difficulty: id }) });
    difficultySave = save.catch(() => {});
    try { selected = await save; } catch {
      selected = previous;
      say(`Could not save. Reports will still use ${reportDifficultyLabel(previous)}.`);
    }
    saving = false; paint();
  }
  difficultySave.then(() => reportDifficultyRequest({})).then((difficulty) => { selected = difficulty; loaded = true; paint(); })
    .catch(() => { say('Could not load the report difficulty. Reopen Settings to retry.'); });
  return { seg, notice };
}

let trackerSaving = false;
function createTrackerControl() {
  let loaded = false, resetAt = null;
  const notice = el('p', { class: 'set-rowhint set-status', role: 'status', hidden: true });
  const say = text => { notice.textContent = text; notice.hidden = !text; };
  // Reset arms on the first click and acts on the second, like the editor's Reset.
  // Undo appears only once a reset exists, so it can't be hit by the same gesture.
  let armed = false, disarmTimer = 0;
  const disarm = () => { armed = false; clearTimeout(disarmTimer); paint(); };
  const reset = el('button', { class: 'btn btn--secondary tracker-reset-all', type: 'button', disabled: true, onclick: () => {
    if (!armed) { armed = true; paint(); disarmTimer = setTimeout(disarm, 4000); return; }
    disarm(); void change('reset');
  } });
  reset.addEventListener('blur', () => { if (armed) disarm(); });
  const since = el('span', { class: 'set-rowhint tracker-since' });
  const restore = el('button', { class: 'btn btn--quiet tracker-restore-all', type: 'button', text: 'Undo reset', disabled: true, onclick: () => change('restore') });
  const restoreRow = el('div', { class: 'set-row', hidden: true }, [el('span', { class: 'set-rowtext' }, since), el('span', { class: 'set-control' }, restore)]);
  const paint = () => {
    reset.textContent = armed ? 'Click again to reset' : 'Reset progress';
    reset.disabled = !loaded || trackerSaving;
    restoreRow.hidden = !resetAt;
    restore.disabled = !loaded || trackerSaving;
    if (resetAt) since.textContent = `Tracker counting from ${new Date(resetAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`;
  };
  async function change(action) {
    if (!loaded || trackerSaving) return;
    trackerSaving = true; paint(); say('');
    try {
      const response = await fetch(`/api/tracker/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!response.ok) throw Error('Tracker could not be updated. Please try again.');
      const result = await response.json(); resetAt = result.resetAt || null;
      say(action === 'reset' ? 'Tracker reset. Your code, attempts, conversations, notes, and results are preserved.' : 'Reset undone. The tracker shows your full history again.');
      window.dispatchEvent(new Event('studio-tracker-changed'));
    } catch (error) { say(error.message); }
    finally { trackerSaving = false; paint(); }
  }
  fetch('/api/tracker').then(async response => {
    if (!response.ok) throw Error('Could not load tracker. Reopen Settings to retry.');
    const result = await response.json(); resetAt = result.resetAt || null; loaded = true; paint();
  }).catch(error => say(error.message));
  return el('section', { class: 'set-group', 'aria-label': 'Problem tracker' }, [
    settingRow('Problem tracker', 'Start a fresh round across all problems. Only tracker progress resets; saved work, history, reports and your streak stay.', reset),
    restoreRow, notice,
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

const SECTION_KEY = 'studio.settings-section.v1';
const SECTIONS = [['coach', 'Coach'], ['practice', 'Practice'], ['voice', 'Voice'], ['appearance', 'Appearance'], ['editor', 'Editor'], ['keys', 'Shortcuts']];
function savedSection() {
  try { const id = localStorage.getItem(SECTION_KEY); return SECTIONS.some(([s]) => s === id) ? id : 'coach'; }
  catch { return 'coach'; }
}

/** Opens on the section last used, or on `section` when a caller names one. */
export function openSettings(section) {
  if (panel) { closeSettings(); return; }

  opener = document.activeElement;
  const themeCards = el('div', { class: 'set-cards set-themes' });
  const modeSeg = segmented({ label: 'Appearance', className: 'set-seg', value: current.mode,
    options: ['system', 'light', 'dark'].map(id => ({ id, label: id[0].toUpperCase() + id.slice(1) })), onChange: mode => setSetting('mode', mode) });
  const pictureSeg = segmented({ label: 'Coach pictures', className: 'set-seg', value: current.coachPictures,
    options: [{ id: 'auto', label: 'Auto' }, { id: 'ask', label: 'Ask first' }, { id: 'off', label: 'Off' }], onChange: mode => setSetting('coachPictures', mode) });
  const rerender = () => {
    modeSeg.setValue(current.mode); pictureSeg.setValue(current.coachPictures);
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
  const switchRow = (name, hint, checked, onChange) => settingRow(name, hint, el('input', {
    type: 'checkbox', role: 'switch', class: 'ui-switch set-check', 'aria-label': name,
    ...(checked ? { checked: 'checked' } : {}), onchange: event => onChange(event.target.checked),
  }), { tag: 'label' });
  const toggle = (key, name, hint) => switchRow(name, hint, current[key], value => setSetting(key, value));

  const voicePrefs = voicePreferences();
  const voiceEngine = createSelect({ label: 'Speech output', value: voicePrefs.engine, options: [['natural','Natural (on-device)'], ['system','System']], onChange: event => {
    saveVoicePreferences({ engine: event.target.value }); voicePreview?.cancel();
    voicePicker.disabled = event.target.value === 'system';
  }});
  const voicePicker = createSelect({ label: 'Natural voice', value: voicePrefs.voice, options: NATURAL_VOICES, onChange: event => {
    saveVoicePreferences({ voice: event.target.value }); voicePreview?.cancel();
  }});
  voicePicker.disabled = voicePrefs.engine === 'system';
  const speedValue = el('span', { class: 'mono dim set-value', text: `${voicePrefs.speed.toFixed(1)}×` });
  const voiceSpeed = el('input', { type: 'range', min: '0.5', max: '2', step: '0.1', value: String(voicePrefs.speed),
    class: 'set-range', 'aria-label': 'Speech speed', oninput: event => {
      const speed = Number(event.target.value); saveVoicePreferences({ speed }); speedValue.textContent = `${speed.toFixed(1)}×`;
    },
  });
  const preview = el('button', { class: 'btn btn--quiet ws-mini', type: 'button', text: 'Preview', 'aria-label': 'Preview voice', onclick: () => {
    voicePreview ??= createSpeaker(); voicePreview.cancel();
    voicePreview.say('Let’s walk through your approach. What would you try first?');
  } });
  coachPicker = createCoachModelPicker();
  const reportDifficulty = createReportDifficultyControl();
  const opens = (label, className, open) => el('button', { class: `btn btn--secondary ${className}`, type: 'button', text: label, onclick: () => { closeSettings(); void open(); } });

  const pages = {
    coach: [
      el('div', { class: 'set-group' }, [
        settingRow('Model', 'Answers new replies in coding, LLD and system design. Each provider uses its own sign-in and limits.', coachPicker.root),
        settingRow('Pictures', 'Painted by Codex in 30–60 seconds from your ChatGPT image allowance. Ask first shows a button; Off keeps the description. Illustrations are always instant and free.', pictureSeg),
        settingRow('Coaching instructions', 'How the coach teaches. It can refine them, and every change can be undone.', opens('Open', 'set-open-instructions', openCoachingInstructions)),
        settingRow('Context sent to the coach', 'Exactly what each recent turn included.', opens('View', 'set-open-context', openContextInspector)),
      ]),
    ],
    practice: [
      el('div', { class: 'set-group' }, [
        settingRow('Report difficulty', "Beginner grades a step below the mid-level (SDE II / L4) bar while you're learning. Saved reports keep the difficulty they were graded at.", reportDifficulty.seg, { extra: reportDifficulty.notice }),
        settingRow('Shuffle picks from', null, shuffleSourceControl()),
      ]),
      createTrackerControl(),
    ],
    voice: [
      el('section', { class: 'set-group set-voice', 'aria-label': 'Voice' }, [
        settingRow('Speech output', 'Natural voices run on this Mac. If one is unavailable, the system voice is used.', voiceEngine),
        settingRow('Voice', null, [voicePicker, preview]),
        settingRow('Speed', null, [voiceSpeed, speedValue], { tag: 'label' }),
        switchRow('Send when I pause', 'Off means you send each answer with the arrow.', autoSendEnabled(), saveAutoSend),
      ]),
    ],
    appearance: [
      el('div', { class: 'set-group' }, [settingRow('Mode', null, modeSeg)]),
      el('div', { class: 'set-group' }, [el('div', { class: 'set-label', text: 'Theme' }), themeCards]),
      el('div', { class: 'set-group' }, [
        toggle('motion', 'Animations'),
        toggle('celebrations', 'Celebrations', 'A full-page moment when a submission is accepted.'),
      ]),
    ],
    editor: [
      el('div', { class: 'set-group' }, [
        settingRow('Code size', null, [size, sizeValue], { tag: 'label' }),
        toggle('typingFx', 'Typing effects', 'Each character reveals itself as you type.'),
        toggle('typingSparks', 'Sparks', 'A few sparks and a soft glow at the caret.'),
      ]),
    ],
    // Listed, not configurable. A shortcut you can rebind is a shortcut you have to
    // remember twice; what this is for is answering "what was it again".
    keys: [
      el('div', { class: 'set-keys' }, [
        ...CHORDS.map((c) => keyRow(c.label, `Show or hide ${c.what}`)),
        keyRow(['⌘←', '⌘→'], 'Move to the previous or next problem'),
        keyRow('⌘↵', 'Submit to LeetCode'),
        keyRow("⌘'", 'Run the example cases here'),
        keyRow('⌘S', 'Save to disk now'),
      ]),
    ],
  };

  const body = el('div', { class: 'set-body' });
  const tabs = SECTIONS.map(([id, label]) => el('button', {
    type: 'button', class: 'btn btn--quiet set-nav-item', role: 'tab', id: `set-tab-${id}`, 'aria-controls': `set-page-${id}`,
    dataset: { setTab: id }, text: label, onclick: () => show(id),
  }));
  const panels = SECTIONS.map(([id]) => el('div', {
    class: 'set-page', role: 'tabpanel', id: `set-page-${id}`, 'aria-labelledby': `set-tab-${id}`, dataset: { setPage: id },
  }, pages[id]));
  function show(id, { focus = false } = {}) {
    SECTIONS.forEach(([section], index) => {
      const active = section === id;
      tabs[index].setAttribute('aria-selected', String(active));
      tabs[index].tabIndex = active ? 0 : -1;
      panels[index].hidden = !active;
      if (active && focus) tabs[index].focus();
    });
    body.scrollTop = 0;
    try { localStorage.setItem(SECTION_KEY, id); } catch { /* forgets */ }
  }
  const nav = el('nav', { class: 'set-nav', role: 'tablist', 'aria-label': 'Settings sections', 'aria-orientation': 'vertical',
    onkeydown: (event) => {
      const at = tabs.indexOf(document.activeElement);
      const to = { ArrowDown: at + 1, ArrowRight: at + 1, ArrowUp: at - 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
      if (at < 0 || to === undefined) return;
      event.preventDefault();
      show(SECTIONS[(to + tabs.length) % tabs.length][0], { focus: true });
    },
  }, tabs);
  body.append(...panels);

  panel = el('aside', { class: 'settings', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' }, [
    dialogHeader({ title: 'Settings', onClose: closeSettings, closeLabel: 'Close settings' }),
    el('div', { class: 'set-layout' }, [nav, body]),
  ]);
  scrim = el('div', { class: 'set-scrim', onclick: closeSettings });
  document.body.append(scrim, panel);
  document.body.classList.add('settings-open');
  show(SECTIONS.some(([id]) => id === section) ? section : savedSection(), { focus: true });
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
    class: 'btn btn--icon set-open set-daynight', type: 'button',
    onclick: () => { toggleDark(); paintDayNight(dayNight); },
  }, [dayNightGlyph()]);
  paintDayNight(dayNight);
  // Settings can change the theme too, and the switch must not sit there claiming the
  // opposite of what is on screen.
  onSettingsChange(() => paintDayNight(dayNight));

  mountEl.append(dayNight);
  mountEl.append(el('button', {
    class: 'btn btn--icon set-open set-settings', type: 'button', title: 'Settings',     'aria-label': 'Settings',
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
      .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }
  if (event.key === 'Escape' && panel) { event.preventDefault(); closeSettings(); }
});

apply();
