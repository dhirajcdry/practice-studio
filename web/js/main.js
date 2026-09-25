// Boot, routing, persisted UI state, and the global keyboard map.

import { el, replace } from './dom.js';
import { loadCatalog, api } from './api.js';
import { renderBrowse, visibleProblems, filteredProblems } from './browse.js';
import { renderProblem, openPanel, closeDrawer, isDrawerOpen, setDrawerListener, drawerKind } from './problem.js';
import { init as initDashboard } from './dashboard.js';
import { initDesign } from './design.js';
import { coachBeginAttempt, coachReviewAttempt } from './coach.js';
import { installResizers } from './resize.js';
import { installRecorder, removeRecorder } from './recorder.js';
import { installSettingsButton, apply as applySettings, onSettingsChange } from './settings.js';

let dashboard = null;
let design = null;

const appEl = document.getElementById('app');
const searchEl = document.getElementById('q');
const bannerEl = document.getElementById('banner');
const scrimEl = document.getElementById('scrim');

const STORE_KEY = 'studio.browse.v1';

const state = {
  query: '',
  list: 'neetcode250',
  difficulty: 'all',
  collapsed: new Set(),
  selectedSlug: null,
};

let data = { problems: [], patterns: [] };
let bySlug = new Map();

/* ------------------------------- persistence ------------------------------- */

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    if (typeof saved.list === 'string') state.list = saved.list;
    if (typeof saved.difficulty === 'string') state.difficulty = saved.difficulty;
    if (Array.isArray(saved.collapsed)) state.collapsed = new Set(saved.collapsed);
    return saved.hasSavedCollapse === true;
  } catch { return false; }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      list: state.list,
      difficulty: state.difficulty,
      collapsed: [...state.collapsed],
      hasSavedCollapse: true,
    }));
  } catch { /* private browsing — the app still works, just forgets */ }
}

/* --------------------------------- routing --------------------------------- */

function currentSlug() {
  const match = /^#\/p\/(.+)$/.exec(location.hash);
  return match ? decodeURIComponent(match[1]) : null;
}

function goBrowse() { location.hash = '#/'; }
function goProblem(slug) { location.hash = '#/p/' + encodeURIComponent(slug); }

function neighboursOf(slug) {
  const list = filteredProblems(data, state);
  const index = list.findIndex(p => p.slug === slug);
  if (index < 0) return { previous: null, next: null };
  return { previous: list[index - 1] || null, next: list[index + 1] || null };
}

const handlers = {
  onOpen: (slug) => { state.selectedSlug = slug; goProblem(slug); },
  onBack: () => goBrowse(),
  onToggle: (pattern) => {
    if (state.collapsed.has(pattern)) state.collapsed.delete(pattern);
    else state.collapsed.add(pattern);
    saveState(); render();
  },
  onToggleAll: (collapseAll) => {
    state.collapsed = collapseAll ? new Set(data.patterns) : new Set();
    saveState(); render();
  },
  onList: (id) => { state.list = id; saveState(); render(); },
  onDifficulty: (value) => { state.difficulty = value; saveState(); render(); },
  onClear: () => {
    state.query = ''; searchEl.value = '';
    state.list = 'neetcode250'; state.difficulty = 'all';
    saveState(); render();
  },
};

/* ------------------------------- section menu ------------------------------ */

const navButton = document.getElementById('navbtn');
const navLabel = document.getElementById('navlabel');
const navMenu = document.getElementById('navmenu');

function navItems() {
  return [...navMenu.querySelectorAll('a')];
}

function closeNav(refocus = false) {
  if (navMenu.hidden) return;
  navMenu.hidden = true;
  navButton.setAttribute('aria-expanded', 'false');
  // Closing with the keyboard must put the caret back on the button it came from,
  // otherwise focus lands on <body> and the next Tab starts the page over.
  if (refocus) navButton.focus();
}

function openNav(focusIndex = -1) {
  navMenu.hidden = false;
  navButton.setAttribute('aria-expanded', 'true');
  const items = navItems();
  if (focusIndex >= 0 && items.length) items[(focusIndex + items.length) % items.length].focus();
}

function moveNavFocus(step) {
  const items = navItems();
  const index = items.indexOf(document.activeElement);
  items[((index < 0 ? 0 : index + step) + items.length) % items.length].focus();
}

navButton.addEventListener('click', () => {
  if (navMenu.hidden) openNav(); else closeNav();
});

navButton.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); openNav(0); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); openNav(-1); }
});

// The menu's own keys are handled before the app's global map sees them, so Escape here
// closes the menu rather than clearing the search box behind it.
navMenu.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { event.stopPropagation(); closeNav(true); }
  else if (event.key === 'ArrowDown') { event.preventDefault(); moveNavFocus(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveNavFocus(-1); }
  else if (event.key === 'Tab') closeNav();
});

// Choosing an item routes through the hash like any other link; the menu just gets out
// of the way. Clicking the section you are already on changes no hash and fires no
// hashchange, so the close cannot wait for the re-render.
navMenu.addEventListener('click', () => closeNav(true));

document.addEventListener('pointerdown', (event) => {
  if (!navMenu.hidden && !event.target.closest('.topnav')) closeNav();
});

/** Mark the section nav from the hash, so it can never disagree with the route. */
function markNav() {
  const hash = location.hash || '#/';
  // A deep-linked interview is still the Design section, the same way a problem page
  // is still Problems.
  const route = hash.startsWith('#/p/') ? '#/'
    : hash.startsWith('#/design/') ? '#/design'
      : hash;

  let current = null;
  for (const link of document.querySelectorAll('.topnav a')) {
    if (link.dataset.route === route) { link.setAttribute('aria-current', 'page'); current = link; }
    else link.removeAttribute('aria-current');
  }

  // The button names the LeetCode section you are in. When you are somewhere that is
  // not in its menu — a system design interview — it goes back to naming the group,
  // because claiming "Problems" while you are on the design screen would be a lie
  // about where you are, which is the one job this button has.
  const inMenu = current && navItems().includes(current);
  navLabel.textContent = inMenu ? current.textContent : 'LeetCode';
  navButton.classList.toggle('quiet', !inMenu);
}

function render() {
  markNav();
  // The dashboard owns its own DOM and its own fetch, so it is torn down explicitly
  // rather than left running behind another screen.
  if (dashboard) { dashboard.destroy?.(); dashboard = null; }
  // The interview owns a live turn and an 8 MB canvas, so leaving the screen tears it
  // down explicitly rather than leaving both running behind another route.
  if (design) { design.destroy?.(); design = null; }
  if (!currentSlug()) removeRecorder();

  if (location.hash === '#/design' || location.hash.startsWith('#/design/')) {
    replace(appEl, el('div', { class: 'view' }));
    design = initDesign(appEl);
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  if (location.hash === '#/progress') {
    replace(appEl, el('div', { class: 'view' }));
    dashboard = initDashboard(appEl, api);
    window.scrollTo({ top: 0, behavior: 'auto' });
    return;
  }

  const slug = currentSlug();
  if (slug) {
    const entry = bySlug.get(slug);
    if (!entry) {
      replace(appEl, el('div', { class: 'view' }, [
        el('div', { class: 'crumb' }, el('button', { class: 'linkbtn', type: 'button', text: '← All problems', onclick: goBrowse })),
        el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
          'There is no problem with the slug ', el('b', { text: slug }), ' in the NeetCode 250.',
        ])),
      ]));
      return;
    }
    state.selectedSlug = slug;
    replace(appEl, renderProblem(entry, { neighbours: neighboursOf(slug), onBack: goBrowse, onOpen: handlers.onOpen }));
    window.scrollTo({ top: 0, behavior: 'auto' });
    installResizers();
    // An attempt belongs to one problem, so navigating to another one ends it: the
    // recorder is disposed here, which closes the window as abandoned rather than
    // leaving it open to swallow the next problem's events. No review fires for an
    // attempt you walked away from.
    //
    // Pressing record starts an attempt and a fresh coach thread; pressing stop closes it
    // and asks for the end-to-end review. That is the whole loop — you never have to type
    // "how did I do", because stopping the recording already said it.
    installRecorder(() => currentSlug(), {
      onAttemptStart: () => coachBeginAttempt(),
      onAttemptEnd: (detail) => {
        if (!detail?.attemptId) return;
        // Nothing was said, so there is nothing to grade. Starting and stopping by
        // accident, or thinking the whole way through in silence, must not spend a
        // coach turn on an interview that has no spoken part to assess.
        if (!detail.spokenMs) return;
        coachReviewAttempt(detail);
      },
    });
    return;
  }

  closeDrawer();
  replace(appEl, renderBrowse(data, state, handlers));
  const selected = state.selectedSlug && appEl.querySelector(`.prow[data-slug="${CSS.escape(state.selectedSlug)}"]`);
  if (selected) selected.scrollIntoView({ block: 'center', behavior: 'auto' });
}

/* -------------------------------- selection -------------------------------- */

function moveSelection(step) {
  const list = visibleProblems(data, state);
  if (!list.length) return;
  const index = list.findIndex(p => p.slug === state.selectedSlug);
  const next = index < 0 ? (step > 0 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, index + step));
  state.selectedSlug = list[next].slug;

  for (const row of appEl.querySelectorAll('.prow')) {
    row.classList.toggle('sel', row.dataset.slug === state.selectedSlug);
  }
  const row = appEl.querySelector(`.prow[data-slug="${CSS.escape(state.selectedSlug)}"]`);
  if (row) row.scrollIntoView({ block: 'nearest' });
}

/* --------------------------------- keyboard -------------------------------- */

function inTextField() {
  const node = document.activeElement;
  return node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName);
}

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (event.key === 'Escape') {
    if (isDrawerOpen()) { closeDrawer(); return; }
    if (inTextField()) { searchEl.blur(); return; }
    if (state.query) { state.query = ''; searchEl.value = ''; render(); return; }
    if (currentSlug()) goBrowse();
    return;
  }

  if (event.key === '/' && !inTextField()) {
    event.preventDefault();
    if (currentSlug()) goBrowse();
    searchEl.focus(); searchEl.select();
    return;
  }

  if (inTextField()) {
    if (event.key === 'Enter') {
      const list = visibleProblems(data, state);
      if (list.length) { searchEl.blur(); handlers.onOpen(list[0].slug); }
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); searchEl.blur(); moveSelection(1); }
    return;
  }

  const slug = currentSlug();

  if (slug) {
    const entry = bySlug.get(slug);
    if (!entry) return;
    if (event.key === 's') { event.preventDefault(); openPanel(entry, 'solution'); return; }
    if (event.key === 'a') { event.preventDefault(); openPanel(entry, 'article'); return; }
    if (isDrawerOpen()) return;
    const { previous, next } = neighboursOf(slug);
    if ((event.key === 'j' || event.key === 'ArrowDown') && next) { event.preventDefault(); handlers.onOpen(next.slug); }
    if ((event.key === 'k' || event.key === 'ArrowUp') && previous) { event.preventDefault(); handlers.onOpen(previous.slug); }
    return;
  }

  if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); moveSelection(1); }
  else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(-1); }
  else if (event.key === 'Enter' && state.selectedSlug) { event.preventDefault(); handlers.onOpen(state.selectedSlug); }
});

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  if (currentSlug()) { goBrowse(); return; } // hashchange re-renders
  render();
});

scrimEl.addEventListener('click', closeDrawer);
window.addEventListener('hashchange', render);

setDrawerListener(() => {
  for (const button of document.querySelectorAll('.ptoggle')) {
    button.setAttribute('aria-pressed', String(drawerKind() === button.dataset.panel));
  }
});

/* ----------------------------------- boot ---------------------------------- */

function showBanner(message) {
  document.body.classList.add('has-banner');
  bannerEl.hidden = false;
  replace(bannerEl, [
    el('span', { class: 'bhead', text: 'Offline demo' }),
    el('span', { class: 'btext', text: message }),
    el('button', { class: 'blink', type: 'button', text: 'Retry connection', onclick: () => location.reload() }),
  ]);
}

function setSourceLabel() {
  const dot = document.getElementById('srcDot');
  const label = document.getElementById('srcLabel');
  dot.dataset.state = api.mode;
  label.textContent = api.mode === 'live' ? 'Live' : 'Sample data';
  label.title = api.mode === 'live' ? 'Served by the studio server' : api.reason;
}

async function boot() {
  applySettings();
  installSettingsButton(document.getElementById('setmount'));
  // A layout change moves the panes, so anything that measured them has to measure
  // again — the resize handles sit in the gaps between columns that just moved.
  onSettingsChange(() => { if (currentSlug()) installResizers(); });

  const hadSavedCollapse = loadState();
  try {
    data = await loadCatalog();
  } catch (error) {
    replace(appEl, el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
      'The problem list could not be loaded at all — not from the server, and not from the bundled copy. ',
      'That means files are missing from web/mock/, so there is nothing this page can show.',
    ])));
    document.getElementById('srcLabel').textContent = 'Failed';
    return;
  }

  bySlug = new Map(data.problems.map(p => [p.slug, p]));

  // First visit: show the shape of the curriculum — first pattern open, rest closed.
  if (!hadSavedCollapse) {
    state.collapsed = new Set(data.patterns.slice(1));
    saveState();
  }

  setSourceLabel();
  if (api.mode === 'mock') showBanner(api.reason);

  render();
}

boot();
