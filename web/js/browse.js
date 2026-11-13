import { leetcodeViews } from './leetcode-views.js';
import { screenHeader } from './ui/headers.js';
// The browse screen: curated collections grouped by the 18 NeetCode patterns, in the
// server's curriculum order. All filtering is client side — the whole list arrives
// at boot, so nothing here ever touches the network.

import { el, frag } from './dom.js';
import { progressFor, summarizeProgress, summarizeByDifficulty } from './catalog-progress.js';
import { computeStreak, recentDays } from './streak.js';
import { flameIcon } from './streak-pill.js';
import { icon } from './ui/icon.js';
import { button } from './ui/button.js';

export const LIST_FILTERS = [
  { id: 'neetcode250', label: 'NeetCode 250' },
  { id: 'neetcode150', label: 'NeetCode 150' },
  { id: 'blind75', label: 'Blind 75' },
  { id: 'added', label: 'You' },
  { id: 'others', label: 'Others' },
];
const BUILT_IN_COUNT = LIST_FILTERS.length;

/** The learner's private collection, from the workspace (never shipped in the repo). */
let privateCollection = null;
export function setCollection(value) {
  privateCollection = value && typeof value.id === 'string' && typeof value.label === 'string' ? value : null;
  LIST_FILTERS.length = BUILT_IN_COUNT;
  if (privateCollection) LIST_FILTERS.push({ id: privateCollection.id, label: privateCollection.label });
}
export function currentCollection() { return privateCollection; }
export function isKnownList(id) { return LIST_FILTERS.some(f => f.id === id); }
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

/** Case-insensitive match over title and pattern, plus the problem number. */
function matches(problem, needle) {
  if (!needle) return true;
  return problem.title.toLowerCase().includes(needle)
    || (problem.pattern || '').toLowerCase().includes(needle)
    || String(problem.number) === needle
    || (problem.tags || []).some(tag => tag.includes(needle))
    || [problem.interviewPrep?.id, problem.interviewPrep?.reportedPrompt]
      .some(value => value?.toLowerCase().includes(needle));
}

/** Group the filtered problems by pattern, preserving the server's pattern order. */
export function groupProblems(data, state) {
  const needle = state.query.trim().toLowerCase();
  const byPattern = new Map(data.patterns.map(p => [p, { pattern: p, total: 0, all: [], items: [] }]));

  for (const problem of data.problems) {
    const pattern = problem.pattern || 'Uncategorized';
    if (problem.lists[state.list] && !byPattern.has(pattern)) byPattern.set(pattern, { pattern, total: 0, all: [], items: [] });
    const bucket = byPattern.get(pattern);
    if (!bucket) continue;
    if (!problem.lists[state.list]) continue;
    bucket.total++;
    bucket.all.push(problem);
    if (state.difficulty !== 'all' && problem.difficulty !== state.difficulty) continue;
    if (state.hideSolved && state.progress && progressFor(problem.slug, state.progress).status === 'accepted') continue;
    if (!matches(problem, needle)) continue;
    if (state.pattern && state.pattern !== pattern) continue;
    bucket.items.push(problem);
  }
  return [...byPattern.values()];
}

function markTitle(title, needle) {
  if (!needle) return document.createTextNode(title);
  const at = title.toLowerCase().indexOf(needle);
  if (at < 0) return document.createTextNode(title);
  return frag([
    title.slice(0, at),
    el('mark', { text: title.slice(at, at + needle.length) }),
    title.slice(at + needle.length),
  ]);
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
}

function folderIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true', class: 'folder-icon' });
  svg.append(svgEl('path', { d: 'M2 5h6l2 2h8v10H2Z', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linejoin': 'round' }));
  return svg;
}

function checkIcon(className = 'check-icon') {
  const svg = svgEl('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true', class: className });
  svg.append(svgEl('path', { d: 'M2.6 6.3 5 8.6l4.4-5', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
  return svg;
}

/* ----------------------------- meters & motion ----------------------------- */

// The fraction each meter last showed. The catalog re-renders on every filter click,
// so without this every chip press would replay the sweep; with it, a meter animates
// from 0 the first time and from its old value when the number actually changes.
const lastShown = new Map();
function motionFrom(key, to) {
  const from = lastShown.has(key) ? lastShown.get(key) : 0;
  lastShown.set(key, to);
  return from === to ? null : from;
}

/** A slim bar. `key` names it for motion; `tone` picks the fill colour. */
function meter(accepted, total, key, tone = 'accent') {
  const to = total ? accepted / total : 0;
  const from = key ? motionFrom(key, to) : null;
  return el('span', { class: `meter tone-${tone}`, 'aria-hidden': 'true' },
    el('i', { class: from === null ? '' : 'grow', style: `--to:${to.toFixed(4)};--from:${(from ?? to).toFixed(4)}` }));
}

function progressRing(accepted, total, key) {
  const r = 52, c = 2 * Math.PI * r;
  const frac = total ? accepted / total : 0;
  const from = motionFrom(key, frac);
  const svg = svgEl('svg', { viewBox: '0 0 120 120', 'aria-hidden': 'true', class: 'ring-svg' });
  svg.append(svgEl('circle', { class: 'ring-track', cx: 60, cy: 60, r }));
  // A zero-length round-capped stroke still paints a dot, which would claim progress.
  if (accepted > 0) {
    svg.append(svgEl('circle', {
      class: 'ring-value' + (from === null ? '' : ' sweep'), cx: 60, cy: 60, r,
      'stroke-dasharray': c.toFixed(2), 'stroke-dashoffset': (c * (1 - frac)).toFixed(2),
      transform: 'rotate(-90 60 60)',
      style: `--ring-from:${(c * (1 - (from ?? frac))).toFixed(2)}`,
    }));
  }
  return el('div', { class: 'ov-ring', role: 'img', 'aria-label': `${accepted} of ${total} solved` }, [
    svg,
    el('div', { class: 'ov-ring-centre', 'aria-hidden': 'true' }, [
      el('b', { text: String(accepted) }),
      el('span', { class: 'ov-ring-label', text: 'solved' }),
      // One solved of 250 is not 0%.
      el('span', { class: 'ov-ring-of', text: `of ${total} · ${accepted > 0 && accepted / total < 0.005 ? '<1' : total ? Math.round(accepted / total * 100) : 0}%` }),
    ]),
  ]);
}

/* --------------------------------- overview -------------------------------- */

function statusGlyph(status, label) {
  return el('span', { class: `problem-state state-${status}`, role: 'img', 'aria-label': label },
    status === 'accepted' ? checkIcon('state-check') : null);
}

function difficultyBreakdown(collection, state) {
  return el('div', { class: 'ov-diff' }, [
    el('div', { class: 'ov-kicker', text: 'By difficulty' }),
    ...summarizeByDifficulty(collection, state.progress, DIFFICULTIES).map(({ difficulty, accepted, total }) =>
      el('div', { class: 'ov-diff-row' }, [
        el('span', { class: 'ov-diff-name', text: difficulty }),
        meter(accepted, total, `${state.list}:${difficulty}`, difficulty.toLowerCase()),
        el('span', { class: 'ov-diff-n' }, total
          ? [el('b', { text: String(accepted) }), `/${total}`]
          : '—'),
      ])),
  ]);
}

/**
 * What to open next, from evidence already loaded. The problem touched most recently
 * (in this list, and since the last tracker reset) says where the learner is: if it is
 * unfinished it is the one to continue; otherwise the next unsolved problem of that
 * pattern follows. With no such record, curriculum order decides.
 */
export function pickNext(collection, state) {
  const open = problem => progressFor(problem.slug, state.progress).status !== 'accepted';
  const first = collection.find(open);
  if (!first) return null;
  const bySlug = new Map(collection.map((problem, index) => [problem.slug, index]));
  let latest = null;
  for (const record of state.stats?.problems || []) {
    if (!record?.lastAt || !bySlug.has(record.slug)) continue;
    const progress = state.progress?.get?.(record.slug);
    // A reset starts a fresh round: activity from before it no longer says where you are.
    if (progress?.resetAt && String(record.lastAt) <= String(progress.resetAt)) continue;
    if (!progress || progress.status === 'empty') continue;
    if (!latest || String(record.lastAt) > String(latest.lastAt)) latest = record;
  }
  if (!latest) return { problem: first, resumed: false };
  const at = bySlug.get(latest.slug);
  const last = collection[at];
  if (open(last)) return { problem: last, resumed: true };
  const samePattern = problem => problem.pattern === last.pattern && open(problem);
  const follow = collection.slice(at + 1).find(samePattern) || collection.find(samePattern);
  return { problem: follow || first, resumed: false };
}

function nextUp(collection, state, onOpen) {
  const pick = pickNext(collection, state);
  if (!pick) return el('div', { class: 'ov-next done' }, [checkIcon('ov-done-check'), el('span', { text: 'Every problem in this list is solved.' })]);
  const next = pick.problem;
  return el('button', { class: 'ui-action-row ov-next', type: 'button', onclick: () => onOpen(next.slug) }, [
    el('span', { class: 'ov-kicker', text: pick.resumed ? 'Pick up where you left off' : 'Next up' }),
    el('span', { class: 'ov-next-title', text: next.title }),
    el('span', { class: 'ov-next-meta' }, [
      el('span', { class: 'tag ' + next.difficulty.toLowerCase(), text: next.difficulty }),
      next.pattern ? el('span', { class: 'ov-next-pattern', text: next.pattern }) : null,
      el('span', { class: 'ov-next-go', 'aria-hidden': 'true' }, icon('forward', 15)),
    ]),
  ]);
}

function streakTile(stats) {
  const streak = computeStreak(stats?.activity);
  const days = recentDays(streak, 14);
  const lit = streak.current > 0;
  const note = !lit
    ? (streak.best ? `Best so far: ${streak.best} day${streak.best === 1 ? '' : 's'}` : 'One practice session starts it')
    : streak.activeToday ? `Today counts · best ${streak.best}` : `Practice today to keep it · best ${streak.best}`;
  return el('div', { class: 'ov-streak' + (lit ? ' lit' : '') + (streak.activeToday ? ' today' : '') }, [
    el('div', { class: 'ov-streak-head' }, [
      flameIcon({ lit, className: 'flame ov-flame' }),
      el('div', {}, [
        el('div', { class: 'ov-streak-n', text: lit ? `${streak.current}-day streak` : 'Start a streak today' }),
        el('div', { class: 'ov-streak-best', text: note }),
      ]),
    ]),
    el('ol', { class: 'ov-days', 'aria-label': `Last 14 days: ${days.filter(d => d.active).length} with practice` },
      days.map(({ day, active }) => el('li', { class: (active ? 'on' : '') + (day === streak.today ? ' now' : '') }))),
    el('div', { class: 'ov-days-axis', 'aria-hidden': 'true' }, [el('span', { text: '2 weeks ago' }), el('span', { text: 'today' })]),
  ]);
}

let overviewSeen = false;

function progressOverview(collection, state, handlers) {
  const label = LIST_FILTERS.find(f => f.id === state.list)?.label || 'This list';
  if (state.progressState === 'unavailable') {
    return el('section', { class: 'card ov ov-unavailable', 'aria-label': 'Progress overview' }, [
      el('div', {}, [
        el('div', { class: 'ov-streak-n', text: 'Progress unavailable' }),
        el('div', { class: 'ov-streak-best', text: 'Your stats could not be read. The problem library below still works.' }),
      ]),
      el('button', { class: 'btn btn--quiet ov-retry', type: 'button', text: 'Retry', onclick: handlers.onRetryProgress }),
    ]);
  }
  if (!state.progress) {
    // Same footprint as the real band, so nothing jumps when the numbers arrive.
    return el('section', { class: 'card ov ov-loading', 'aria-label': 'Loading your progress', 'aria-busy': 'true' }, [
      el('div', { class: 'ov-ring' }, el('span', { class: 'ov-skel-ring' })),
      ...[0, 1, 2].map(() => el('div', { class: 'ov-skel' }, [el('i'), el('i'), el('i'), el('i', { class: 'short' })])),
    ]);
  }

  const summary = summarizeProgress(collection, state.progress);
  const notStarted = summary.total - summary.touched;
  const counts = [
    ['local-pass', summary.localPass, 'passed locally'],
    ['attempted', summary.attempted, 'in progress'],
    ['empty', notStarted, 'not started'],
  ].filter(([, n]) => n > 0);
  // The band rises in once per page load, not on every filter click.
  const seen = overviewSeen; overviewSeen = true;
  return el('section', { class: 'card ov' + (seen ? ' seen' : ''), 'aria-label': `${label} progress` }, [
    progressRing(summary.accepted, summary.total, `${state.list}:ring`),
    difficultyBreakdown(collection, state),
    el('div', { class: 'ov-mid' }, [
      // A count of nothing is noise: only the states that have problems in them are listed.
      counts.length ? el('div', { class: 'ov-counts' }, counts.map(([status, n, text]) => el('div', { class: 'ov-count' }, [
        statusGlyph(status, text), el('b', { text: String(n) }), el('span', { text }),
      ]))) : null,
      nextUp(collection, state, handlers.onOpen),
    ]),
    streakTile(state.stats),
  ]);
}

/** The shorter core list a problem also belongs to, unless that is the list on screen. */
function coreListNote(problem, state) {
  if (state.list === 'blind75') return null;
  if (problem.lists.blind75) return 'Blind 75';
  if (problem.lists.neetcode150 && state.list !== 'neetcode150') return 'NeetCode 150';
  return null;
}

function problemRow(problem, state, needle, onOpen) {
  const progress = progressFor(problem.slug, state.progress);
  const note = coreListNote(problem, state);
  // Title, level and list read as one phrase from the left, at any window width.
  const row = el('button', {
    class: 'ui-action-row prow' + (state.selectedSlug === problem.slug ? ' sel' : ''),
    type: 'button',
    dataset: { slug: problem.slug },
    onclick: () => onOpen(problem.slug),
  }, [
    statusGlyph(progress.status, progress.label),
    el('span', { class: 'pnum', text: problem.number ? String(problem.number) : '' }),
    el('span', { class: 'pmain' }, [
      el('span', { class: 'ptitle' }, markTitle(problem.title, needle)),
      el('span', { class: 'tag ' + problem.difficulty.toLowerCase(), text: problem.difficulty }),
      note ? el('span', { class: 'plist-note', text: note }) : null,
    ]),
  ]);
  return el('li', {}, row);
}

/** Accepted / total for the whole pattern in this list, whatever the filters hide. */
function sectionProgress(group, state) {
  if (!state.progress) return el('span', { class: 'sec-progress pending' });
  const { accepted } = summarizeProgress(group.all, state.progress);
  const done = group.total > 0 && accepted === group.total;
  return el('span', { class: 'sec-progress' + (done ? ' done' : ''), role: 'img', 'aria-label': `${accepted} of ${group.total} solved` }, [
    accepted > 0 && !done ? meter(accepted, group.total, null) : null,
    el('span', { class: 'sec-n' }, [el('b', { text: String(accepted) }), `/${group.total}`]),
    done ? checkIcon('sec-check') : null,
  ]);
}

function patternSection(group, index, state, needle, handlers) {
  const forcedOpen = needle !== '' || state.difficulty !== 'all' || state.list !== 'neetcode250';
  const open = group.items.length > 0 && (forcedOpen || !state.collapsed.has(group.pattern));
  const filtered = group.items.length !== group.total;

  const head = el('button', {
    class: 'ui-action-row phead', type: 'button', 'aria-expanded': String(open),
    'aria-controls': 'sec-' + index,
    onclick: () => handlers.onToggle(group.pattern),
  }, [
    el('span', { class: 'caret', 'aria-hidden': 'true' }, icon('forward', 15)),
    folderIcon(),
    el('span', { class: 'pname', text: group.pattern }),
    filtered ? el('span', { class: 'pcount', text: `${group.items.length} of ${group.total} shown` }) : null,
    sectionProgress(group, state),
  ]);

  const section = el('section', { class: 'psec' + (open ? ' open' : '') }, head);

  const list = el('ul', { class: 'plist', id: 'sec-' + index });
  for (const problem of group.items) list.append(problemRow(problem, state, needle, handlers.onOpen));
  section.append(list);
  if (filtered) {
    section.append(el('div', {
      class: 'psec-more',
      text: `${group.total - group.items.length} more in this pattern not shown`,
    }));
  }
  return section;
}

function treeItem({ root = false, label, items, summary, pressed, onClick }) {
  const total = items.length;
  const done = summary && total > 0 && summary.accepted === total;
  const count = summary ? `${summary.accepted}/${total}` : String(total);
  // The count says it; a bar per row was eighteen empty tracks for most learners.
  return el('button', {
    type: 'button', class: (root ? 'tree-root' : 'tree-pattern') + (done ? ' done' : ''),
    'aria-pressed': String(pressed), onclick: onClick,
    'aria-label': summary ? `${label}: ${summary.accepted} of ${total} solved` : `${label}: ${total} problems`,
  }, [
    done ? el('span', { class: 'tree-done' }, checkIcon('tree-check')) : folderIcon(),
    el('span', { class: 'tree-label', text: label }),
    el('span', { class: 'tree-count', text: count }),
  ]);
}

function chip(label, pressed, onClick, extraClass = '') {
  return el('button', {
    class: 'btn btn--quiet chip ' + extraClass, type: 'button', 'aria-pressed': String(pressed), onclick: onClick, text: label,
  });
}

/* The list and level switches, shared with the roadmap so both views filter the same way. */
const segment = (label, options) => el('div', { class: 'segmented seg', role: 'group', 'aria-label': label }, options);

export function listSwitch(lists, state, handlers) {
  return segment('List', lists.map(f => chip(f.label, state.list === f.id, () => handlers.onList(f.id), 'seg-opt')));
}

export function levelSwitch(state, handlers) {
  return segment('Level', [
    chip('All levels', state.difficulty === 'all', () => handlers.onDifficulty('all'), 'seg-opt'),
    ...DIFFICULTIES.map(d => {
      const option = chip(d, state.difficulty === d, () => handlers.onDifficulty(d), 'seg-opt ' + d.toLowerCase());
      option.prepend(el('i', { class: 'seg-dot', 'aria-hidden': 'true' }));
      return option;
    }),
  ]);
}

let barHeight = 0;

export function renderBrowse(data, state, handlers) {
  const groups = groupProblems(data, state);
  const needle = state.query.trim().toLowerCase();
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const anyCollapsible = groups.some(g => g.items.length);
  const allCollapsed = groups.every(g => !g.items.length || state.collapsed.has(g.pattern));
  const forcedOpen = needle !== '' || state.difficulty !== 'all' || state.list !== 'neetcode250';

  const view = el('div', { class: 'view catalog' });
  const collection = data.problems.filter(problem => problem.lists[state.list]);
  const summary = state.progress ? summarizeProgress(collection, state.progress) : null;
  const setHideSolved = (next) => {
    // main.js does not own this filter yet; until it does, the level handler re-renders.
    if (handlers.onHideSolved) handlers.onHideSolved(next);
    else { state.hideSolved = next; handlers.onDifficulty(state.difficulty); }
  };

  view.append(screenHeader({ title: 'Problem explorer', actions: { secondary: [
    el('a', { href: '#/add', class: 'btn btn--quiet catalog-add' }, [icon('plus', 15), 'Add problem']),
  ] }, status: leetcodeViews('explorer') }));
  view.append(progressOverview(collection, state, handlers));


  // One toolbar, aligned to the column it filters: two segmented controls (which list,
  // which level) and the count. Labels moved into aria: the options say what they are.
  const controls = el('div', { class: 'filterbar' }, [
    listSwitch(LIST_FILTERS.filter(f => !['added', 'others'].includes(f.id) || state.list === f.id || data.problems.some(p => p.lists?.[f.id])), state, handlers),
    levelSwitch(state, handlers),
    // The count and actions travel as one group: when the row is too narrow they move to a
    // second line together instead of clipping a switch or stranding one button.
    el('div', { class: 'filter-actions' }, [
    // Plain numerals here: the boxed-digit treatment read as "1 3 of 250" at this size.
    el('span', { class: 'countpill' }, shown === collection.length
      ? [el('b', { text: String(shown) }), shown === 1 ? ' problem' : ' problems']
      : [el('b', { text: String(shown) }), ` of ${collection.length}`]),
    // Offered once something is solved: the usual question is "what is left".
    summary?.accepted > 0 || state.hideSolved
      ? button({ label: 'Hide solved', pressed: Boolean(state.hideSolved), className: 'linkbtn hide-solved', onClick: () => setHideSolved(!state.hideSolved) })
      : null,
    el('button', {
      class: 'btn btn--quiet linkbtn shufflebtn', type: 'button',
      disabled: !!handlers.shuffleState?.().busy, 'aria-busy': String(!!handlers.shuffleState?.().busy),
      'aria-label': handlers.shuffleState?.().busy ? 'Finding a LeetCode problem…' : 'Random problem; keyboard shortcut R',
      onclick: handlers.onShuffle,
    }, [icon('shuffle', 14), el('span', { class: 'shuffle-label', role: 'status', text: handlers.shuffleState?.().busy ? 'Finding…' : 'Shuffle' })]),
    anyCollapsible && !forcedOpen
      ? el('button', {
        class: 'btn btn--quiet linkbtn', type: 'button',
        text: allCollapsed ? 'Expand all' : 'Collapse all',
        onclick: () => handlers.onToggleAll(!allCollapsed),
      })
      : null,
    ]),
  ]);
  // The open section's heading pins under this bar, so it needs the bar's real height
  // (one line or two). Remembered across renders so a filter click never shifts it.
  if (barHeight) view.style.setProperty('--catalog-bar-h', `${barHeight}px`);
  const barObserver = new ResizeObserver(() => {
    if (!controls.isConnected) { barObserver.disconnect(); return; }
    const height = Math.round(controls.getBoundingClientRect().height);
    if (!height || height === barHeight) return;
    barHeight = height;
    view.style.setProperty('--catalog-bar-h', `${height}px`);
  });
  barObserver.observe(controls);
  const layout = el('div', { class: 'catalog-layout' });
  // Only the patterns this list has problems in: a row reading 0/0 leads nowhere.
  const inList = groups.filter(group => group.total > 0);
  const sidebar = el('nav', { class: 'catalog-tree', 'aria-label': 'Problem patterns' }, [
    el('div', { class: 'tree-heading' }, [el('span', { text: 'Patterns' }), el('span', { class: 'tree-legend', text: state.progress ? 'solved / total' : 'problems' })]),
    treeItem({ root: true, label: 'All patterns', items: collection, summary, pressed: !state.pattern, onClick: () => handlers.onPattern(null) }),
    ...inList.map(group => treeItem({
      label: group.pattern, items: group.all, summary: state.progress ? summarizeProgress(group.all, state.progress) : null,
      pressed: state.pattern === group.pattern, onClick: () => handlers.onPattern(group.pattern),
    })),
  ]);
  const content = el('div', {class:'catalog-content'});
  layout.append(sidebar, content);
  view.append(layout);
  content.append(controls);
  if (privateCollection && state.list === privateCollection.id && privateCollection.note) {
    content.append(el('p', { class: 'sub', text: privateCollection.note }));
  }

  if (shown === 0) {
    content.append(el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
      el('span', {}, ['Nothing matches ', needle ? el('b', { text: `“${state.query.trim()}”` }) : 'these filters', needle ? ' in this list.' : '.']),
      button({ label: needle ? 'Clear search and filters' : 'Clear filters', variant: 'secondary', onClick: () => { state.hideSolved = false; handlers.onClear(); } }),
    ])));
    return view;
  }

  // Patterns with nothing left after filtering are dropped rather than left as a row
  // of empty cards; the count below keeps that honest.
  const sections = el('div', { class: 'sections' });
  groups.forEach((group, index) => {
    if (!group.items.length) return;
    sections.append(patternSection(group, index, state, needle, handlers));
  });
  content.append(sections);

  // Patterns this list has problems in, none of which pass the filters.
  const silent = state.pattern ? [] : groups.filter(g => g.total > 0 && !g.items.length);
  if (silent.length) {
    content.append(el('div', {
      class: 'catalog-silent',
      text: `No match in ${silent.length} other pattern${silent.length === 1 ? '' : 's'}: ${silent.map(g => g.pattern).join(' · ')}`,
    }));
  }

  content.append(el('div', { class: 'hint' }, [
    el('kbd', { text: '/' }), ' search  ',
    el('kbd', { text: 'j' }), el('kbd', { text: 'k' }), ' move  ',
    el('kbd', { text: 'enter' }), ' open  ',
    el('kbd', { text: 'r' }), ' random  ',
    el('kbd', { text: 'esc' }), ' clear',
  ]));

  return view;
}

/** Flat list of the problems currently visible, in screen order — drives j/k. */
export function visibleProblems(data, state) {
  const groups = groupProblems(data, state);
  const needle = state.query.trim().toLowerCase();
  const forcedOpen = needle !== '' || state.difficulty !== 'all' || state.list !== 'neetcode250';
  const out = [];
  for (const group of groups) {
    if (!group.items.length) continue;
    if (!forcedOpen && state.collapsed.has(group.pattern)) continue;
    out.push(...group.items);
  }
  return out;
}

/** Every problem passing the filters, ignoring collapse — drives prev/next on a problem page. */
export function filteredProblems(data, state) {
  return groupProblems(data, state).flatMap(g => g.items);
}
