// Boot, routing, persisted UI state, and the global keyboard map.

import { el, replace } from './dom.js';
import { registerShortcut } from './keyboard.js';
import { icon } from './ui/icon.js';
import { loadCatalog, api } from './api.js';
import { loadCatalogProgress } from './catalog-progress.js';
import { loadStats } from './streak.js';
import { installStreakPill } from './streak-pill.js';
import { renderBrowse, visibleProblems, filteredProblems, setCollection, isKnownList, LIST_FILTERS } from './browse.js';
import { renderProblemImport } from './problem-import.js';
import { randomProblem, createLeetCodeShuffle } from './shuffle.js';
import { randomViaConnector } from './leetcode-bridge.js';
import { renderRoadmap } from './roadmap.js';
import { renderProblem, showTab, currentTab } from './problem.js';
import { init as initDashboard } from './dashboard.js';
import { initDesign } from './design.js';
import { initLLD } from './lld.js';
import { showInterviewSetup, activeInterview, interviewAction } from './interview.js';
import { coachBeginAttempt, coachReviewAttempt } from './coach.js';
import { installResizers } from './resize.js';
import { loadToolDisplay } from './tool-display.js';
import { installRecorder, mountRecorder } from './recorder.js';
import { installSettingsButton, apply as applySettings, onSettingsChange, shuffleSourceSetting } from './settings.js';

let problemImport = null;
let dashboard = null;
let design = null;
let lld = null;

const appEl = document.getElementById('app');
const searchEl = document.getElementById('q');
const bannerEl = document.getElementById('banner');

const STORE_KEY = 'studio.browse.v1';

const state = {
  catalogMode: 'explorer',
  pattern: null,
  progress: null,
  stats: null,
  progressState: 'loading',
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
    if (saved.catalogMode === 'roadmap') state.catalogMode = 'roadmap';
    if (typeof saved.list === 'string') state.list = saved.list;
    if (typeof saved.difficulty === 'string') state.difficulty = saved.difficulty;
    state.hideSolved = saved.hideSolved === true;
    if (Array.isArray(saved.collapsed)) state.collapsed = new Set(saved.collapsed);
    return saved.hasSavedCollapse === true;
  } catch { return false; }
}

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      catalogMode: state.catalogMode,
      list: state.list,
      difficulty: state.difficulty,
      hideSolved: state.hideSolved === true,
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

function goBrowse() { location.hash = state.catalogMode === 'roadmap' ? '#/roadmap' : '#/'; }
function goProblem(slug) { location.hash = '#/p/' + encodeURIComponent(slug); }

function neighboursOf(slug) {
  const list = filteredProblems(data, state);
  const index = list.findIndex(p => p.slug === slug);
  if (index < 0) return { previous: null, next: null };
  return { previous: list[index - 1] || null, next: list[index + 1] || null };
}

/** A random problem from the filtered set, never the one open now (null when none). */
function shuffleTarget() {
  return randomProblem(filteredProblems(data, state), currentSlug());
}

const leetcodeShuffle = createLeetCodeShuffle({
  random: randomViaConnector,
  importProblem: async body => {
    const response = await fetch('/api/problems/import', { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const saved = await response.json();
    if (!response.ok) throw Error(saved.error?.message || 'The problem could not be imported.');
    return saved;
  },
  onOpen: ({ entry, slug }) => {
    if (!bySlug.has(slug)) { data.problems.push(entry); bySlug.set(slug, entry); }
    handlers.onOpen(slug);
  },
  onBusy: paintShuffle,
});
function paintShuffle() {
  const busy = leetcodeShuffle.busy;
  const leetcode = shuffleSourceSetting() === 'leetcode';
  for (const button of document.querySelectorAll('.shufflebtn, .pnav-shuffle')) {
    button.disabled = busy || (button.matches('.pnav-shuffle') && !leetcode && !shuffleTarget());
    button.setAttribute('aria-busy', String(busy));
    const label = busy ? 'Finding a LeetCode problem…' : `Random problem from ${leetcode ? 'LeetCode' : 'this view'} (r)`;
    button.setAttribute('aria-label', label); button.title = label;
    const text = button.querySelector('.shuffle-label');
    if (text) text.textContent = button.matches('.shufflebtn') ? (busy ? 'Finding…' : 'Shuffle') : '';
  }
}
async function shuffle() {
  if (leetcodeShuffle.busy) return;
  if (shuffleSourceSetting() !== 'leetcode') {
    const pick = shuffleTarget(); if (pick) handlers.onOpen(pick.slug);
    return;
  }
  document.querySelector('[data-shuffle-notice]')?.remove();
  try { await leetcodeShuffle.run(); }
  catch (error) {
    const notice = el('div', { class: 'submission-toast shuffle-notice', role: 'alert', 'data-shuffle-notice': '' }, [
      el('span', { text: error.message || 'Shuffle could not finish. Try again.' }),
      el('a', { href: 'https://github.com/dhirajcdry/practice-studio/blob/main/docs/SUBMITTING.md', target: '_blank', rel: 'noopener', text: ' Connector setup' }),
      el('button', { class: 'btn btn--quiet', type: 'button', text: 'Dismiss', onclick: () => notice.remove() }),
    ]);
    document.body.append(notice);
  }
}

const handlers = {
  onOpen: (slug) => { state.selectedSlug = slug; goProblem(slug); },
  onBack: () => goBrowse(),
  onShuffle: shuffle,
  shuffleState: () => ({ busy: leetcodeShuffle.busy, leetcode: shuffleSourceSetting() === 'leetcode' }),
  onPattern: (pattern) => { state.pattern = pattern; if (pattern) state.collapsed.delete(pattern); state.selectedSlug = null; render(); appEl.querySelector(pattern ? '.tree-pattern[aria-pressed="true"]' : '.tree-root')?.focus({ preventScroll: true }); },
  onRetryProgress: () => { progressLoadedAt = 0; refreshCatalogProgress(); },
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
  onHideSolved: (value) => { state.hideSolved = value === true; saveState(); render(); },
  onClear: () => {
    state.pattern = null;
    state.query = ''; searchEl.value = '';
    state.list = 'neetcode250'; state.difficulty = 'all'; state.hideSolved = false;
    saveState(); render();
  },
};

/* -------------------------------- section nav ------------------------------- */

const leetcodeLink = document.getElementById('navleetcode');

/** Mark the section nav from the hash, so it can never disagree with the route. */
function markNav() {
  const hash = location.hash || '#/';
  // Everything LeetCode (catalog, roadmap, progress, a problem page, adding one) is the
  // LeetCode section; a deep-linked interview is still its Design or LLD section.
  const route = hash.startsWith('#/p/') || ['#/', '#/roadmap', '#/add', '#/progress'].includes(hash) ? '#/'
    : hash.startsWith('#/lld') ? '#/lld' : hash.startsWith('#/design') ? '#/design'
      : hash;
  // One tap returns to whichever catalog view you last used.
  const mode = hash === '#/roadmap' ? 'roadmap' : hash === '#/' ? 'explorer' : state.catalogMode;
  leetcodeLink.href = mode === 'roadmap' ? '#/roadmap' : '#/';
  for (const link of document.querySelectorAll('.topnav a')) {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

const catalogKey = node => node.dataset.slug || node.getAttribute('aria-label') || node.querySelector('.pname')?.textContent || node.textContent.trim();
const catalogSelector = node => node.tagName.toLowerCase() + (node.classList.length ? '.' + CSS.escape(node.classList[node.classList.length - 1]) : '');

/** Names a catalog node so the same one can be found again after the catalog is redrawn. */
function mark(node) {
  if (!node || node === document.body || !appEl.contains(node)) return null;
  const selector = catalogSelector(node);
  return { selector, key: catalogKey(node), index: [...appEl.querySelectorAll(selector)].indexOf(node), top: node.getBoundingClientRect().top };
}
function find(marked) {
  if (!marked) return null;
  const candidates = [...appEl.querySelectorAll(marked.selector)];
  return candidates.find(node => catalogKey(node) === marked.key) || candidates[marked.index] || null;
}

/**
 * Redraws the catalog where it stands: the control in use keeps focus and stays where it was
 * on screen. The position is held by that control (or the first row in view), not by a pixel
 * offset, because folders off screen are laid out lazily and their heights are estimates.
 */
function redrawCatalog() {
  const focused = mark(document.activeElement), y = window.scrollY;
  const anchor = focused || mark([...appEl.querySelectorAll('.phead, .prow')].find(node => node.getBoundingClientRect().bottom > 0));
  replace(appEl, renderCatalog());
  mountRecorder();
  find(focused)?.focus({ preventScroll: true });
  const again = find(anchor);
  if (!again) { window.scrollTo({ top: y, behavior: 'instant' }); return; }
  // Twice: the first move brings lazily laid out folders into view, which can shift the row again.
  for (let pass = 0; pass < 2; pass++) window.scrollBy({ top: again.getBoundingClientRect().top - anchor.top, behavior: 'instant' });
}

/**
 * @param {boolean|Event} [arrival] true (or the hashchange event) when the route was just
 *   reached. Only then does the catalog bring the last-opened problem into view; a redraw
 *   caused by a control on the page (a folder, a filter, the search) leaves the scroll alone.
 */
function render(arrival) {
  const arrived = arrival === true || arrival instanceof Event;
  installRecorder(currentSlug, {
    getTitle: slug => bySlug.get(slug)?.title || slug,
    onRequestStart: showInterviewSetup,
    getInterview: activeInterview,
    onInterviewAction: interviewAction,
    onAttemptStart: detail => coachBeginAttempt(detail.slug),
    onAttemptEnd: detail => coachReviewAttempt(detail),
  });
  document.body.classList.toggle('browse-page', !currentSlug() && location.hash !== '#/add' && !location.hash.startsWith('#/design') && !location.hash.startsWith('#/lld') && location.hash !== '#/progress');
  if (currentSlug()) progressLoadedAt = 0;
  markNav();
  // The dashboard owns its own DOM and its own fetch, so it is torn down explicitly
  // rather than left running behind another screen.
  if (dashboard) { dashboard.destroy?.(); dashboard = null; }
  // The interview owns a live turn and an 8 MB canvas, so leaving the screen tears it
  // down explicitly rather than leaving both running behind another route.
  if (design) { design.destroy?.(); design = null; }

  if (problemImport) { problemImport.destroy(); problemImport = null; }
  if (lld) { lld.destroy(); lld = null; }
  if (location.hash === '#/add') {
    problemImport = renderProblemImport({ onAdded: async ({ entry, slug }) => {
      if (!bySlug.has(slug)) data.problems.push(entry);
      bySlug.set(slug, entry);
      if (entry.lists?.added || entry.lists?.others) { state.list = entry.lists.others ? 'others' : 'added'; state.pattern = null; state.query = ''; state.difficulty = 'all'; searchEl.value = ''; state.catalogMode = 'explorer'; saveState(); }
      goProblem(slug);
    } });
    replace(appEl, problemImport.element); mountRecorder(); return;
  }
  if (location.hash === '#/lld' || location.hash.startsWith('#/lld/')) {
    lld = initLLD(appEl); mountRecorder(); return;
  }

  if (location.hash === '#/design' || location.hash.startsWith('#/design/')) {
    replace(appEl, el('div', { class: 'view' }));
    design = initDesign(appEl);
    mountRecorder();
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }

  if (location.hash === '#/progress') {
    replace(appEl, el('div', { class: 'view' }));
    dashboard = initDashboard(appEl, api);
    mountRecorder();
    window.scrollTo({ top: 0, behavior: 'instant' });
    return;
  }

  const slug = currentSlug();
  if (slug) {
    const entry = bySlug.get(slug);
    if (!entry) {
      replace(appEl, el('div', { class: 'view' }, [
        el('div', { class: 'crumb' }, el('button', { class: 'btn btn--quiet linkbtn', type: 'button', 'aria-label': 'Back to all problems', onclick: goBrowse }, [icon('back'), 'All problems'])),
        el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
          'There is no problem with the slug ', el('b', { text: slug }), ' in the NeetCode 250.',
        ])),
      ]));
      mountRecorder();
      return;
    }
    state.selectedSlug = slug;
    replace(appEl, renderProblem(entry, { listLabel: LIST_FILTERS.find(list => list.id === state.list)?.label || 'Problems', neighbours: neighboursOf(slug), canShuffle: shuffleSourceSetting() === 'leetcode' || !!shuffleTarget(), shuffleBusy: leetcodeShuffle.busy, onShuffle: handlers.onShuffle, onBack: goBrowse, onOpen: handlers.onOpen }));
    window.scrollTo({ top: 0, behavior: 'instant' });
    installResizers();
    mountRecorder();
    return;
  }

  if (location.hash === '#/roadmap') {
    state.catalogMode = 'roadmap';
    // The roadmap draws the curated lists only.
    if (['added', 'others'].includes(state.list)) { state.list = 'neetcode250'; state.pattern = null; }
  } else if (location.hash === '#/') state.catalogMode = 'explorer';
  saveState();
  if (!arrived && appEl.querySelector('.catalog')) { redrawCatalog(); refreshCatalogProgress(); return; }
  replace(appEl, renderCatalog());
  mountRecorder();
  refreshCatalogProgress();
  const selected = state.selectedSlug && appEl.querySelector(`.prow[data-slug="${CSS.escape(state.selectedSlug)}"]`);
  if (selected) selected.scrollIntoView({ block: 'center', behavior: 'instant' });
}

function renderCatalog() {
  return state.catalogMode === 'roadmap' ? renderRoadmap(data, state, handlers) : renderBrowse(data, state, handlers);
}

let progressLoadedAt = 0;
let progressPending = false;
let progressRefreshQueued = false;
let statsReadOnce = false;
let streakPill = null;
window.addEventListener('studio-tracker-changed', () => { progressLoadedAt = 0; void refreshCatalogProgress(true); });
async function refreshCatalogProgress(force = false) {
  if (progressPending) { if (force) progressRefreshQueued = true; return; }
  if (!force && Date.now() - progressLoadedAt < 30_000) return;
  progressPending = true;
  try {
    // The first read shares the top bar pill's request; later ones ask again.
    const timeout = new Promise(resolve => setTimeout(resolve, 8000, null));
    const result = await Promise.race([Promise.all([loadStats({ fresh: statsReadOnce }), loadCatalogProgress()]), timeout]);
    const [stats, progress] = result || [];
    statsReadOnce = true;
    if (!stats) throw new Error('Progress unavailable');
    state.progress = progress;
    state.stats = stats;
    streakPill?.update(stats);
    state.progressState = 'ready';
  } catch {
    state.progress = null;
    state.stats = null;
    state.progressState = 'unavailable';
  } finally {
    progressPending = false;
    progressLoadedAt = Date.now();
    if (progressRefreshQueued) { progressRefreshQueued = false; void refreshCatalogProgress(true); }
    if (document.body.classList.contains('browse-page')) {
      redrawCatalog();
    }
  }
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
  if (row) row.scrollIntoView({ block: 'nearest', behavior: 'instant' });
}

/* --------------------------------- keyboard -------------------------------- */

// Holding Enter on Submit, Reset, or Start is still one gesture. Native button
// activation repeats too, independently of our Cmd/Ctrl shortcut handlers.
document.addEventListener('keydown', event => {
  if (event.repeat && event.key === 'Enter' && event.target.closest?.('button, [role="button"], input[type="submit"]')) {
    event.preventDefault(); event.stopPropagation();
  }
}, { capture: true });

// Catalog navigation belongs to coding routes, not every screen without a coding slug.
// Whiteboards deliberately bubble keys to their own listeners. Whether a key applies at
// all (a dialog open, a field typing it, a control using it) is keyboard.js's decision.
const onCatalog = () => ['', '#/'].includes(location.hash) && state.catalogMode !== 'roadmap';
const onCodingRoute = () => Boolean(currentSlug()) || ['', '#/', '#/roadmap'].includes(location.hash);
const openEntry = () => { const slug = currentSlug(); return slug ? bySlug.get(slug) : null; };

// ⌘←/→ are text editing in any field, so they yield to typing; elsewhere they page problems.
registerShortcut({
  id: 'neighbour-problem', label: '⌘← / ⌘→', owns: 'typing',
  keys: [{ code: 'ArrowLeft', mod: 'meta' }, { code: 'ArrowRight', mod: 'meta' }],
  when: () => Boolean(openEntry()),
  run: (event, key) => {
    const { previous, next } = neighboursOf(currentSlug());
    const neighbour = key.code === 'ArrowLeft' ? previous : next;
    if (neighbour) handlers.onOpen(neighbour.slug);
  },
});
// Autorepeat steps on, as it always has: holding J walks the list.
registerShortcut({
  id: 'step-problem', label: 'J / K', repeat: true,
  keys: [{ key: 'j' }, { key: 'k' }, { key: 'ArrowDown' }, { key: 'ArrowUp' }],
  when: () => Boolean(openEntry()),
  run: (event, key) => {
    const { previous, next } = neighboursOf(currentSlug());
    const neighbour = key.key === 'j' || key.key === 'ArrowDown' ? next : previous;
    if (neighbour) handlers.onOpen(neighbour.slug);
  },
});
registerShortcut({
  id: 'catalog-step', label: 'J / K', repeat: true,
  keys: [{ key: 'j' }, { key: 'k' }, { key: 'ArrowDown' }, { key: 'ArrowUp' }],
  when: onCatalog,
  run: (event, key) => moveSelection(key.key === 'j' || key.key === 'ArrowDown' ? 1 : -1),
});
registerShortcut({
  id: 'catalog-open', label: '↵', keys: [{ key: 'Enter' }],
  when: () => onCatalog() && Boolean(state.selectedSlug),
  run: () => handlers.onOpen(state.selectedSlug),
});
// s / a switch the problem pane to that tab; the same key again returns to Problem.
registerShortcut({
  id: 'reference-tab', label: 'S / A', keys: [{ key: 's' }, { key: 'a' }],
  when: () => Boolean(openEntry()),
  run: (event, key) => showTab(openEntry(), key.key === 's' ? 'solution' : 'article', { toggle: true }),
});
registerShortcut({
  id: 'shuffle', label: 'R', keys: [{ key: 'r' }],
  when: () => Boolean(openEntry()) || onCatalog(),
  run: () => handlers.onShuffle(),
});
registerShortcut({
  id: 'search', label: '/', keys: [{ key: '/' }],
  when: onCodingRoute,
  run: () => { if (currentSlug()) goBrowse(); searchEl.focus(); searchEl.select(); },
});
// Escape steps back one level: Solution/Article to the statement, a query to the full
// list, a problem to the list. Anything open above the page (a dialog, a menu, Find, a
// field) takes Escape first, so this only runs once there is nothing left to close.
registerShortcut({
  id: 'back', label: 'Esc', keys: [{ key: 'Escape' }],
  when: onCodingRoute,
  run: () => {
    const open = openEntry();
    if (open && currentTab(open.slug) !== 'problem') { showTab(open, 'problem'); return; }
    if (state.query) { state.query = ''; searchEl.value = ''; render(); return; }
    if (currentSlug()) goBrowse();
  },
});

// The search box's own keys: Enter opens the first match, ↓ moves into the list, Escape
// hands the keyboard back. Every other key types.
searchEl.addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
  if (event.key === 'Enter') {
    const list = visibleProblems(data, state);
    if (list.length) { event.preventDefault(); searchEl.blur(); handlers.onOpen(list[0].slug); }
  } else if (event.key === 'ArrowDown') {
    event.preventDefault(); searchEl.blur(); moveSelection(1);
  } else if (event.key === 'Escape') {
    event.preventDefault(); searchEl.blur();
  }
});

searchEl.addEventListener('input', () => {
  state.query = searchEl.value;
  state.pattern = null;
  if (currentSlug()) { goBrowse(); return; } // hashchange re-renders
  render();
  window.scrollTo({ top: 0, behavior: 'instant' }); // a new query is a new list, read from its start
});

window.addEventListener('hashchange', render);
// Leaving the page tears the design interview down so its last words are saved. A page
// restored from the back/forward cache comes back with that screen already torn down,
// so build it again rather than showing a dead board.
window.addEventListener('pageshow', (event) => { if (event.persisted) render(true); });


/* ----------------------------------- boot ---------------------------------- */

function showBanner(message) {
  document.body.classList.add('has-banner');
  bannerEl.hidden = false;
  replace(bannerEl, [
    el('span', { class: 'bhead', text: 'Offline demo' }),
    el('span', { class: 'btext', text: message }),
    el('button', { class: 'btn btn--quiet blink', type: 'button', text: 'Retry connection', onclick: () => location.reload() }),
  ]);
}

function setSourceLabel() {
  const dot = document.getElementById('srcDot');
  const label = document.getElementById('srcLabel');
  dot.dataset.state = api.demo ? 'mock' : api.mode;
  label.textContent = api.demo ? 'Demo' : api.mode === 'live' ? 'Live' : 'Sample data';
  label.title = api.demo ? 'Demo workspace: local runs and scripted coaching' : api.mode === 'live' ? 'Served by the studio server' : api.reason;
  // Live is the normal case and needs no badge; only say so when the data is not yours.
  document.getElementById('srcCell').hidden = api.mode === 'live' && !api.demo;
}

async function boot() {
  applySettings();
  installSettingsButton(document.getElementById('setmount'));
  streakPill = installStreakPill(document.getElementById('streakmount'));
  // An accepted submission changes the numbers; the catalog re-reads next time it shows.
  window.addEventListener('studio:stats-changed', () => {
    // The pill's listener ran first and already re-read, so share its request.
    progressLoadedAt = 0; statsReadOnce = false;
    if (document.body.classList.contains('browse-page')) refreshCatalogProgress();
  });
  // A layout change moves the panes, so anything that measured them has to measure
  // again — the resize handles sit in the gaps between columns that just moved.
  onSettingsChange(() => { paintShuffle(); if (currentSlug()) installResizers(); });

  const hadSavedCollapse = loadState();
  try {
    // With the catalog, not after it: any conversation drawn later already has its wording.
    [data] = await Promise.all([loadCatalog(), loadToolDisplay()]);
  } catch (error) {
    replace(appEl, el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
      'The problem list could not be loaded at all — not from the server, and not from the bundled copy. ',
      'That means files are missing from web/mock/, so there is nothing this page can show.',
    ])));
    document.getElementById('srcLabel').textContent = 'Failed';
    document.getElementById('srcCell').hidden = false;
    return;
  }

  setCollection(data.collection);
  // A remembered collection that this workspace no longer has falls back to the curriculum.
  if (!isKnownList(state.list)) state.list = 'neetcode250';
  bySlug = new Map(data.problems.map(p => [p.slug, p]));

  // First visit: show the shape of the curriculum — first pattern open, rest closed.
  if (!hadSavedCollapse) {
    state.collapsed = new Set(data.patterns.slice(1));
    saveState();
  }

  setSourceLabel();
  if (api.mode === 'mock') showBanner(api.reason);

  render(true);
}

boot();
