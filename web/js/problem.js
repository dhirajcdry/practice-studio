// The problem screen: description on the left, quick facts on the right, and the
// Solution / Article reference panels as a slide-open drawer. The panels are always
// one keystroke away and never open on their own — seeing the answer before you have
// tried is the one thing that would make this app useless.

import { el, replace, clear, frag } from './dom.js';
import { sanitizeHtml, isBlankHtml } from './sanitize.js';
import { renderMarkdown, codeBlock } from './markdown.js';
import { loadProblem, loadSolution, loadArticle, logSessionEvent, api } from './api.js';
import { mountWorkspace, enableWideLayout } from './editor.js';
import { mountCoach } from './coach.js';

const drawerEl = document.getElementById('drawer');
const scrimEl = document.getElementById('scrim');

let drawerState = { slug: null, kind: null };
let onDrawerChange = () => {};

/* ------------------------------- small pieces ------------------------------- */

function skeleton(rows = 6) {
  const box = el('div', { class: 'skel' });
  const widths = ['100%', '96%', '88%', '70%', '100%', '54%', '92%', '64%'];
  for (let i = 0; i < rows; i++) box.append(el('i', { style: `width:${widths[i % widths.length]}` }));
  return box;
}

function stateBlock({ tone = '', head, body, actions = [] }) {
  return el('div', { class: 'state ' + tone }, [
    el('h3', { text: head }),
    ...[].concat(body).map(text => (text instanceof Node ? text : el('p', { text }))),
    actions.length
      ? el('div', { class: 'acts' }, actions.map(a =>
        el('button', { class: 'act', type: 'button', text: a.label, onclick: a.onClick })))
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

function metaCell(label, value) {
  return el('span', { class: 'cell' }, [
    el('span', { class: 'mono dim', text: label }),
    el('span', { class: 'v', text: value }),
  ]);
}

/* ---------------------------------- drawer ---------------------------------- */

export function isDrawerOpen() { return drawerState.kind !== null; }

export function closeDrawer() {
  if (!drawerState.kind) return;
  drawerState = { slug: null, kind: null };
  drawerEl.classList.remove('show');
  scrimEl.classList.remove('show');
  drawerEl.setAttribute('aria-hidden', 'true');
  setTimeout(() => {
    if (drawerState.kind) return;
    drawerEl.hidden = true; scrimEl.hidden = true; clear(drawerEl);
  }, 240);
  onDrawerChange();
}

function drawerShell(entry, kind) {
  const tabs = el('div', { class: 'dtabs', role: 'tablist' }, [
    el('button', {
      class: 'dtab', role: 'tab', type: 'button', 'aria-selected': String(kind === 'solution'),
      text: 'Solution', onclick: () => openPanel(entry, 'solution'),
    }),
    el('button', {
      class: 'dtab', role: 'tab', type: 'button', 'aria-selected': String(kind === 'article'),
      text: 'Article', onclick: () => openPanel(entry, 'article'),
    }),
  ]);
  const head = el('div', { class: 'dhead' }, [
    tabs,
    el('span', { class: 'dtitle', text: entry.title }),
    el('button', { class: 'dclose', type: 'button', text: 'Close esc', onclick: closeDrawer }),
  ]);
  const body = el('div', { class: 'dbody' });
  replace(drawerEl, [head, body]);
  return body;
}

export async function openPanel(entry, kind) {
  const sameAgain = drawerState.slug === entry.slug && drawerState.kind === kind;
  if (sameAgain) { closeDrawer(); return; }

  drawerState = { slug: entry.slug, kind };
  drawerEl.hidden = false; scrimEl.hidden = false;
  drawerEl.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => { drawerEl.classList.add('show'); scrimEl.classList.add('show'); });
  onDrawerChange();

  const body = drawerShell(entry, kind);
  body.append(skeleton(5));

  const result = kind === 'solution'
    ? await loadSolution(entry.slug, entry)
    : await loadArticle(entry.slug, entry);

  // The user may have moved on while we were waiting.
  if (drawerState.slug !== entry.slug || drawerState.kind !== kind) return;

  clear(body);
  if (kind === 'solution') renderSolutionInto(body, entry, result);
  else renderArticleInto(body, entry, result);

  // Phase 3: revealing the answer is a real signal about how the solve went, and the
  // session log is what later turns it into "you reveal on 70% of DP problems". It is
  // logged only once the reference is actually on screen — a panel that failed to load
  // revealed nothing, and a log line for it would be a lie.
  if (result.ok) {
    logSessionEvent(entry.slug, kind === 'solution' ? 'revealed_solution' : 'revealed_article', {
      title: entry.title || entry.slug,
    }).catch(() => {});
  }
}

function renderSolutionInto(body, entry, result) {
  if (!result.ok) {
    const actions = [];
    if (entry.hasArticle) actions.push({ label: 'Open the article instead', onClick: () => openPanel(entry, 'article') });
    if (result.kind !== 'missing') actions.push({ label: 'Try again', onClick: () => openPanel(entry, 'solution') });

    body.append(stateBlock({
      tone: result.kind === 'missing' ? '' : 'warn',
      head: result.kind === 'missing' ? 'No Python solution for this one' : 'Could not load the solution',
      body: result.kind === 'missing'
        ? [
          result.message,
          `About 26 of the 250 have no Python reference in the NeetCode bundle, and ${entry.title} is one of them.`,
          entry.hasArticle
            ? 'The written article covers this problem, so start there.'
            : 'There is no article for this one either — the video walkthrough on NeetCode is the remaining reference.',
        ]
        : [result.message],
      actions,
    }));
    drawerEl.append(licenseFooter(null, null));
    return;
  }

  const wrap = el('div', { class: 'codewrap' });
  const pre = codeBlock(result.code, result.language || 'python');
  pre.classList.add('solutioncode');
  const copy = el('button', {
    class: 'copy', type: 'button', text: 'Copy',
    onclick: async (event) => {
      try { await navigator.clipboard.writeText(result.code); event.target.textContent = 'Copied'; }
      catch { event.target.textContent = 'Copy failed'; }
      setTimeout(() => { event.target.textContent = 'Copy'; }, 1400);
    },
  });
  wrap.append(pre, copy);

  const rich = el('div', { class: 'rich' }, wrap);
  body.append(
    el('div', { class: 'mono dim', style: 'margin-bottom:10px', text: `${result.language || 'python'} reference · ${entry.title}` }),
    rich,
  );
  if (result.source === 'mock') {
    body.append(el('div', { class: 'mono dim', style: 'margin-top:6px;letter-spacing:.1em', text: 'Bundled sample — the studio server serves the full set.' }));
  }
  drawerEl.append(licenseFooter(result.license, result.sourcePath));
}

function renderArticleInto(body, entry, result) {
  if (!result.ok) {
    const actions = [];
    if (entry.hasPythonSolution) actions.push({ label: 'Open the solution instead', onClick: () => openPanel(entry, 'solution') });
    if (result.kind !== 'missing') actions.push({ label: 'Try again', onClick: () => openPanel(entry, 'article') });
    body.append(stateBlock({
      tone: result.kind === 'missing' ? '' : 'warn',
      head: result.kind === 'missing' ? 'No article for this one' : 'Could not load the article',
      body: [result.message],
      actions,
    }));
    drawerEl.append(licenseFooter(null, null));
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
    body.append(el('div', { class: 'mono dim', style: 'margin-top:14px;letter-spacing:.1em', text: 'Bundled sample — the studio server serves the full set.' }));
  }
  drawerEl.append(licenseFooter(result.license, result.sourcePath));
}

/* -------------------------------- the screen -------------------------------- */

export function renderProblem(entry, context) {
  const view = el('div', { class: 'view' });
  const { neighbours, onBack, onOpen } = context;

  view.append(el('div', { class: 'crumb' }, [
    el('button', { class: 'linkbtn', type: 'button', text: '← All problems', onclick: onBack }),
    neighbours.previous
      ? el('button', { class: 'linkbtn', type: 'button', text: '↑ ' + neighbours.previous.title, onclick: () => onOpen(neighbours.previous.slug) })
      : null,
    neighbours.next
      ? el('button', { class: 'linkbtn', type: 'button', text: '↓ ' + neighbours.next.title, onclick: () => onOpen(neighbours.next.slug) })
      : null,
  ]));

  const titleEl = el('h1', { text: entry.title });
  const badgeRow = el('span', { class: 'row1-badges', style: 'display:contents' });
  const hero = el('section', { class: 'card' }, [
    el('div', { class: 'phero' }, [
      el('div', { class: 'row1' }, [
        el('span', { class: 'pno', text: entry.number ? String(entry.number) : '' }),
        titleEl,
        el('span', { class: 'tag ' + entry.difficulty.toLowerCase(), text: entry.difficulty }),
        // One list badge, the narrowest it belongs to. The lists nest — every Blind 75
        // problem is also in the 150 and the 250 — so printing all of them says nothing
        // the first one did not, and wraps the title onto a second row to say it.
        entry.lists.blind75
          ? el('span', { class: 'tag', text: 'Blind 75' })
          : entry.lists.neetcode150
            ? el('span', { class: 'tag quiet', text: 'NeetCode 150' })
            : null,
        badgeRow,
      ]),
      // Only the pattern. Whether a solution or article exists is already said by the
      // two buttons below, which grey out and read "· none" when they are missing.
      el('div', { class: 'meta' }, [metaCell('Pattern', entry.pattern)]),
    ]),
    el('div', { class: 'paneltoggles' }, [
      panelToggle(entry, 'solution', 'Solution', 's', entry.hasPythonSolution),
      panelToggle(entry, 'article', 'Article', 'a', entry.hasArticle),
    ]),
  ]);

  const descCard = el('section', { class: 'card' }, el('div', { class: 'desc' }, skeleton(7)));
  const rail = el('div', { class: 'prail' }, el('section', { class: 'card railcard' }, [
    el('h3', { text: 'Links' }),
    el('a', {
      class: 'extlink', target: '_blank', rel: 'noopener noreferrer',
      href: `https://leetcode.com/problems/${encodeURIComponent(entry.slug)}/`,
      text: 'LeetCode ↗',
    }),
    el('a', {
      class: 'extlink', target: '_blank', rel: 'noopener noreferrer',
      href: `https://neetcode.io/problems/${encodeURIComponent(entry.neetcodeSlug || entry.slug)}`,
      text: 'NeetCode ↗',
    }),
    entry.youtubeVideoId ? el('a', {
      class: 'extlink', target: '_blank', rel: 'noopener noreferrer',
      href: `https://www.youtube.com/watch?v=${encodeURIComponent(entry.youtubeVideoId)}`,
      text: 'Video walkthrough ↗',
    }) : null,
  ]));
  // Phase 2: the problem — heading, statement, quick facts — on the left, the code
  // workspace pinned full-height on the right, so both are in one glance. The hero
  // moved into the left column so the editor starts at the top of the screen rather
  // than a scroll below it. `f` collapses the left column when it is time to write.
  // Phase 3 adds a third column: the coach, beside the editor rather than over it,
  // and closed until asked for — the launcher in the corner and `c` open it. When it
  // is closed the grid falls back to two columns and the editor keeps its width.
  enableWideLayout(true);
  view.append(el('div', { class: 'pbody with-workspace' }, [
    el('div', { class: 'pcol' }, [hero, descCard, rail]),
    mountWorkspace(entry),
    mountCoach(entry),
  ]));

  loadProblem(entry.slug, entry).then(result => {
    if (!document.body.contains(descCard)) return; // navigated away
    fillDescription(descCard, rail, titleEl, badgeRow, entry, result);
  });

  return view;
}

function panelToggle(entry, kind, label, key, available) {
  const button = el('button', {
    class: 'ptoggle' + (available ? '' : ' miss'),
    type: 'button',
    'aria-pressed': String(drawerState.slug === entry.slug && drawerState.kind === kind),
    dataset: { panel: kind },
    onclick: () => openPanel(entry, kind),
  }, [
    label,
    available ? null : el('span', { class: 'ptag', text: '· none' }),
    el('kbd', { text: key }),
  ]);
  return button;
}

function fillDescription(card, rail, titleEl, badgeRow, entry, result) {
  const target = card.querySelector('.desc');
  clear(target);
  clear(badgeRow);

  if (!result.ok) {
    target.append(stateBlock({
      tone: 'err',
      head: result.kind === 'timeout' ? 'The description timed out' : 'The description could not be loaded',
      body: [
        result.message,
        'Everything else on this page still works: the pattern list, the search, and the Solution and Article panels above.',
      ],
      actions: [{
        label: 'Try again',
        onClick: () => { replace(target, skeleton(7)); loadProblem(entry.slug, entry).then(r => fillDescription(card, rail, titleEl, badgeRow, entry, r)); },
      }],
    }));
    return;
  }

  const content = result.content || null;

  if (content?.title && content.title !== entry.title) titleEl.textContent = content.title;
  if (content?.stale) badgeRow.append(el('span', { class: 'tag alert', text: 'Cached copy' }));
  if (content?.isPaidOnly) badgeRow.append(el('span', { class: 'tag alert', text: 'Premium' }));
  if (result.source === 'mock') badgeRow.append(el('span', { class: 'tag quiet', text: 'Sample text' }));

  // The rail is worth filling even when the statement itself is withheld —
  // premium responses still carry topic tags and example test cases.
  fillRail(rail, content);

  // `content.isPaidOnly` is the ONLY authority on "you cannot read this here".
  // catalog.isPro is NeetCode-pro, a different thing entirely, and is never used here.
  if (content && content.isPaidOnly === true) {
    target.append(stateBlock({
      tone: 'warn',
      head: 'This one is LeetCode premium',
      body: [
        'LeetCode does not serve the statement for premium problems without a subscription, so there is nothing to show here.',
        entry.hasArticle || entry.hasPythonSolution
          ? 'The NeetCode article and reference solution still describe the problem and the approach — open them from the buttons above.'
          : 'There is no article or reference solution for this one either; you will have to read it on LeetCode directly.',
      ],
      actions: [
        entry.hasArticle ? { label: 'Open the article', onClick: () => openPanel(entry, 'article') } : null,
        entry.hasPythonSolution ? { label: 'Open the solution', onClick: () => openPanel(entry, 'solution') } : null,
      ].filter(Boolean),
    }));
    return;
  }

  if (!content || content.descriptionHtml === null || content.descriptionHtml === undefined) {
    target.append(stateBlock({
      tone: 'err',
      head: 'No description came back',
      body: ['The server answered, but this problem had no statement attached. That usually means LeetCode moved or renamed the slug.'],
      actions: entry.hasArticle ? [{ label: 'Open the article', onClick: () => openPanel(entry, 'article') }] : [],
    }));
    return;
  }

  if (isBlankHtml(content.descriptionHtml)) {
    target.append(stateBlock({
      tone: 'warn', head: 'The description had nothing readable in it',
      body: ['Every element in the statement was stripped as unsafe or empty. Read it on LeetCode instead.'],
    }));
    return;
  }

  if (content.stale) {
    target.append(el('div', {
      class: 'mono dim', style: 'margin-bottom:14px;letter-spacing:.1em',
      text: 'Served from cache — LeetCode was unreachable when this page loaded.',
    }));
  }
  if (result.source === 'mock') {
    target.append(el('div', {
      class: 'mono dim', style: 'margin-bottom:14px;letter-spacing:.1em',
      text: 'Placeholder statement — the real one is fetched by the studio server.',
    }));
  }

  const rich = el('div', { class: 'rich' });
  rich.append(sanitizeHtml(content.descriptionHtml));
  dropSpacerParagraphs(rich);
  target.append(rich);
}

/** LeetCode pads its statements with `<p>&nbsp;</p>`. Real spacing comes from CSS. */
function dropSpacerParagraphs(root) {
  for (const p of root.querySelectorAll('p')) {
    const empty = p.textContent.replace(/[\s ]+/g, '') === '' && !p.querySelector('img');
    if (empty) p.remove();
  }
}

/** Topics and example input, whenever the server gives them — premium included. */
function fillRail(rail, content) {
  for (const stale of rail.querySelectorAll('[data-railextra]')) stale.remove(); // retry-safe
  if (!content) return;
  if (Array.isArray(content.topicTags) && content.topicTags.length) {
    rail.prepend(el('section', { class: 'card railcard', dataset: { railextra: '1' } }, [
      el('h3', { text: 'Topics' }),
      el('div', { class: 'taglist' }, content.topicTags.map(t => el('span', { class: 'tag quiet', text: String(t) }))),
    ]));
  }
  if (content.exampleTestcases) {
    rail.append(el('section', { class: 'card railcard', dataset: { railextra: '1' } }, [
      el('h3', { text: 'Example input' }),
      el('pre', { text: String(content.exampleTestcases) }),
    ]));
  }
}

/** Let main.js keep the toggle buttons in sync with the drawer. */
export function setDrawerListener(fn) { onDrawerChange = fn; }
export function drawerKind() { return drawerState.kind; }
export { api };
