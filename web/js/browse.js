// The browse screen: 250 problems grouped by the 18 NeetCode patterns, in the
// server's curriculum order. All filtering is client side — the whole list arrives
// at boot, so nothing here ever touches the network.

import { el, frag } from './dom.js';
import { progressFor, summarizeProgress, summarizeByDifficulty } from './catalog-progress.js';
import { computeStreak, recentDays } from './streak.js';
import { flameIcon } from './streak-pill.js';

export const LIST_FILTERS = [
  { id: 'neetcode250', label: 'NeetCode 250' },
  { id: 'neetcode150', label: 'NeetCode 150' },
  { id: 'blind75', label: 'Blind 75' },
];
export const DIFFICULTIES = ['Easy', 'Medium', 'Hard'];

/** Case-insensitive match over title and pattern, plus the problem number. */
function matches(problem, needle) {
  if (!needle) return true;
  return problem.title.toLowerCase().includes(needle)
    || problem.pattern.toLowerCase().includes(needle)
    || String(problem.number) === needle;
}

/** Group the filtered problems by pattern, preserving the server's pattern order. */
export function groupProblems(data, state) {
  const needle = state.query.trim().toLowerCase();
  const byPattern = new Map(data.patterns.map(p => [p, { pattern: p, total: 0, all: [], items: [] }]));

  for (const problem of data.problems) {
    const bucket = byPattern.get(problem.pattern);
    if (!bucket) continue;
    if (!problem.lists[state.list]) continue;
    bucket.total++;
    bucket.all.push(problem);
    if (state.difficulty !== 'all' && problem.difficulty !== state.difficulty) continue;
    if (!matches(problem, needle)) continue;
    if (state.pattern && state.pattern !== problem.pattern) continue;
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
      el('span', { class: 'ov-ring-of', text: `of ${total} · ${total ? Math.round(accepted / total * 100) : 0}%` }),
    ]),
  ]);
}

/* --------------------------------- overview -------------------------------- */

function statusGlyph(status, label) {
  return el('span', { class: `problem-state state-${status}`, title: label, 'aria-label': label },
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

function nextUp(collection, state, onOpen) {
  // Curriculum order is the server's problem order, so the first unaccepted one is next.
  const next = collection.find(problem => progressFor(problem.slug, state.progress).status !== 'accepted');
  if (!next) return el('div', { class: 'ov-next done' }, [checkIcon('ov-done-check'), el('span', { text: 'Every problem in this list is accepted.' })]);
  const status = progressFor(next.slug, state.progress);
  return el('button', { class: 'ov-next', type: 'button', onclick: () => onOpen(next.slug), title: `Open ${next.title}` }, [
    el('span', { class: 'ov-kicker', text: status.status === 'empty' ? 'Next up' : `Next up · ${status.label.toLowerCase()}` }),
    el('span', { class: 'ov-next-title', text: next.title }),
    el('span', { class: 'ov-next-meta' }, [
      el('span', { class: 'tag ' + next.difficulty.toLowerCase(), text: next.difficulty }),
      el('span', { text: next.pattern }),
      el('span', { class: 'ov-next-go', 'aria-hidden': 'true', text: '→' }),
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
      days.map(({ day, active }) => el('li', {
        class: (active ? 'on' : '') + (day === streak.today ? ' now' : ''),
        title: `${day}${day === streak.today ? ' (today)' : ''}: ${active ? 'practised' : 'no practice'}`,
      }))),
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
      el('button', { class: 'ov-retry', type: 'button', text: 'Retry', onclick: handlers.onRetryProgress }),
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
  // The band rises in once per page load, not on every filter click.
  const seen = overviewSeen; overviewSeen = true;
  return el('section', { class: 'card ov' + (seen ? ' seen' : ''), 'aria-label': `${label} progress` }, [
    progressRing(summary.accepted, summary.total, `${state.list}:ring`),
    difficultyBreakdown(collection, state),
    el('div', { class: 'ov-mid' }, [
      el('div', { class: 'ov-counts' }, [
        ['local-pass', summary.localPass, 'passed locally'],
        ['attempted', summary.attempted, 'in progress'],
        ['empty', notStarted, 'not started'],
      ].map(([status, n, text]) => el('div', { class: 'ov-count' }, [
        statusGlyph(status, text), el('b', { text: String(n) }), el('span', { text }),
      ]))),
      nextUp(collection, state, handlers.onOpen),
    ]),
    streakTile(state.stats),
  ]);
}

function assetDot(present, letter, label) {
  return el('span', {
    class: present ? 'assetdot' : 'assetdot off',
    title: present ? label + ' available' : 'No ' + label.toLowerCase(),
    'aria-label': present ? label + ' available' : 'No ' + label.toLowerCase(),
    text: letter,
  });
}

function problemRow(problem, state, needle, onOpen) {
  const progress = progressFor(problem.slug, state.progress);
  const row = el('button', {
    class: 'prow' + (state.selectedSlug === problem.slug ? ' sel' : ''),
    type: 'button',
    dataset: { slug: problem.slug },
    onclick: () => onOpen(problem.slug),
  }, [
    statusGlyph(progress.status, progress.label),
    el('span', { class: 'pnum', text: problem.number ? String(problem.number) : '—' }),
    el('span', { class: 'ptitle' }, markTitle(problem.title, needle)),
    el('span', { class: 'plists' }, [
      problem.lists.blind75 ? el('span', { class: 'tag quiet', text: 'B75' }) : null,
      problem.lists.neetcode150 && !problem.lists.blind75 ? el('span', { class: 'tag quiet', text: '150' }) : null,
    ]),
    el('span', { class: 'pdiff' }, el('span', {
      class: 'tag ' + problem.difficulty.toLowerCase(), text: problem.difficulty,
    })),
    el('span', { class: 'assets' }, [
      assetDot(problem.hasPythonSolution, 'S', 'Python solution'),
      assetDot(problem.hasArticle, 'A', 'Article'),
    ]),
  ]);
  return el('li', {}, row);
}

/** Accepted / total for the whole pattern in this list, whatever the filters hide. */
function sectionProgress(group, state) {
  if (!state.progress) return el('span', { class: 'sec-progress pending' });
  const { accepted } = summarizeProgress(group.all, state.progress);
  const done = group.total > 0 && accepted === group.total;
  return el('span', { class: 'sec-progress' + (done ? ' done' : ''), title: `${accepted} of ${group.total} accepted`, 'aria-label': `${accepted} of ${group.total} accepted` }, [
    meter(accepted, group.total, null),
    el('span', { class: 'sec-n' }, [el('b', { text: String(accepted) }), `/${group.total}`]),
    done ? checkIcon('sec-check') : null,
  ]);
}

function patternSection(group, index, state, needle, handlers) {
  const forcedOpen = needle !== '' || state.difficulty !== 'all' || state.list !== 'neetcode250';
  const open = group.items.length > 0 && (forcedOpen || !state.collapsed.has(group.pattern));
  const filtered = group.items.length !== group.total;

  const head = el('button', {
    class: 'phead', type: 'button', 'aria-expanded': String(open),
    'aria-controls': 'sec-' + index,
    onclick: () => handlers.onToggle(group.pattern),
  }, [
    el('span', { class: 'caret', 'aria-hidden': 'true', text: '▶' }),
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
      text: `${group.total - group.items.length} more in this pattern hidden by the filters`,
    }));
  }
  return section;
}

function treeItem({ root = false, label, items, summary, pressed, onClick }) {
  const total = items.length;
  const done = summary && total > 0 && summary.accepted === total;
  const count = summary ? `${summary.accepted}/${total}` : String(total);
  return el('button', {
    type: 'button', class: (root ? 'tree-root' : 'tree-pattern') + (done ? ' done' : ''), title: label,
    'aria-pressed': String(pressed), onclick: onClick,
    'aria-label': summary ? `${label}: ${summary.accepted} of ${total} accepted` : `${label}: ${total} problems`,
  }, [
    done ? el('span', { class: 'tree-done' }, checkIcon('tree-check')) : folderIcon(),
    el('span', { class: 'tree-name' }, [
      el('span', { class: 'tree-label', text: label }),
      summary ? meter(summary.accepted, total, null) : null,
    ]),
    el('span', { class: 'tree-count', text: count }),
  ]);
}

function chip(label, pressed, onClick, extraClass = '') {
  return el('button', {
    class: 'chip ' + extraClass, type: 'button', 'aria-pressed': String(pressed), onclick: onClick, text: label,
  });
}

export function renderBrowse(data, state, handlers) {
  const groups = groupProblems(data, state);
  const needle = state.query.trim().toLowerCase();
  const shown = groups.reduce((n, g) => n + g.items.length, 0);
  const anyCollapsible = groups.some(g => g.items.length);
  const allCollapsed = groups.every(g => !g.items.length || state.collapsed.has(g.pattern));
  const forcedOpen = needle !== '' || state.difficulty !== 'all' || state.list !== 'neetcode250';

  const view = el('div', { class: 'view catalog' });
  const collection = data.problems.filter(problem => problem.lists[state.list]);
  const listLabel = LIST_FILTERS.find(f => f.id === state.list)?.label || 'All problems';

  view.append(el('div', { class: 'viewhead' }, [
    el('div', {}, [
      el('h1', { text: 'Problem explorer' }),
      el('div', { class: 'sub', text: 'A place for every pattern. A record of every attempt.' }),
    ]),
    el('div', {class:'catalog-modes', 'aria-label':'Catalog view'}, [
      el('button',{type:'button','aria-pressed':'true',text:'Explorer',onclick:()=>handlers.onCatalogMode('explorer')}),
      el('button',{type:'button','aria-pressed':'false',text:'Roadmap',onclick:()=>handlers.onCatalogMode('roadmap')}),
    ]),
  ]));
  view.append(progressOverview(collection, state, handlers));

  // One toolbar, aligned to the column it filters: two segmented controls (which list,
  // which level) and the count. Labels moved into aria: the options say what they are.
  const segment = (label, options) => el('div', { class: 'seg', role: 'group', 'aria-label': label }, options);
  const controls = el('div', { class: 'filterbar' }, [
    segment('List', LIST_FILTERS.map(f =>
      chip(f.label, state.list === f.id, () => handlers.onList(f.id), 'seg-opt'))),
    segment('Level', [
      chip('All levels', state.difficulty === 'all', () => handlers.onDifficulty('all'), 'seg-opt'),
      ...DIFFICULTIES.map(d => {
        const option = chip(d, state.difficulty === d, () => handlers.onDifficulty(d), 'seg-opt ' + d.toLowerCase());
        option.prepend(el('i', { class: 'seg-dot', 'aria-hidden': 'true' }));
        return option;
      }),
    ]),
    el('span', { class: 'spacer' }),
    // Plain numerals here: the boxed-digit treatment read as "1 3 of 250" at this size.
    el('span', { class: 'countpill' }, shown === collection.length
      ? [el('b', { text: String(shown) }), ' problems']
      : [el('b', { text: String(shown) }), ` of ${collection.length}`]),
    anyCollapsible && !forcedOpen
      ? el('button', {
        class: 'linkbtn', type: 'button',
        text: allCollapsed ? 'Expand all' : 'Collapse all',
        onclick: () => handlers.onToggleAll(!allCollapsed),
      })
      : null,
  ]);
  const layout = el('div', { class: 'catalog-layout' });
  const rootSummary = state.progress ? summarizeProgress(collection, state.progress) : null;
  const sidebar = el('nav', { class: 'catalog-tree', 'aria-label': 'Problem patterns' }, [
    el('div', { class: 'tree-heading' }, [el('span', { text: 'Patterns' }), el('span', { class: 'tree-legend', text: state.progress ? 'solved / total' : 'problems' })]),
    treeItem({ root: true, label: listLabel, items: collection, summary: rootSummary, pressed: !state.pattern, onClick: () => handlers.onPattern(null) }),
    ...data.patterns.map(pattern => {
      const items = collection.filter(problem => problem.pattern === pattern);
      const summary = state.progress ? summarizeProgress(items, state.progress) : null;
      return treeItem({ label: pattern, items, summary, pressed: state.pattern === pattern, onClick: () => handlers.onPattern(pattern) });
    }),
    el('a', {class:'tree-report',href:'#/progress',text:'View practice report →'}),
  ]);
  const content = el('div', {class:'catalog-content'});
  layout.append(sidebar, content);
  view.append(layout);
  content.append(el('div', {class:'catalog-path'}, [el('span',{text:listLabel}), el('span',{text:'/'}),el('strong',{text:state.pattern || 'All patterns'})]), controls);

  if (shown === 0) {
    content.append(el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
      'Nothing matches ',
      needle ? el('b', { text: `“${state.query.trim()}”` }) : 'these filters',
      needle ? ' with the current filters' : '',
      '. ',
      el('button', {
        class: 'linkbtn', type: 'button', style: 'display:inline;padding:0',
        text: 'Clear everything', onclick: handlers.onClear,
      }),
      ' to see all 250 again.',
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

  const silent = state.pattern ? [] : groups.filter(g => !g.items.length);
  if (silent.length) {
    content.append(el('div', {
      class: 'catalog-silent',
      text: `No match in ${silent.length} other pattern${silent.length === 1 ? '' : 's'}: ${silent.map(g => g.pattern).join(' · ')}`,
    }));
  }

  content.append(el('div', { class: 'hint' }, [
    el('kbd', { text: '/' }), ' search  ',
    el('kbd', { text: 'j' }), el('kbd', { text: 'k' }), ' move  ',
    el('kbd', { text: '↵' }), ' open  ',
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
