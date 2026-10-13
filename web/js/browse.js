// The browse screen: 250 problems grouped by the 18 NeetCode patterns, in the
// server's curriculum order. All filtering is client side — the whole list arrives
// at boot, so nothing here ever touches the network.

import { el, digits, frag } from './dom.js';
import { progressFor, summarizeProgress } from './catalog-progress.js';

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

function folderIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('folder-icon');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', 'M2 5h6l2 2h8v10H2Z');
  path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor'); path.setAttribute('stroke-width', '1.4'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); return svg;
}

function progressOverview(summary, state) {
  const ready = state.progress !== null;
  const total = summary.total;
  const accepted = ready ? summary.accepted : 0;
  return el('p',{class:'catalog-summary'},ready
    ? [el('b',{text:String(accepted)}),` of ${total} accepted · ${summary.localPass} passed locally · ${summary.attempted} in progress `,el('span',{class:'collection-track',role:'img','aria-label':`${accepted} of ${total} accepted on LeetCode`},el('span',{style:`width:${total ? accepted / total * 100 : 0}%`}))]
    : state.progressState === 'unavailable' ? 'Progress unavailable' : 'Loading your progress…');
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
    el('span', { class: `problem-state state-${progress.status}`, title: progress.label, 'aria-label': progress.label, text: progress.status === 'accepted' ? '✓' : progress.status === 'local-pass' ? '◐' : progress.status === 'attempted' ? '•' : '○' }),
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
    folderIcon(),
    el('span', { class: 'pname', text: group.pattern }),
    el('span', { class: 'pcount' }, [
      el('b', { text: String(group.items.length) }),
      ` / ${group.total}`,
    ]),
    // With a single difficulty selected the bar would be one solid block saying
    // nothing, so it steps aside.
    state.progress ? el('span', { class: 'folder-progress', text: `${summarizeProgress(group.items, state.progress).accepted} accepted` }) : el('span', { class: 'folder-progress', text: 'Progress —' }),
  ]);

  const section = el('section', { class: 'psec' + (open ? ' open' : '') }, head);

  const list = el('ul', { class: 'plist', id: 'sec-' + index });
  for (const problem of group.items) list.append(problemRow(problem, state, needle, handlers.onOpen));
  section.append(list);
  if (filtered) {
    section.append(el('div', {
      class: 'mono dim',
      style: 'padding:8px 16px;border-top:1px solid rgba(0,0,0,.06);font:500 11px/1.4 var(--ui);letter-spacing:0',
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

  const view = el('div', { class: 'view catalog' });

  view.append(el('div', { class: 'viewhead' }, [
    el('div', {}, [
      el('h1', { text: 'Problem explorer' }),
      el('div', { class: 'sub', text: 'A place for every pattern. A record of every attempt.' }),
    ]),
    el('div', {class:'catalog-modes', 'aria-label':'Catalog view'}, [
      el('button',{type:'button','aria-pressed':'true',text:'Explorer',onclick:()=>handlers.onCatalogMode('explorer')}),
      el('button',{type:'button','aria-pressed':'false',text:'Roadmap',onclick:()=>handlers.onCatalogMode('roadmap')}),
    ]),
    el('div', { class: 'legend', hidden: state.difficulty !== 'all' }, [
      el('span', { class: 'mono dim', text: 'Difficulty' }),
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
  const collection = data.problems.filter(problem => problem.lists[state.list]);
  const summary = summarizeProgress(collection, state.progress);
  view.append(progressOverview(summary, state));
  const layout = el('div', { class: 'catalog-layout' });
  const sidebar = el('nav', { class: 'catalog-tree', 'aria-label': 'Problem patterns' }, [
    el('div', { class: 'tree-heading', text: 'Explorer' }),
    el('div', { class: 'tree-legend', text: 'Accepted / total problems' }),
    el('button', { class: 'tree-root', type: 'button', 'aria-pressed': String(!state.pattern), onclick: () => handlers.onPattern(null) }, [folderIcon(), el('span', {text: LIST_FILTERS.find(f=>f.id===state.list)?.label || 'All problems'}), el('span', {class:'tree-count',text:String(collection.length)})]),
    ...data.patterns.map(pattern => {
      const items = collection.filter(problem => problem.pattern === pattern);
      const accepted = state.progress ? summarizeProgress(items, state.progress).accepted : null;
      return el('button', {type:'button',class:'tree-pattern',title:pattern,'aria-pressed':String(state.pattern === pattern),onclick:()=>handlers.onPattern(pattern)}, [
        folderIcon(), el('span',{text:pattern}), el('span',{class:'tree-count',text:accepted === null ? String(items.length) : `${accepted}/${items.length}`,title:accepted === null ? 'Problems' : 'Accepted / problems'}),
      ]);
    }),
    el('a', {class:'tree-report',href:'#/progress',text:'View practice report ↗'}),
  ]);
  const content = el('div', {class:'catalog-content'});
  layout.append(sidebar, content);
  view.append(layout);
  content.append(el('div', {class:'catalog-path'}, [el('span',{text:LIST_FILTERS.find(f=>f.id===state.list)?.label || 'Problems'}), el('span',{text:'/'}),el('strong',{text:state.pattern || 'All patterns'})]), controls);
  if (state.progressState === 'unavailable') content.append(el('div',{class:'catalog-unavailable'},[el('span',{text:'Progress unavailable. Your problem library is still accessible.'}),el('button',{type:'button',text:'Retry',onclick:handlers.onRetryProgress})]));

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
      class: 'mono dim', style: 'margin-top:12px;text-align:center;font:500 11px/1.4 var(--ui);letter-spacing:0',
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
