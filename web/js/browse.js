// The browse screen: 250 problems grouped by the 18 NeetCode patterns, in the
// server's curriculum order. All filtering is client side — the whole list arrives
// at boot, so nothing here ever touches the network.

import { el, digits, frag } from './dom.js';

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
  const byPattern = new Map(data.patterns.map(p => [p, { pattern: p, total: 0, items: [] }]));

  for (const problem of data.problems) {
    const bucket = byPattern.get(problem.pattern);
    if (!bucket) continue;
    if (!problem.lists[state.list]) continue;
    bucket.total++;
    if (state.difficulty !== 'all' && problem.difficulty !== state.difficulty) continue;
    if (!matches(problem, needle)) continue;
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

function mixBar(items) {
  const counts = { Easy: 0, Medium: 0, Hard: 0 };
  for (const item of items) counts[item.difficulty] = (counts[item.difficulty] || 0) + 1;
  const title = `${counts.Easy} easy · ${counts.Medium} medium · ${counts.Hard} hard`;
  const bar = el('span', { class: 'mixbar', role: 'img', 'aria-label': `Difficulty mix: ${title}`, title });
  for (const [key, cls] of [['Easy', 'e'], ['Medium', 'm'], ['Hard', 'h']]) {
    if (!counts[key]) continue;
    bar.append(el('span', { class: cls, style: `flex:${counts[key]}` }));
  }
  if (!items.length) bar.append(el('span', { style: 'flex:1;background:rgba(0,0,0,.08)' }));
  return bar;
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
  const row = el('button', {
    class: 'prow' + (state.selectedSlug === problem.slug ? ' sel' : ''),
    type: 'button',
    dataset: { slug: problem.slug },
    onclick: () => onOpen(problem.slug),
  }, [
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
    el('span', { class: 'pidx', text: String(index + 1).padStart(2, '0') }),
    el('span', { class: 'pname', text: group.pattern }),
    el('span', { class: 'pcount' }, [
      el('b', { text: String(group.items.length) }),
      ` / ${group.total}`,
    ]),
    // With a single difficulty selected the bar would be one solid block saying
    // nothing, so it steps aside.
    state.difficulty === 'all' ? mixBar(group.items) : el('span'),
  ]);

  const section = el('section', { class: 'psec' + (open ? ' open' : '') }, head);

  const list = el('ul', { class: 'plist', id: 'sec-' + index });
  for (const problem of group.items) list.append(problemRow(problem, state, needle, handlers.onOpen));
  section.append(list);
  if (filtered) {
    section.append(el('div', {
      class: 'mono dim',
      style: 'padding:8px 16px;border-top:1px solid rgba(0,0,0,.06);letter-spacing:.12em',
      text: `${group.total - group.items.length} more in this pattern hidden by the filters`,
    }));
  }
  return section;
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

  const view = el('div', { class: 'view' });

  view.append(el('div', { class: 'viewhead' }, [
    el('div', {}, [
      el('h1', { text: 'NeetCode 250' }),
      el('div', { class: 'sub', text: `${data.problems.length} problems across ${data.patterns.length} patterns, in curriculum order — easiest ideas first.` }),
    ]),
    el('div', { class: 'legend', hidden: state.difficulty !== 'all' }, [
      el('span', { class: 'mono dim', text: 'Bar = difficulty mix' }),
      ...[['Easy', 'e'], ['Medium', 'm'], ['Hard', 'h']].map(([label, cls]) =>
        el('span', { class: 'lg' }, [el('i', { class: cls }), el('span', { class: 'mono dim', text: label })])),
    ]),
  ]));

  const controls = el('div', { class: 'filterbar' }, [
    el('div', { class: 'fgroup' }, [
      el('span', { class: 'mono dim', text: 'List' }),
      el('div', { class: 'chips' }, LIST_FILTERS.map(f =>
        chip(f.label, state.list === f.id, () => handlers.onList(f.id)))),
    ]),
    el('div', { class: 'fgroup' }, [
      el('span', { class: 'mono dim', text: 'Level' }),
      el('div', { class: 'chips' }, [
        chip('All', state.difficulty === 'all', () => handlers.onDifficulty('all')),
        ...DIFFICULTIES.map(d => chip(d, state.difficulty === d, () => handlers.onDifficulty(d), d.toLowerCase())),
      ]),
    ]),
    el('span', { class: 'spacer' }),
    el('span', { class: 'countpill' }, [
      digits(shown),
      el('span', { class: 'mono dim', text: shown === data.problems.length ? 'problems' : `of ${data.problems.length}` }),
    ]),
    anyCollapsible && !forcedOpen
      ? el('button', {
        class: 'linkbtn', type: 'button',
        text: allCollapsed ? 'Expand all' : 'Collapse all',
        onclick: () => handlers.onToggleAll(!allCollapsed),
      })
      : null,
  ]);
  view.append(controls);

  if (shown === 0) {
    view.append(el('section', { class: 'card' }, el('div', { class: 'emptynote' }, [
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
  view.append(sections);

  const silent = groups.filter(g => !g.items.length);
  if (silent.length) {
    view.append(el('div', {
      class: 'mono dim', style: 'margin-top:12px;text-align:center;letter-spacing:.12em',
      text: `No match in ${silent.length} other pattern${silent.length === 1 ? '' : 's'}: ${silent.map(g => g.pattern).join(' · ')}`,
    }));
  }

  view.append(el('div', { class: 'hint' }, [
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
