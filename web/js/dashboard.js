import { leetcodeViews } from './leetcode-views.js';
import { screenHeader } from './ui/headers.js';
// Practice Studio — Phase 6, the progress dashboard ("how am I actually doing").
//
// Mounts with `init(mountEl, api)`. Everything it draws comes from `GET /api/stats`,
// which reads ~/LeetCodeTutor/ and nothing else.
//
// The governing rule, and the reason several things here look like less than they could:
// **no number appears on this screen that is not on disk.** There is no smoothing, no
// projection, no "estimated", no filler series to make a chart look inhabited. When a
// signal has too little evidence to mean anything, the space it would occupy is filled by
// an explicit statement of how much evidence it has and how much it needs. That block is
// designed on purpose — it is the state this screen will actually be in for a while, and
// it should read as a measuring instrument that is honest about its resolution, not as a
// dashboard that failed to load.
//
// Three facts this file refuses to conflate:
//   · "0 solved"          — we read the workspace and nothing records a solve
//   · "nothing recorded"  — there is no record to read; a different sentence entirely
//   · "passed locally"    — the example tests passed here, which is not an accepted verdict

import { el, replace } from './dom.js';

const STATS_TIMEOUT_MS = 8000;
const STYLESHEET = './css/dashboard.css';

/* ============================================================ pure helpers
   Everything below is a pure function of its arguments so it can be checked by
   runSelfTests() without a server, a DOM, or a fixture directory. */

/** Percentage, or null when there is no denominator to divide by. */
export function pctOf(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return null;
  return (part / total) * 100;
}

/** A duration the way a person says it. Never rounds a real value away to "0". */
export function fmtDurationMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = ms / 1000;
  if (seconds < 1) return `${Math.round(ms)}ms`;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const totalMinutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds - totalMinutes * 60);
  if (totalMinutes < 60) return restSeconds ? `${totalMinutes}m ${restSeconds}s` : `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const restMinutes = totalMinutes - hours * 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/**
 * The two filled segments of a coverage meter, as percentages.
 * `attempted` includes the solved ones, so the "tried but not solved" band is the
 * difference — drawing both from zero would double-count and overstate progress.
 */
export function meterWidths({ solved = 0, attempted = 0, total = 0 } = {}) {
  if (!Number.isFinite(total) || total <= 0) return { solved: 0, tried: 0 };
  const cappedSolved = Math.max(0, Math.min(solved, total));
  const cappedAttempted = Math.max(cappedSolved, Math.min(attempted, total));
  return {
    solved: (cappedSolved / total) * 100,
    tried: ((cappedAttempted - cappedSolved) / total) * 100,
  };
}

/** How a problem's status is named on screen, and what backs the claim. */
export function statusMeta(status) {
  switch (status) {
    case 'accepted':
      return { label: 'Solved', cls: 'dash-accepted', evidence: 'an accepted verdict on record' };
    case 'local-pass':
      return { label: 'Passed locally', cls: 'dash-local', evidence: 'example tests passed here; never submitted' };
    case 'attempted':
      return { label: 'Attempted', cls: 'dash-attempted', evidence: 'practice recorded, no solve yet' };
    case 'notes-only':
      return { label: 'Notes only', cls: 'dash-notes', evidence: 'notes saved, no practice or verdict yet' };
    default:
      return { label: 'Empty', cls: 'dash-empty', evidence: 'a folder with nothing recorded in it' };
  }
}

/** A calendar date said plainly, relative to today where that is clearer. */
export function fmtDay(iso, today = new Date()) {
  if (typeof iso !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) return null;
  const [, y, m, d] = match;
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const key = `${y}-${m}-${d}`;
  if (key === todayKey) return 'Today';
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const yesterdayKey = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
  if (key === yesterdayKey) return 'Yesterday';
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[Number(m) - 1]} ${Number(d)}`;
}

/** Event types said in English, so the activity list is readable by a human. */
export function eventLabel(type) {
  const map = {
    problem_opened: 'opened',
    first_keystroke: 'started typing',
    ran_locally: 'ran the tests',
    run_result: 'test result',
    revealed_solution: 'revealed the solution',
    revealed_article: 'opened the article',
    asked_coach: 'asked the coach',
    recorded_audio: 'recorded audio',
    submitted: 'submitted',
    verdict: 'verdict',
  };
  return map[type] ?? String(type).replaceAll('_', ' ');
}

/**
 * The one sentence at the top that says what the whole screen is standing on.
 * It exists because "1 / 250 solved" and "we have almost no data" are both true, and
 * showing the first without the second would be a misleading screen.
 */
export function evidenceSummary(stats) {
  const { workspace, totals } = stats;
  if (!workspace.exists) return 'no practice saved yet';
  const bits = [];
  bits.push(`${workspace.problemDirs} problem${workspace.problemDirs === 1 ? '' : 's'}`);
  bits.push(`${workspace.eventsRead} practice action${workspace.eventsRead === 1 ? '' : 's'}`);
  bits.push(`${totals.attemptFiles} saved run${totals.attemptFiles === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/** Thin enough that the screen must lead with a caveat rather than a headline. */
export function isThinEvidence(stats) {
  return stats.workspace.eventsRead < 20 || stats.totals.attempted < 5;
}

/* ============================================================ small builders */

function card(title, { note = null, body = null } = {}) {
  return el('section', { class: 'dash-sec' }, [
    el('header', {}, [el('h2', { text: title }), note ? el('span', { class: 'note', text: note }) : null]),
    body,
  ]);
}

function meter({ solved, attempted, total }) {
  const widths = meterWidths({ solved, attempted, total });
  return el('div', {
    class: 'dash-meter',
    role: 'img',
    'aria-label': `${solved} solved and ${Math.max(0, attempted - solved)} in progress of ${total}`,
  }, [
    widths.solved > 0 ? el('i', { class: 'solved', style: `width:${widths.solved}%` }) : null,
    widths.tried > 0 ? el('i', { class: 'tried', style: `width:${widths.tried}%` }) : null,
  ]);
}

const meterKey = () => el('div', { class: 'dash-meterkey' }, [
  el('span', {}, [el('i', { class: 'solved' }), 'Solved']),
  el('span', {}, [el('i', { class: 'tried' }), 'In progress']),
  el('span', {}, [el('i', { class: 'rest' }), 'Not started']),
]);

/* ============================================================ sections */

function headSection(stats, { onRefresh, busy }) {
  return screenHeader({ title: 'Progress', meta: [evidenceSummary(stats)], actions: { secondary: [
    { label: busy ? 'Reading…' : 'Re-read workspace', disabled: busy, onClick: onRefresh, className: 'dash-refresh' },
  ] }, status: leetcodeViews('progress') });
}

/** The whole curriculum as one bar, and the three counts it is made of. */
function overallSection(stats) {
  const all = stats.lists.neetcode250;
  const solved = Math.max(0, Math.min(all.accepted, all.total));
  const started = Math.max(solved, Math.min(all.attempted, all.total));
  const count = (value, label) => el('span', {}, [el('b', { text: String(value) }), ` ${label}`]);
  return el('section', { class: 'dash-overall' }, [
    meter({ solved: all.accepted, attempted: all.attempted, total: all.total }),
    el('div', { class: 'dash-counts' }, [
      count(solved, 'solved'), count(started - solved, 'in progress'), count(all.total - started, 'not started'),
    ]),
  ]);
}

function listsSection(stats) {
  const rows = [
    ['Blind 75', stats.lists.blind75],
    ['NeetCode 150', stats.lists.neetcode150],
    ['NeetCode 250', stats.lists.neetcode250],
  ];
  return card('Lists', {
    body: el('div', { class: 'dash-lists' }, rows.map(([name, data]) => el('div', { class: 'dash-listrow' }, [
      el('div', { class: 'top' }, [
        el('span', { class: 'name', text: name }),
        el('span', { class: 'count', text: `${data.accepted} / ${data.total}` }),
      ]),
      meter({ solved: data.accepted, attempted: data.attempted, total: data.total }),
    ]))),
  });
}

/** The pattern of the problem touched most recently, if it is one of the curriculum's. */
function workingOn(stats) {
  let latest = null;
  for (const problem of stats.problems || []) {
    if (problem.lastAt && problem.pattern && (!latest || String(problem.lastAt) > String(latest.lastAt))) latest = problem;
  }
  const pattern = latest && stats.patterns.find((p) => p.name === latest.pattern);
  return pattern && pattern.accepted < pattern.total ? pattern.name : null;
}

function patternsSection(stats) {
  if (!stats.patterns.length) {
    return card('Patterns', { body: el('p', { class: 'dash-quiet', text: 'The problem catalog is not loaded.' }) });
  }

  const withWork = stats.patterns.filter((p) => p.attempted > 0 || p.accepted > 0).length;
  const current = workingOn(stats);
  const next = stats.patterns.find((p) => p.attempted === 0 && p.accepted === 0)?.name;
  const list = el('ul', { class: 'dash-patterns' }, stats.patterns.map((pattern, index) => {
    const solved = Math.max(0, Math.min(pattern.accepted, pattern.total));
    const started = Math.max(solved, Math.min(pattern.attempted, pattern.total));
    const cells = [];
    for (let i = 0; i < pattern.total; i += 1) cells.push(el('i', { class: i < solved ? 'solved' : i < started ? 'tried' : null }));
    const tag = pattern.name === current ? 'Working on' : pattern.name === next ? 'Next up' : '';
    return el('li', { class: started === 0 ? 'dash-prow zero' : 'dash-prow' }, [
      el('span', { class: 'pidx', text: String(index + 1).padStart(2, '0') }),
      el('span', { class: 'pname', text: pattern.name }),
      el('span', { class: 'pcells', role: 'img', 'aria-label': `${solved} solved and ${started - solved} in progress of ${pattern.total}` }, cells),
      el('span', { class: 'pcount', text: `${solved} / ${pattern.total}` }),
      el('span', { class: tag === 'Working on' ? 'ptag now' : 'ptag', text: tag }),
    ]);
  }));

  return card('Patterns', {
    note: `${withWork} of ${stats.patterns.length} started`,
    body: el('div', {}, [list, meterKey()]),
  });
}

function habitRow(label, signal, value) {
  const short = Math.max(1, signal.minSamples - signal.samples);
  return el('div', { class: 'dash-habit' }, [
    el('span', { text: label }),
    signal.meaningful ? el('b', { text: value() }) : el('span', { class: 'need', text: `Needs ${short} more` }),
  ]);
}

function signalsSection(stats) {
  const { thinkingTime, reveals, attemptsPerSolved } = stats.signals;
  const byPattern = thinkingTime.meaningful ? thinkingTime.byPattern.filter((row) => row.medianMs !== null) : [];
  return card('Habits', {
    body: el('div', { class: 'dash-habits' }, [
      habitRow(thinkingTime.label, thinkingTime, () => `${fmtDurationMs(thinkingTime.medianMs)} median`),
      ...byPattern.map((row) => el('div', { class: 'dash-habit sub' }, [
        el('span', { text: row.pattern }), el('span', { text: fmtDurationMs(row.medianMs) }),
      ])),
      habitRow(reveals.label, reveals, () => `${reveals.revealedBeforeSolve} of ${reveals.samples}`),
      habitRow(attemptsPerSolved.label, attemptsPerSolved, () => `${attemptsPerSolved.median} median · ${attemptsPerSolved.mean.toFixed(1)} mean`),
    ]),
  });
}

function activitySection(stats) {
  if (!stats.activity.length) {
    return card('Last 14 days', { body: el('p', { class: 'dash-quiet', text: 'No dated activity yet.' }) });
  }

  // Fourteen days ending on the most recent recorded day — a window anchored to the data,
  // not to today, so a gap since the last session is visible rather than hidden.
  const last = stats.activity[stats.activity.length - 1].date;
  const byDate = new Map(stats.activity.map((d) => [d.date, d]));
  const end = new Date(`${last}T00:00:00`);
  const days = [];
  for (let i = 13; i >= 0; i -= 1) {
    const day = new Date(end.getFullYear(), end.getMonth(), end.getDate() - i);
    const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const hit = byDate.get(key);
    // A day on record is drawn even when it carries no counted actions or runs.
    days.push({ day, on: Boolean(hit), total: hit ? hit.events + hit.attempts : 0 });
  }
  const peak = Math.max(...days.map((d) => d.total));
  const active = days.filter((d) => d.on).length;
  const short = (date) => date.toLocaleDateString([], { month: 'short', day: 'numeric' });

  return card('Last 14 days', {
    note: `${stats.activity.length} active day${stats.activity.length === 1 ? '' : 's'} in all`,
    body: el('div', {}, [
      el('div', { class: 'dash-days', role: 'img', 'aria-label': `Active on ${active} of the 14 days up to ${short(end)}` },
        days.map((d) => el('i', d.on ? { class: 'on', style: `height:${Math.max(12, peak ? Math.round((d.total / peak) * 100) : 0)}%` } : {}))),
      el('div', { class: 'dash-dayends' }, [el('span', { text: short(days[0].day) }), el('span', { text: short(end) })]),
    ]),
  });
}

function recentSection(stats, now) {
  if (!stats.recent.length) {
    return card('Recent', {
      body: el('div', { class: 'dash-quiet' },
        stats.workspace.eventsRead === 0
          ? 'No activity yet. Open a problem, type, run tests, or ask the coach to get started.'
          : 'The practice actions carry no readable timestamps, so none of them can be placed on a timeline.'),
    });
  }

  return card('Recent', {
    note: `${stats.recent.length} shown`,
    body: el('ul', { class: 'dash-recent' }, stats.recent.map((event) => el('li', {}, [
      el('span', { class: 'when', text: `${fmtDay(event.at, now) ?? ''} ${String(event.at).slice(11, 16)}`.trim() }),
      el('span', { class: 'what' }, [
        el('b', { text: event.title ?? event.slug }),
        ' — ',
        el('span', { class: 'ev', text: eventLabel(event.type) }),
        event.summary ? el('span', { class: 'sm', text: event.summary }) : null,
      ]),
    ]))),
  });
}

function problemsSection(stats, now) {
  if (!stats.problems.length) {
    return card('Saved problems', {
      body: el('div', { class: 'dash-quiet' }, 'No problems saved yet.'),
    });
  }

  const rows = stats.problems.map((problem) => {
    const meta = statusMeta(problem.status);
    return el('tr', {}, [
      el('td', {}, [
        el('span', { class: 'name', text: problem.title ?? problem.slug }),
        problem.inCatalog ? null : el('span', { class: 'tag quiet', style: 'margin-left:8px', text: 'off-list' }),
      ]),
      el('td', {}, el('span', { class: 'mono dim', style: 'letter-spacing:.06em', text: problem.pattern ?? '—' })),
      el('td', {}, el('span', { class: `tag ${meta.cls}`, text: meta.label })),
      el('td', {}, el('span', { class: problem.attempts ? 'num' : 'num zero', text: String(problem.attempts) })),
      el('td', {}, el('span', { class: problem.events ? 'num' : 'num zero', text: String(problem.events) })),
      el('td', {}, el('span', { class: 'num', text: problem.lastAt ? (fmtDay(problem.lastAt, now) ?? '—') : '—' })),
      el('td', {}, el('span', { class: 'evid', text: problem.acceptedSource ? `verdict from ${problem.acceptedSource}` : meta.evidence })),
    ]);
  });

  return card('Saved problems', {
    note: `${stats.problems.length} problem${stats.problems.length === 1 ? '' : 's'}`,
    body: el('div', { class: 'dash-tablewrap' }, el('table', { class: 'dash-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Problem' }), el('th', { text: 'Pattern' }), el('th', { text: 'Status' }),
        el('th', { text: 'Saved runs' }), el('th', { text: 'Activity' }), el('th', { text: 'Last' }),
        el('th', { text: 'What backs it' }),
      ])),
      el('tbody', {}, rows),
    ])),
  });
}

function warningsSection(stats) {
  if (!stats.warnings.length) return null;
  return el('section', { class: 'dash-sec' }, el('div', { class: 'dash-warn' }, [
    el('b', { text: 'Read with caveats' }),
    el('ul', {}, stats.warnings.map((warning) => el('li', { text: warning.includes('NeetCode 250')
      ? warning.replace(/problem folder/g, 'saved problem').replace(/ on disk/g, '')
      : 'Some saved practice could not be read and is excluded from these figures.' }))),
  ]));
}

/* ============================================================ honest states */

function noWorkspaceState() {
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: 'Nothing is recorded yet.' }),
    el('p', { text: 'This page fills in as you practice: coverage by pattern and list, time to start typing, solution reveals, and attempts per solve.' }),
  ]));
}

function nothingRecordedState(stats) {
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: 'No practice recorded yet' }),
    el('p', { text: `${stats.workspace.problemDirs} problems saved, with no practice actions, saved runs, or accepted verdicts yet.` }),
  ]));
}

function serverState({ kind, message, onRefresh }) {
  const heading = kind === 'unavailable'
    ? 'Progress is unavailable'
    : kind === 'mock'
      ? 'Preview mode'
      : 'Saved progress could not be loaded';
  const body = kind === 'mock'
    ? 'Your progress is unavailable in this preview. Open Studio to see your saved practice.'
    : message;
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: heading }),
    el('p', { text: body }),
    el('p', { class: 'dash-quiet', style: 'padding:0;font-style:italic' },
      'Your progress will appear once it can be loaded.'),
    el('div', { style: 'margin-top:13px' },
      el('button', { class: 'btn btn--quiet dash-refresh', type: 'button', text: 'Try again', onclick: onRefresh })),
  ]));
}

/* ============================================================ data fetch */

async function fetchStats() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STATS_TIMEOUT_MS);
  try {
    const response = await fetch('/api/stats', {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      const missingRoute = response.status === 404 || response.status === 405 || response.status === 501;
      return {
        ok: false,
        kind: missingRoute ? 'unavailable' : 'server',
        message: missingRoute
          ? 'The studio server answered, but it does not serve /api/stats. It is running an older build than this page.'
          : (data?.error?.message || `The server answered ${response.status}.`),
      };
    }
    if (!data) return { ok: false, kind: 'server', message: 'The server sent a response that was not valid JSON.' };
    return { ok: true, stats: data };
  } catch (error) {
    const timedOut = error && error.name === 'AbortError';
    return {
      ok: false,
      kind: timedOut ? 'timeout' : 'offline',
      message: timedOut
        ? `The server took longer than ${Math.round(STATS_TIMEOUT_MS / 1000)}s to read the workspace.`
        : 'The studio server is not answering, so the workspace could not be read.',
    };
  } finally {
    clearTimeout(timer);
  }
}

function ensureStylesheet() {
  const already = [...document.querySelectorAll('link[rel="stylesheet"]')]
    .some((link) => link.getAttribute('href') === STYLESHEET);
  if (already) return;
  document.head.append(el('link', { rel: 'stylesheet', href: STYLESHEET }));
}

/* ============================================================ render */

function renderInto(mountEl, stats, { onRefresh, busy, now }) {
  const nothingAtAll =
    stats.workspace.exists &&
    stats.workspace.eventsRead === 0 &&
    stats.totals.attemptFiles === 0 &&
    stats.totals.accepted === 0;

  const hasRecord = stats.workspace.exists;
  const view = el('div', { class: 'dash view' }, [
    headSection(stats, { onRefresh, busy }),
    el('div', { class: 'dash-body' }, [
      !hasRecord ? noWorkspaceState() : null,
      nothingAtAll ? nothingRecordedState(stats) : null,
      overallSection(stats),
      // Patterns are the page: what is done, what is under way, what comes next.
      el('div', { class: 'dash-layout' }, [
        el('div', { class: 'dash-main' }, [patternsSection(stats), hasRecord ? recentSection(stats, now) : null]),
        el('aside', { class: 'dash-side' }, [
          listsSection(stats),
          hasRecord ? activitySection(stats) : null,
          hasRecord ? signalsSection(stats) : null,
        ]),
      ]),
      hasRecord ? problemsSection(stats, now) : null,
      warningsSection(stats),
      el('div', { class: 'dash-foot' }, [
        `${stats.workspace.eventsRead} practice actions recorded`,
        stats.workspace.skippedLines ? ' · Some saved activity could not be read' : '',
      ]),
    ]),
  ]);

  replace(mountEl, view);
}

function renderLoading(mountEl) {
  replace(mountEl, el('div', { class: 'dash view' }, [
    screenHeader({ title: 'Progress', meta: ['Loading your progress…'] , status: leetcodeViews('progress') }),
    el('section', { class: 'dash-card' }, el('div', { class: 'dash-pad' },
      el('div', { class: 'skel' }, [el('i'), el('i', { style: 'width:70%' }), el('i', { style: 'width:45%' })]))),
  ]));
}

/**
 * Mount the dashboard.
 *
 * @param {HTMLElement} mountEl  where the view is drawn — the app's main element
 * @param {{mode?: string}} [api]  the shared api module, consulted only for `mode`;
 *                                 in mock mode this screen refuses to show figures
 * @returns {{refresh: () => Promise<void>, destroy: () => void}}
 */
export function init(mountEl, api = {}) {
  ensureStylesheet();

  let alive = true;
  let busy = false;

  async function load() {
    if (!alive) return;
    // A page served without the studio server has no workspace to read. Inventing a
    // demo dashboard here would be the exact dishonesty this screen exists to avoid.
    if (api && api.mode === 'mock') {
      replace(mountEl, el('div', { class: 'dash view' }, [
        screenHeader({ title: 'Progress', meta: ['Your practice record lives on this machine, and it is not reachable right now.'] , status: leetcodeViews('progress') }),
        serverState({ kind: 'mock', onRefresh: () => location.reload() }),
      ]));
      return;
    }

    busy = true;
    renderLoading(mountEl);
    const result = await fetchStats();
    busy = false;
    if (!alive) return;

    if (!result.ok) {
      replace(mountEl, el('div', { class: 'dash view' }, [
        screenHeader({ title: 'Progress', meta: ['The practice record could not be read.'] , status: leetcodeViews('progress') }),
        serverState({ kind: result.kind, message: result.message, onRefresh: load }),
      ]));
      return;
    }

    renderInto(mountEl, result.stats, { onRefresh: load, busy, now: new Date() });
  }

  if (new URLSearchParams(location.search).get('dashtest') === '1') {
    replace(mountEl, renderSelfTests());
  } else {
    load();
  }

  return {
    refresh: load,
    destroy() { alive = false; },
  };
}

export default init;

/* ============================================================ self-tests
   The shapeable logic on this screen is the small pure layer above; it is worth
   a check that runs in the same browser that ships it. `?dashtest=1` renders the
   results instead of the dashboard. This file owns its own tests — web/js/tests.js
   belongs to another agent and is not touched. */

export function runSelfTests() {
  const results = [];
  const check = (name, fn) => {
    try {
      const detail = fn();
      results.push({ name, pass: true, detail: detail ?? '' });
    } catch (error) {
      results.push({ name, pass: false, detail: error?.message ?? String(error) });
    }
  };
  const eq = (actual, expected, label = '') => {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label}expected ${b}, got ${a}`);
  };

  check('pctOf refuses to divide by a missing denominator', () => {
    eq(pctOf(1, 250), 0.4);
    eq(pctOf(0, 250), 0);
    eq(pctOf(1, 0), null);
    eq(pctOf(1, undefined), null);
  });

  check('fmtDurationMs never rounds a real duration down to nothing', () => {
    eq(fmtDurationMs(0), '0ms');
    eq(fmtDurationMs(430), '430ms');
    eq(fmtDurationMs(1500), '1.5s');
    eq(fmtDurationMs(12000), '12s');
    eq(fmtDurationMs(100000), '1m 40s');
    eq(fmtDurationMs(120000), '2m');
    eq(fmtDurationMs(7500000), '2h 5m');
    eq(fmtDurationMs(null), null);
    eq(fmtDurationMs(-5), null);
  });

  check('meterWidths never double-counts solved inside attempted', () => {
    eq(meterWidths({ solved: 1, attempted: 2, total: 250 }), { solved: 0.4, tried: 0.4 });
    eq(meterWidths({ solved: 0, attempted: 0, total: 75 }), { solved: 0, tried: 0 });
    // attempted below solved is incoherent input; it must clamp, not go negative.
    eq(meterWidths({ solved: 3, attempted: 1, total: 10 }), { solved: 30, tried: 0 });
    eq(meterWidths({ solved: 5, attempted: 5, total: 0 }), { solved: 0, tried: 0 });
  });

  check('statusMeta keeps "passed locally" separate from "solved"', () => {
    eq(statusMeta('accepted').label, 'Solved');
    eq(statusMeta('local-pass').label, 'Passed locally');
    eq(statusMeta('notes-only').label, 'Notes only');
    eq(statusMeta('anything-else').label, 'Empty');
  });

  check('fmtDay names today and yesterday, and formats the rest', () => {
    const today = new Date(2026, 6, 25);
    eq(fmtDay('2026-07-25T10:00:00.000-04:00', today), 'Today');
    eq(fmtDay('2026-07-24', today), 'Yesterday');
    eq(fmtDay('2026-07-04', today), 'Jul 4');
    eq(fmtDay('not a date', today), null);
    eq(fmtDay(null, today), null);
  });

  check('eventLabel keeps unknown activity readable', () => {
    eq(eventLabel('revealed_solution'), 'revealed the solution');
    eq(eventLabel('something_new'), 'something new');
  });

  check('evidenceSummary reports absence as absence', () => {
    eq(evidenceSummary({ workspace: { exists: false }, totals: {} }), 'no practice saved yet');
    eq(
      evidenceSummary({ workspace: { exists: true, problemDirs: 1, eventsRead: 1 }, totals: { attemptFiles: 9 } }),
      '1 problem · 1 practice action · 9 saved runs',
    );
  });

  check('isThinEvidence is true for the workspace as it stands today', () => {
    eq(isThinEvidence({ workspace: { eventsRead: 1 }, totals: { attempted: 2 } }), true);
    eq(isThinEvidence({ workspace: { eventsRead: 200 }, totals: { attempted: 40 } }), false);
  });

  return results;
}

function renderSelfTests() {
  const results = runSelfTests();
  const failed = results.filter((r) => !r.pass).length;
  return el('div', { class: 'dash view' }, [
    screenHeader({ title: 'Dashboard self-tests', meta: [`${results.length - failed} passed, ${failed} failed.`] }),
    el('section', { class: 'dash-card' }, el('div', { class: 'dash-selftest' }, results.map((r) => el('div', {
      class: r.pass ? 'ok' : 'bad',
      text: `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`,
    })))),
  ]);
}
