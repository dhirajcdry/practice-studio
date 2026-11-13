import { openLearningNotes } from './learning.js';
import { screenHeader, paneHeader } from './ui/headers.js';
// The problem screen: the problem pane beside the editor, whose Problem / Solution /
// Article tabs switch the pane's own content in place. The references are always one
// keystroke away and never open on their own — seeing the answer before you have
// tried is the one thing that would make this app useless.

import { icon } from './ui/icon.js';
import { currentCollection } from './browse.js';
import { el, replace, clear, frag } from './dom.js';
import { sanitizeHtml, isBlankHtml } from './sanitize.js';
import { structureStatement } from './statement.js';
import { renderMarkdown, codeBlock } from './markdown.js';
import { loadProblem, loadSolution, loadArticle, logSessionEvent, api } from './api.js';
import { mountWorkspace, enableWideLayout } from './editor.js';
import { mountCoach } from './coach.js';
import { workspaceRail } from './workspace.js';

// One tab view per open problem. The statement is rendered once and only hidden while
// Solution or Article shows, so coming back to it costs no fetch and keeps its scroll.
let tabs = null;

/* ------------------------------- small pieces ------------------------------- */

function skeleton(rows = 6) {
  const box = el('div', { class: 'skel' });
  const widths = ['100%', '96%', '88%', '70%', '100%', '54%', '92%', '64%'];
  for (let i = 0; i < rows; i++) box.append(el('i', { style: `width:${widths[i % widths.length]}` }));
  return box;
}

function stateBlock({ tone = '', head, body, actions = [] }) {
  return el('div', { class: 'state ui-inset ui-inset--roomy ' + tone }, [
    el('h3', { text: head }),
    ...[].concat(body).map(text => (text instanceof Node ? text : el('p', { text }))),
    actions.length
      ? el('div', { class: 'acts' }, actions.map(a =>
        el('button', { class: 'btn btn--quiet act', type: 'button', text: a.label, onclick: a.onClick })))
      : null,
  ]);
}

function licenseFooter(license, sourcePath) {
  const notice = license?.notice
    || 'Solutions and articles from neetcode-gh/leetcode, MIT licensed, Copyright (c) 2022 neetcode-gh.';
  return el('div', { class: 'dfoot' }, [
    el('div', { text: notice }),
    sourcePath ? el('div', { text: 'Source file: ' + sourcePath }) : null,
  ]);
}

/* ----------------------------------- tabs ----------------------------------- */

const TAB_KINDS = ['problem', 'solution', 'article'];

/** The tab showing in the problem pane: 'problem', 'solution' or 'article'. */
export function currentTab(slug = null) {
  if (!tabs || !tabs.pcol.isConnected || (slug && tabs.slug !== slug)) return 'problem';
  return tabs.kind;
}

// Wide, the pane scrolls itself; stacked (below 1081px) the page does.
function scroller() {
  const overflow = getComputedStyle(tabs.pcol).overflowY;
  return overflow === 'auto' || overflow === 'scroll' ? tabs.pcol : document.scrollingElement;
}

function syncTabs() {
  for (const button of tabs.pcol.querySelectorAll('.problem-tabs [role=tab]')) {
    button.setAttribute('aria-selected', String((button.dataset.panel || 'notes') === tabs.kind));
  }
  const onProblem = tabs.kind === 'problem';
  tabs.tags.hidden = !onProblem;
  for (const node of tabs.statement) node.hidden = !onProblem;
  tabs.pcol.dataset.tab = tabs.kind;
  for (const kind of ['solution', 'article']) {
    const panel = tabs.panels[kind];
    if (panel) panel.hidden = kind !== tabs.kind;
  }
}

/**
 * Show one tab of the problem pane in place. `toggle` (the s / a keys) turns a second
 * press of the same tab back into Problem.
 */
export async function showTab(entry, kind, { toggle = false, retry = false } = {}) {
  if (!tabs || !tabs.pcol.isConnected || tabs.slug !== entry.slug || !TAB_KINDS.includes(kind)) return;
  // A reference opened while the problem pane is collapsed brings the pane back first.
  const collapsed = document.body.classList.contains('hide-problem');
  if (collapsed && kind !== 'problem') {
    window.dispatchEvent(new Event('studio:show-problem'));
    if (tabs.kind === kind && !retry) return;
  }
  if (tabs.kind === kind && !retry) {
    if (toggle && kind !== 'problem') return showTab(entry, 'problem');
    return;
  }
  const scroll = scroller();
  if (tabs.kind !== kind && !collapsed) tabs.scroll[tabs.kind] = scroll.scrollTop;
  tabs.kind = kind;
  // Kept once it has loaded; a panel still loading keeps its skeleton.
  if (kind !== 'problem' && !tabs.results[kind] && !tabs.loading[kind]) {
    const panel = tabs.panels[kind] || el('section', {
      class: 'card ref-tab', role: 'tabpanel', id: `ref-${kind}`,
      'aria-label': kind === 'solution' ? 'Solution' : 'Article', dataset: { panel: kind },
    });
    replace(panel, el('div', { class: 'desc ref-body' }, skeleton(5)));
    if (!tabs.panels[kind]) { tabs.panels[kind] = panel; tabs.pcol.append(panel); }
  }
  syncTabs();
  restoreScroll(scroll, kind);
  if (kind === 'problem') return;

  const owner = tabs;
  const open = ++tabs.opens;
  let result = tabs.results[kind];
  if (!result) {
    const pending = tabs.loading[kind] ||= (kind === 'solution' ? loadSolution : loadArticle)(entry.slug, entry).then(loaded => {
      if (tabs !== owner) return loaded; // left the problem while it loaded
      delete owner.loading[kind];
      if (kind === 'solution') renderSolutionInto(owner.panels[kind], entry, loaded);
      else renderArticleInto(owner.panels[kind], entry, loaded);
      // A failed load is not kept: the next open asks again.
      if (loaded.ok) owner.results[kind] = loaded;
      if (owner.kind === kind && owner.scroll[kind] != null) scroller().scrollTop = owner.scroll[kind];
      return loaded;
    });
    result = await pending;
  }
  // The user may have moved on while we were waiting.
  if (tabs !== owner || tabs.kind !== kind || tabs.opens !== open) return;

  // Phase 3: revealing the answer is a real signal about how the solve went, and the
  // session log is what later turns it into "you reveal on 70% of DP problems". It is
  // logged once per open, and only once the reference is actually on screen — a panel
  // that failed to load revealed nothing, and a log line for it would be a lie.
  if (result.ok) {
    logSessionEvent(entry.slug, kind === 'solution' ? 'revealed_solution' : 'revealed_article', {
      title: entry.title || entry.slug,
    }).catch(() => {});
  }
}

function restoreScroll(scroll, kind) {
  const saved = tabs.scroll[kind];
  if (saved != null) { scroll.scrollTop = saved; return; }
  if (scroll === tabs.pcol) { scroll.scrollTop = 0; return; }
  // Stacked, a first visit starts at the pane's tabs if they have scrolled away.
  if (tabs.hero.getBoundingClientRect().top < 0) tabs.hero.scrollIntoView({ block: 'start', behavior: 'instant' });
}

function renderSolutionInto(panel, entry, result) {
  const body = el('div', { class: 'desc ref-body' });
  if (!result.ok) {
    const actions = [];
    if (entry.hasArticle) actions.push({ label: 'Open the article instead', onClick: () => showTab(entry, 'article') });
    if (result.kind !== 'missing') actions.push({ label: 'Try again', onClick: () => showTab(entry, 'solution', { retry: true }) });

    body.append(stateBlock({
      tone: result.kind === 'missing' ? '' : 'warn',
      head: result.kind === 'missing' ? 'No Python solution for this one' : 'Could not load the solution',
      body: result.kind === 'missing'
        ? [
          result.message,
          `About 26 of the 250 have no Python reference in the NeetCode bundle, and ${entry.title} is one of them.`,
          entry.hasArticle
            ? 'The written article covers this problem, so start there.'
            : (entry.youtubeVideoId
              ? 'There is no local article for this problem either. The video walkthrough (the Video link above) is the remaining reference.'
              : 'There is no local article for this problem either. You can check NeetCode using the NeetCode link above.'),
        ]
        : [result.message],
      actions,
    }));
    replace(panel, [body, licenseFooter(null, null)]);
    return;
  }

  const wrap = el('div', { class: 'codewrap' });
  const pre = codeBlock(result.code, result.language || 'python');
  pre.classList.add('solutioncode');
  const copy = el('button', {
    class: 'btn btn--quiet copy', type: 'button', text: 'Copy',
    onclick: async (event) => {
      try { await navigator.clipboard.writeText(result.code); event.target.textContent = 'Copied'; }
      catch { event.target.textContent = 'Copy failed'; }
      setTimeout(() => { event.target.textContent = 'Copy'; }, 1400);
    },
  });
  wrap.append(pre, copy);

  const rich = el('div', { class: 'rich' }, wrap);
  body.append(rich);
  if (result.source === 'mock') {
    body.append(el('div', { class: 'mono dim', style: 'margin-top:6px;font:500 11px/1.4 var(--ui);letter-spacing:0', text: 'Bundled sample — the studio server serves the full set.' }));
  }
  replace(panel, [body, licenseFooter(result.license, result.sourcePath)]);
}

function renderArticleInto(panel, entry, result) {
  const body = el('div', { class: 'desc ref-body' });
  if (!result.ok) {
    const actions = [];
    if (entry.hasPythonSolution) actions.push({ label: 'Open the solution instead', onClick: () => showTab(entry, 'solution') });
    if (result.kind !== 'missing') actions.push({ label: 'Try again', onClick: () => showTab(entry, 'article', { retry: true }) });
    body.append(stateBlock({
      tone: result.kind === 'missing' ? '' : 'warn',
      head: result.kind === 'missing' ? 'No article for this one' : 'Could not load the article',
      body: [result.message],
      actions,
    }));
    replace(panel, [body, licenseFooter(null, null)]);
    return;
  }

  const rich = el('div', { class: 'rich' });
  rich.append(renderMarkdown(result.markdown));
  if (rich.textContent.trim() === '') {
    body.append(stateBlock({
      tone: 'warn', head: 'The article came back empty',
      body: ['The server returned an article for this problem, but it had no readable content.'],
    }));
  } else {
    body.append(rich);
  }
  if (result.source === 'mock') {
    body.append(el('div', { class: 'mono dim', style: 'margin-top:14px;font:500 11px/1.4 var(--ui);letter-spacing:0', text: 'Bundled sample — the studio server serves the full set.' }));
  }
  replace(panel, [body, licenseFooter(result.license, result.sourcePath)]);
}

/* -------------------------------- the screen -------------------------------- */

export function renderProblem(entry, context) {
  const view = el('div', { class: 'view' });
  const { neighbours, onOpen, canShuffle, shuffleBusy = false, onShuffle } = context;

  const titleEl = el('h1', { text: entry.title });
  const badgeRow = el('span', { class: 'row1-badges', style: 'display:contents' });
  // Pattern first, then the one list badge, then LeetCode's topics as they arrive. The
  // lists nest (every Blind 75 problem is also in the 150 and the 250), so only the
  // narrowest one is worth printing.
  const tags = el('div', { class: 'ptags' }, [
    el('span', { class: 'tag pattern', text: entry.pattern, title: 'Pattern' }),
    entry.interviewPrep ? el('span', { class: 'tag quiet', text: currentCollection()?.id || 'collection' }) : null,
    entry.leetcodePremium ? el('span', { class: 'tag quiet', text: 'LeetCode Premium' }) : null,
    entry.lists.blind75
      ? el('span', { class: 'tag', text: 'Blind 75' })
      : entry.lists.neetcode150
        ? el('span', { class: 'tag quiet', text: 'NeetCode 150' })
        : null,
  ]);
  const hero = el('section', { class: 'card' }, [
    el('div', { class: 'phero' }, [
      el('div', { class: 'row1' }, [
        el('span', { class: 'pno', text: entry.number ? String(entry.number) : '' }),
        titleEl,
        el('span', { class: 'tag ' + entry.difficulty.toLowerCase(), text: entry.difficulty }),
        badgeRow,
        el('span', { class: 'pnav' }, [['previous', 'Previous'], ['next', 'Next']].map(([key, label]) => {
          const neighbour = neighbours[key];
          return el('button', {
            class: 'btn btn--icon pnav-btn', type: 'button',
            title: neighbour ? `${label}: ${neighbour.title} (⌘${key === 'previous' ? '←' : '→'})` : `${label} (⌘${key === 'previous' ? '←' : '→'})`,
            'aria-label': neighbour ? `${label}: ${neighbour.title}; keyboard shortcut Command ${key === 'previous' ? 'Left Arrow' : 'Right Arrow'}` : `${label}; keyboard shortcut Command ${key === 'previous' ? 'Left Arrow' : 'Right Arrow'}`,
            disabled: !neighbour, onclick: () => { if (neighbour) onOpen(neighbour.slug); },
          }, icon(key === 'previous' ? 'back' : 'forward', 15));
        }).concat(el('button', {
          class: 'btn btn--icon pnav-btn pnav-shuffle', type: 'button',
          title: canShuffle ? 'Random problem (r)' : 'Random problem: nothing else matches your filters',
          'aria-label': shuffleBusy ? 'Finding a LeetCode problem…' : canShuffle ? 'Random problem; keyboard shortcut R' : 'Random problem; nothing else matches your filters',
          disabled: shuffleBusy || !canShuffle, 'aria-busy': String(shuffleBusy), onclick: () => onShuffle?.(),
        }, [icon('shuffle', 14), el('span', { class: 'shuffle-label', role: 'status', text: '' })]))),
      ]),
      tags,
    ]),
    el('div', { class: 'paneltoggles' }, [
      panelToggle(entry, 'solution', 'Solution', 's', entry.hasPythonSolution),
      panelToggle(entry, 'article', 'Article', 'a', entry.hasArticle),
      el('span', { class: 'plinks' }, [
        entry.youtubeVideoId ? el('a', { class: 'plink', target: '_blank', rel: 'noopener noreferrer',
          href: `https://www.youtube.com/watch?v=${encodeURIComponent(entry.youtubeVideoId)}`, text: 'Video' }) : null,
        entry.neetcodeSlug ? el('a', { class: 'plink', target: '_blank', rel: 'noopener noreferrer',
          href: `https://neetcode.io/problems/${encodeURIComponent(entry.neetcodeSlug)}`, text: 'NeetCode' }) : null,
        el('a', { class: 'plink', target: '_blank', rel: 'noopener noreferrer',
          href: `https://leetcode.com/problems/${encodeURIComponent(entry.slug)}/`, text: 'LeetCode' }),
      ]),
    ]),
  ]);

  const descCard = el('section', { class: 'card' }, el('div', { class: 'desc' }, skeleton(7)));
  // Phase 2: the problem — heading, statement, quick facts — on the left, the code
  // workspace pinned full-height on the right, so both are in one glance. The hero
  // moved into the left column so the editor starts at the top of the screen rather
  // than a scroll below it. `f` collapses the left column when it is time to write.
  // Phase 3 adds a third column: the coach, beside the editor rather than over it,
  // and closed until asked for — the launcher in the corner and `c` open it. When it
  // is closed the grid falls back to two columns and the editor keeps its width.
  enableWideLayout(true);
  const contentPromise = loadProblem(entry.slug, entry);
  let workspaceActions;
  const workspace = mountWorkspace(entry, { contentPromise, headerActions: actions => { workspaceActions = actions; } });
  const nav = [...hero.querySelectorAll('.pnav-btn')];
  const links = [...hero.querySelectorAll('.plink')];
  // The three ways out sit beside the pane's tabs, one click away, not folded into a menu.
  for (const link of links) {
    const name = link.textContent;
    link.className = 'btn btn--quiet pane-link plink';
    link.setAttribute('aria-label', name === 'Video' ? 'Watch the video walkthrough (opens in a new tab)' : `Open on ${name} (opens in a new tab)`);
    link.title = name === 'Video' ? 'Watch the video walkthrough' : `Open on ${name}`;
    link.replaceChildren(icon(name === 'Video' ? 'play' : 'external', 13), el('span', { text: name }));
  }
  const header = screenHeader({ back: { href: '#/', label: 'Back to problems' },
    crumb: context.listLabel || 'Problems', title: titleEl,
    badges: [hero.querySelector('.tag.' + entry.difficulty.toLowerCase()), badgeRow],
    meta: [entry.number ? `No. ${entry.number}` : '', entry.pattern, workspaceActions.status],
    actions: { primary: workspaceActions.submit, secondary: [...nav, el('span', { class: 'ui-header-separator', 'aria-hidden': 'true' }), workspaceActions.run] },
  });
  const toggles = hero.querySelector('.paneltoggles');
  toggles.className = 'ui-tabs problem-tabs';
  toggles.setAttribute('role', 'tablist');
  toggles.querySelector('.plinks')?.remove();
  toggles.prepend(el('button', { class: 'btn btn--quiet ui-tab', type: 'button', role: 'tab', 'aria-selected': 'true', 'aria-controls': 'ref-problem', dataset: { panel: 'problem' }, text: 'Problem', onclick: () => showTab(entry, 'problem') }));
  // Notes is a larger surface of its own, so it stays a dialog rather than a tab body.
  toggles.append(el('button', { class: 'btn btn--quiet ui-tab', type: 'button', role: 'tab', 'aria-selected': 'false', text: 'Notes', onclick: () => openLearningNotes(entry.slug, entry.title) }));
  hero.replaceChildren(paneHeader({ tabs: toggles, tools: [el('nav', { class: 'pane-links', 'aria-label': 'This problem elsewhere' }, links)] }), tags);
  view.append(header, workspaceRail());
  const prepCard = interviewPrepCard(entry);
  descCard.id = 'ref-problem';
  descCard.setAttribute('role', 'tabpanel');
  descCard.setAttribute('aria-label', 'Problem');
  const pcol = el('div', { class: 'pcol', dataset: { tab: 'problem' } }, [hero, prepCard, descCard]);
  tabs = {
    slug: entry.slug, kind: 'problem', pcol, hero, tags, statement: [prepCard, descCard].filter(Boolean),
    panels: {}, results: {}, loading: {}, scroll: {}, opens: 0,
  };
  view.append(el('div', { class: 'pbody with-workspace' }, [
    pcol,
    workspace,
    mountCoach(entry),
  ]));

  contentPromise.then(result => {
    if (!document.body.contains(descCard)) return; // navigated away
    fillDescription(descCard, tags, titleEl, badgeRow, entry, result);
  });

  return view;
}

function interviewPrepCard(entry) {
  const prep = entry.interviewPrep;
  if (!prep) return null;
  if (prep.origin === 'personal') {
    return el('section', { class: 'card', 'aria-label': 'Personal practice selection' },
      el('details', { class: 'desc rich prep-note', dataset: { interviewPrep: prep.id } }, [
        el('summary', {}, [icon('forward', 15), el('span', { text: `${prep.id} · Added by you · Personal practice` })]),
        el('p', { text: prep.reportedPrompt }),
        el('p', { text: prep.caveat }),
        el('p', {}, ['Problem source: ', ...prep.sources.map(source =>
          el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: `${source.id} ` }))]),
      ]));
  }
  const collection = currentCollection();
  const checked = collection?.checkedAt ? ` Mappings checked ${collection.checkedAt}.` : '';
  return el('section', { class: 'card', 'aria-label': `${collection?.label || 'Collection'} preparation` },
    el('details', { class: 'desc rich prep-note', dataset: { interviewPrep: prep.id } }, [
      el('summary', {}, [icon('forward', 15), el('span', { text: `${prep.id} · ${prep.priority} · ${prep.match}` })]),
      el('p', { text: prep.reportedPrompt }),
      el('p', {}, [el('strong', { text: 'Mapping caveat: ' }), prep.caveat]),
      el('p', {}, [el('strong', { text: 'Practice: ' }), prep.practice]),
      el('p', { text: `Reported round: ${prep.round}. Source assessment: ${prep.authenticity}.` }),
      el('p', {}, ['Candidate report sources: ', ...prep.sources.map(source =>
        el('a', { href: source.url, target: '_blank', rel: 'noopener noreferrer', text: `${source.id} ` }))]),
      el('p', { text: `Candidate reports supplied for preparation, not verified transcripts or predictions. Practice extensions are suggested exercises.${checked}` }),
    ]));
}

function panelToggle(entry, kind, label, key, available) {
  const button = el('button', {
    class: 'btn btn--quiet ui-tab ptoggle' + (available ? '' : ' miss'),
    type: 'button', role: 'tab',
    'aria-selected': 'false', 'aria-controls': `ref-${kind}`,
    dataset: { panel: kind },
    onclick: () => showTab(entry, kind),
  }, [
    label,
    available ? null : el('span', { class: 'ptag', text: '· none' }),
    el('kbd', { text: key }),
  ]);
  return button;
}

function fillDescription(card, tags, titleEl, badgeRow, entry, result) {
  const target = card.querySelector('.desc');
  clear(target);
  clear(badgeRow);
  for (const topic of tags.querySelectorAll('[data-topic]')) topic.remove();

  if (!result.ok) {
    target.append(stateBlock({
      tone: 'err',
      head: 'Description unavailable',
      body: result.code === 'DEMO_CONTENT_UNAVAILABLE'
        ? 'No cached statement is available for this problem. Open it on LeetCode.'
        : result.kind === 'timeout'
        ? 'LeetCode did not respond in time. Retry or open the statement directly.'
        : 'The statement is not available offline. Open it on LeetCode or retry your connection.',
      actions: [
        {label:'Open on LeetCode',onClick:()=>window.open(`https://leetcode.com/problems/${encodeURIComponent(entry.slug)}/`, '_blank', 'noopener,noreferrer')},
        ...(result.code === 'DEMO_CONTENT_UNAVAILABLE' ? [] : [{label:'Retry',onClick:()=>{replace(target,skeleton(7));loadProblem(entry.slug,entry).then(r=>fillDescription(card,tags,titleEl,badgeRow,entry,r));}}]),
      ],
    }));
    return;
  }

  const content = result.content || null;

  if (content?.title && content.title !== entry.title) titleEl.textContent = content.title;
  if (content?.stale) badgeRow.append(el('span', { class: 'tag alert', text: 'Cached copy' }));
  if (content?.isPaidOnly) badgeRow.append(el('span', { class: 'tag alert', text: 'Premium' }));
  if (result.source === 'mock') badgeRow.append(el('span', { class: 'tag quiet', text: 'Sample text' }));

  for (const topic of content?.topicTags || []) {
    if (String(topic).toLowerCase() === (entry.pattern || '').toLowerCase()) continue;
    tags.append(el('span', { class: 'tag quiet', text: String(topic), 'data-topic': '1' }));
  }

  // Only LeetCode marks premium; a mirrored statement still renders normally.
  // catalog.isPro is NeetCode-pro, a different thing entirely, and is never used here.
  if (content?.isPaidOnly === true && !content.descriptionHtml && !content.descriptionMarkdown) {
    target.append(stateBlock({
      tone: 'warn',
      head: 'This one is LeetCode premium',
      body: [
        'LeetCode does not serve the statement for premium problems without a subscription.',
        'The statement could not be fetched from doocs/leetcode.',
        entry.hasArticle || entry.hasPythonSolution
          ? 'The NeetCode article and reference solution still describe the problem and the approach — open them from the buttons above.'
          : 'There is no article or reference solution for this one either; you will have to read it on LeetCode directly.',
      ],
      actions: [
        entry.hasArticle ? { label: 'Open the article', onClick: () => showTab(entry, 'article') } : null,
        entry.hasPythonSolution ? { label: 'Open the solution', onClick: () => showTab(entry, 'solution') } : null,
      ].filter(Boolean),
    }));
    return;
  }

  if (!content || (!content.descriptionMarkdown && content.descriptionHtml == null)) {
    target.append(stateBlock({
      tone: 'err',
      head: 'No description came back',
      body: ['The server answered, but this problem had no statement attached. That usually means LeetCode moved or renamed the slug.'],
      actions: entry.hasArticle ? [{ label: 'Open the article', onClick: () => showTab(entry, 'article') }] : [],
    }));
    return;
  }

  if (!content.descriptionMarkdown && isBlankHtml(content.descriptionHtml)) {
    target.append(stateBlock({
      tone: 'warn', head: 'The description had nothing readable in it',
      body: ['Every element in the statement was stripped as unsafe or empty. Read it on LeetCode instead.'],
    }));
    return;
  }

  if (content.stale) {
    target.append(el('div', {
      class: 'mono dim', style: 'margin-bottom:14px;font:500 11px/1.4 var(--ui);letter-spacing:0',
      text: 'Served from cache — LeetCode was unreachable when this page loaded.',
    }));
  }
  if (result.source === 'mock') {
    target.append(el('div', {
      class: 'mono dim', style: 'margin-bottom:14px;font:500 11px/1.4 var(--ui);letter-spacing:0',
      text: 'Placeholder statement — the real one is fetched by the studio server.',
    }));
  }

  const rich = el('div', { class: 'rich' });
  rich.append(content.descriptionMarkdown ? renderMarkdown(content.descriptionMarkdown) : sanitizeHtml(content.descriptionHtml));
  dropSpacerParagraphs(rich);
  // Example N is published case N in the test panel, so an example can be opened there.
  const perCase = content.metaData?.params?.length || 0;
  const published = perCase && typeof content.exampleTestcases === 'string'
    ? Math.floor(content.exampleTestcases.trim().split('\n').length / perCase) : 0;
  target.append(structureStatement(rich, { onTryExample: {
    available: number => number <= published,
    open: number => window.dispatchEvent(new CustomEvent('studio:show-case', { detail: { slug: entry.slug, number } })),
  } }));
  if (content.statementSource) {
    target.append(el('p', { class: 'dim', style: 'font-size:11px' }, el('a', {
      href: content.statementSource.url, target: '_blank', rel: 'noopener noreferrer',
      text: content.descriptionMarkdown ? 'Statement via NeetCode' : 'Statement via doocs/leetcode (CC BY-SA 4.0)',
    })));
  }
}

/** LeetCode pads its statements with `<p>&nbsp;</p>`. Real spacing comes from CSS. */
function dropSpacerParagraphs(root) {
  for (const p of root.querySelectorAll('p')) {
    const empty = p.textContent.replace(/[\s ]+/g, '') === '' && !p.querySelector('img');
    if (empty) p.remove();
  }
}

export { api };
