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
      return { label: 'Attempted', cls: 'dash-attempted', evidence: 'code run or events logged, no solve recorded' };
    case 'notes-only':
      return { label: 'Notes only', cls: 'dash-notes', evidence: 'prose on disk, no events and no verdict' };
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
  return map[type] ?? type;
}

/**
 * The one sentence at the top that says what the whole screen is standing on.
 * It exists because "1 / 250 solved" and "we have almost no data" are both true, and
 * showing the first without the second would be a misleading screen.
 */
export function evidenceSummary(stats) {
  const { workspace, totals } = stats;
  if (!workspace.exists) return 'no workspace on disk yet';
  const bits = [];
  bits.push(`${workspace.problemDirs} problem folder${workspace.problemDirs === 1 ? '' : 's'}`);
  bits.push(`${workspace.eventsRead} logged event${workspace.eventsRead === 1 ? '' : 's'}`);
  bits.push(`${totals.attemptFiles} code snapshot${totals.attemptFiles === 1 ? '' : 's'}`);
  return bits.join(' · ');
}

/** Thin enough that the screen must lead with a caveat rather than a headline. */
export function isThinEvidence(stats) {
  return stats.workspace.eventsRead < 20 || stats.totals.attempted < 5;
}

/* ============================================================ small builders */

function srcChip(text) {
  return el('span', { class: 'dash-src', title: `Source: ${text}`, text: 'src' });
}

function card(title, { note = null, source = null, body = null, headerExtra = null } = {}) {
  const head = el('header', {}, [
    el('div', { class: 'hgroup' }, [
      el('h2', { text: title }),
      source ? srcChip(source) : null,
      note ? el('span', { class: 'note', text: note }) : null,
    ]),
    headerExtra,
  ]);
  return el('section', { class: 'dash-card' }, [head, body]);
}

function meter({ solved, attempted, total }) {
  const widths = meterWidths({ solved, attempted, total });
  return el('div', {
    class: 'dash-meter',
    role: 'img',
    'aria-label': `${solved} solved and ${Math.max(0, attempted - solved)} attempted of ${total}`,
  }, [
    widths.solved > 0 ? el('i', { class: 'solved', style: `width:${widths.solved}%` }) : null,
    widths.tried > 0 ? el('i', { class: 'tried', style: `width:${widths.tried}%` }) : null,
  ]);
}

function statCell({ value, suffix = null, label, source, dim = false }) {
  return el('div', { class: 'dash-stat', role: 'listitem' }, [
    el('div', { class: dim ? 'v none' : 'v' }, [
      String(value),
      suffix ? el('small', { text: ` ${suffix}` }) : null,
    ]),
    el('div', { class: 'mono l' }, [label, srcChip(source)]),
  ]);
}

/**
 * The block that stands in for a statistic there is not enough evidence for.
 * It states the shortfall as a fraction, shows it as a bar, and says what produces the
 * missing samples — so it is actionable rather than merely apologetic.
 */
function needMore({ have, need, what, how }) {
  const filled = need > 0 ? Math.min(100, (have / need) * 100) : 0;
  return el('div', { class: 'dash-need' }, [
    el('div', { class: 'nhead' }, [
      `${have} of ${need} needed`,
      el('span', { class: 'nbar' }, el('i', { style: `width:${filled}%` })),
    ]),
    el('p', { text: what }),
    how ? el('p', { class: 'how', text: how }) : null,
  ]);
}

/* ============================================================ sections */

function headSection(stats, { onRefresh, busy }) {
  return el('div', { class: 'dash-head' }, [
    el('div', {}, [
      el('h1', { text: 'Progress' }),
      el('div', { class: 'sub' }, [
        'Everything here is read from ',
        el('b', { text: '~/LeetCodeTutor' }),
        `. Nothing is estimated. Right now that is ${evidenceSummary(stats)}.`,
      ]),
    ]),
    el('button', {
      class: 'dash-refresh', type: 'button', disabled: busy,
      text: busy ? 'Reading…' : 'Re-read workspace',
      onclick: onRefresh,
    }),
  ]);
}

function truthSection(stats) {
  const { workspace, totals, signals } = stats;
  const missing = [];
  if (signals.thinkingTime.samples === 0) {
    missing.push('how long you think before typing — no first_keystroke events are recorded yet');
  }
  if (totals.revealedSolution === 0) {
    missing.push('how often you reveal a solution before solving — no reveals are recorded yet');
  }
  if (signals.attemptsPerSolved.samples < signals.attemptsPerSolved.minSamples) {
    missing.push(`attempts per solved problem — that needs ${signals.attemptsPerSolved.minSamples} solved problems with saved code, you have ${signals.attemptsPerSolved.samples}`);
  }

  return el('div', { class: 'dash-truth' }, [
    el('h2', { text: 'What this screen can honestly tell you today' }),
    el('p', {}, [
      'The curriculum numbers below are exact: ',
      el('b', { text: `${stats.curriculum.problems} problems across ${stats.curriculum.patterns} patterns` }),
      ' is real data, so every "n of N" denominator is real. What is thin is your side of it — ',
      el('b', { text: `${workspace.eventsRead} event${workspace.eventsRead === 1 ? '' : 's'}` }),
      ` recorded across ${workspace.problemDirs} problem folder${workspace.problemDirs === 1 ? '' : 's'}.`,
    ]),
    missing.length
      ? el('div', {}, [
        el('p', { text: 'That is not enough for the weakness view yet. Specifically, these cannot be computed:' }),
        el('ul', {}, missing.map((text) => el('li', { text }))),
        el('p', { text: 'They fill in on their own as you solve inside Studio — the session log is written as you work, not something you maintain.' }),
      ])
      : null,
  ]);
}

function statsSection(stats) {
  const { totals, lists, workspace, activity } = stats;
  return el('div', { class: 'dash-stats', role: 'list' }, [
    statCell({
      value: totals.accepted,
      suffix: `/ ${lists.neetcode250.total}`,
      label: 'Solved',
      dim: totals.accepted === 0,
      source: 'an accepted verdict in a session log or meta.json',
    }),
    statCell({
      value: totals.attempted,
      label: 'Touched',
      dim: totals.attempted === 0,
      source: 'problem folders with events or saved code',
    }),
    statCell({
      value: totals.attemptFiles,
      label: totals.attemptFiles === 1 ? 'Code snapshot' : 'Code snapshots',
      dim: totals.attemptFiles === 0,
      source: 'attempts/*.py — one file per run',
    }),
    statCell({
      value: activity.length,
      label: activity.length === 1 ? 'Day active' : 'Days active',
      dim: activity.length === 0,
      source: 'distinct dates across events and snapshots',
    }),
    statCell({
      value: workspace.eventsRead,
      label: workspace.eventsRead === 1 ? 'Event logged' : 'Events logged',
      dim: workspace.eventsRead === 0,
      source: 'sessions/*.jsonl lines that parsed',
    }),
  ]);
}

function listsSection(stats) {
  const rows = [
    ['Blind 75', stats.lists.blind75],
    ['NeetCode 150', stats.lists.neetcode150],
    ['NeetCode 250', stats.lists.neetcode250],
  ];
  const body = el('div', { class: 'dash-lists' }, rows.map(([name, data]) => {
    const percent = pctOf(data.accepted, data.total);
    // A percentage under 1 is written as "under 1%" rather than "0%" — rounding a real
    // solve down to zero would erase it.
    const percentText = percent === null
      ? null
      : percent === 0 ? '0%'
        : percent < 1 ? 'under 1%'
          : `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
    return el('div', { class: 'dash-listrow' }, [
      el('div', { class: 'top' }, [
        el('span', { class: 'name', text: name }),
        el('span', { class: 'count' }, [
          el('b', { text: String(data.accepted) }),
          ` / ${data.total} solved`,
          percentText ? el('span', { style: 'color:var(--ink-35)', text: ` (${percentText})` }) : null,
          data.attempted > data.accepted ? ` · ${data.attempted - data.accepted} touched` : '',
        ]),
      ]),
      meter({ solved: data.accepted, attempted: data.attempted, total: data.total }),
    ]);
  }));

  return card('List progress', {
    source: 'data/catalog.json for the totals, your workspace for the solves',
    body: el('div', {}, [
      body,
      el('div', { class: 'dash-listrow', style: 'border-top:1px solid var(--hair-10)' },
        el('div', { class: 'dash-meterkey mono dim', style: 'margin-top:0' }, [
          el('span', {}, [el('i', { class: 'solved' }), 'Solved']),
          el('span', {}, [el('i', { class: 'tried' }), 'Touched, not solved']),
          el('span', {}, [el('i', { class: 'rest' }), 'Not started']),
        ])),
    ]),
  });
}

function patternsSection(stats) {
  if (!stats.patterns.length) {
    return card('Coverage by pattern', {
      body: el('div', { class: 'dash-quiet' }, 'The problem catalog is not loaded, so there are no patterns to measure against.'),
    });
  }

  const withWork = stats.patterns.filter((p) => p.attempted > 0).length;
  const list = el('ul', { class: 'dash-patterns' }, stats.patterns.map((pattern, index) => {
    const zero = pattern.attempted === 0 && pattern.accepted === 0;
    return el('li', {}, el('div', {
      class: zero ? 'dash-prow zero' : 'dash-prow',
      title: `${pattern.name}: ${pattern.accepted} solved, ${pattern.attempted} touched, ${pattern.total} in the NeetCode 250`,
    }, [
      el('span', { class: 'pidx', text: String(index + 1).padStart(2, '0') }),
      el('span', { class: 'pname', text: pattern.name }),
      meter({ solved: pattern.accepted, attempted: pattern.attempted, total: pattern.total }),
      el('span', { class: 'pcount' }, [el('b', { text: String(pattern.accepted) }), ` / ${pattern.total}`]),
    ]));
  }));

  return card('Coverage by pattern', {
    note: `${withWork} of ${stats.patterns.length} started`,
    source: 'NeetCode 250 pattern assignments + your workspace',
    body: el('div', {}, [
      el('div', { class: 'dash-quiet', style: 'font-style:normal;padding-bottom:10px' },
        'The 18 patterns are the curriculum spine. A pattern at 0 is a pattern you have not started — that is a real fact about coverage, not missing data.'),
      list,
    ]),
  });
}

function signalsSection(stats) {
  const { signals } = stats;

  const thinking = el('div', { class: 'dash-signal' }, [
    el('div', { class: 'shead' }, [
      el('span', { class: 'sname', text: signals.thinkingTime.label }),
      srcChip('problem_opened → first_keystroke in sessions/*.jsonl'),
    ]),
    el('div', { class: 'swhat', text: signals.thinkingTime.what }),
    signals.thinkingTime.meaningful
      ? el('div', {}, [
        el('div', { class: 'sval', text: `median ${fmtDurationMs(signals.thinkingTime.medianMs)}` }),
        signals.thinkingTime.byPattern.length
          ? el('ul', { class: 'dash-patterns', style: 'margin-top:8px' },
            signals.thinkingTime.byPattern.map((row) => el('li', {}, el('div', { class: 'dash-prow', style: 'padding-left:0;padding-right:0' }, [
              el('span', { class: 'pidx', text: '' }),
              el('span', { class: 'pname', text: row.pattern }),
              el('span', { class: 'pcount', text: `${row.samples} sample${row.samples === 1 ? '' : 's'}` }),
              el('span', { class: 'pcount' }, row.medianMs === null
                ? el('span', { class: 'mono dim', text: 'too few' })
                : el('b', { text: fmtDurationMs(row.medianMs) })),
            ]))))
          : null,
      ])
      : needMore({
        have: signals.thinkingTime.samples,
        need: signals.thinkingTime.minSamples,
        what: signals.thinkingTime.samples === 0
          ? 'No first_keystroke event has been written yet, so there is nothing to measure. This is the signal that will eventually answer questions like "do graph problems take me longer to start than array problems" — with a number rather than a hunch.'
          : `${signals.thinkingTime.samples} measurement so far. One reading is not a habit, so no median is shown.`,
        how: 'A sample is recorded each time you open a problem in Studio and type your first character.',
      }),
  ]);

  const revealed = el('div', { class: 'dash-signal' }, [
    el('div', { class: 'shead' }, [
      el('span', { class: 'sname', text: signals.reveals.label }),
      srcChip('revealed_solution events'),
    ]),
    el('div', { class: 'swhat', text: signals.reveals.what }),
    signals.reveals.meaningful
      ? el('div', { class: 'sval' }, `${signals.reveals.revealedBeforeSolve} of ${signals.reveals.samples} problems`)
      : needMore({
        have: signals.reveals.samples,
        need: signals.reveals.minSamples,
        what: stats.totals.revealedSolution === 0
          ? 'No solution has been revealed on record. That is a real zero, not missing data — but with this few problems it is not yet evidence of anything either way.'
          : `${signals.reveals.revealedBeforeSolve} reveal before a solve, across ${signals.reveals.samples} problem${signals.reveals.samples === 1 ? '' : 's'}. Too few to call it a rate.`,
        how: 'Recorded whenever you open the reference solution for a problem you have not solved yet.',
      }),
  ]);

  const attempts = el('div', { class: 'dash-signal' }, [
    el('div', { class: 'shead' }, [
      el('span', { class: 'sname', text: signals.attemptsPerSolved.label }),
      srcChip('attempts/*.py counted against solved problems'),
    ]),
    el('div', { class: 'swhat', text: signals.attemptsPerSolved.what }),
    signals.attemptsPerSolved.meaningful
      ? el('div', { class: 'sval', text: `${signals.attemptsPerSolved.median} median · ${signals.attemptsPerSolved.mean.toFixed(1)} mean` })
      : needMore({
        have: signals.attemptsPerSolved.samples,
        need: signals.attemptsPerSolved.minSamples,
        // Stated from the two counts on disk, so this sentence is true of whatever
        // workspace is being read rather than of the one it was written against.
        what: signals.attemptsPerSolved.samples === 0
          ? `No problem has both a recorded solve and saved code: ${stats.totals.accepted} problem${stats.totals.accepted === 1 ? '' : 's'} with an accepted verdict, ${stats.workspace.withAttempts} with attempt snapshots, and no overlap between them.`
          : `${signals.attemptsPerSolved.samples} solved problem with saved attempts. An average of one number is that number.`,
        how: 'Every run writes a snapshot to attempts/, so this fills in as you solve problems inside Studio.',
      }),
  ]);

  return card('Weakness view', {
    note: 'the reason this screen exists',
    body: el('div', {}, [thinking, revealed, attempts]),
  });
}

function activitySection(stats) {
  if (!stats.activity.length) {
    return card('Activity', {
      body: el('div', { class: 'dash-quiet' }, 'No dated activity on record yet. Days appear here as soon as anything is logged or any code is run.'),
    });
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
    const total = hit ? hit.events + hit.attempts : 0;
    days.push({ key, total, hit });
  }

  return card('Last 14 recorded days', {
    note: `${stats.activity.length} active day${stats.activity.length === 1 ? '' : 's'} total`,
    source: 'event and snapshot timestamps',
    body: el('div', { class: 'dash-strip' }, [
      el('div', { class: 'dash-days' }, days.map((day) => el('div', {
        class: 'dash-day',
        title: day.hit
          ? `${day.key} · ${day.hit.events} event${day.hit.events === 1 ? '' : 's'}, ${day.hit.attempts} snapshot${day.hit.attempts === 1 ? '' : 's'}, ${day.hit.problems} problem${day.hit.problems === 1 ? '' : 's'}`
          : `${day.key} · nothing recorded`,
      }, [
        el('div', { class: `box${day.total >= 3 ? ' f2' : day.total >= 1 ? ' f1' : ''}` }),
        el('div', { class: 'd', text: day.key.slice(8) }),
      ]))),
      el('div', { class: 'dash-legend' }, [
        el('span', { class: 'mono dim' }, [el('span', { class: 'sw' }), 'none']),
        el('span', { class: 'mono dim' }, [el('span', { class: 'sw', style: 'background:rgba(0,0,0,.22)' }), '1–2']),
        el('span', { class: 'mono dim' }, [el('span', { class: 'sw', style: 'background:var(--ink)' }), '3+']),
      ]),
    ]),
  });
}

function recentSection(stats, now) {
  if (!stats.recent.length) {
    return card('Recent activity', {
      body: el('div', { class: 'dash-quiet' },
        stats.workspace.eventsRead === 0
          ? 'No session events have been logged yet. Opening a problem, typing, running the tests and asking the coach each write one line here.'
          : 'The logged events carry no readable timestamps, so none of them can be placed on a timeline.'),
    });
  }

  return card('Recent activity', {
    note: `${stats.recent.length} shown`,
    source: 'sessions/*.jsonl, newest first',
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
    return card('Problems on disk', {
      body: el('div', { class: 'dash-quiet' }, 'There are no problem folders in ~/LeetCodeTutor/problems yet.'),
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
      el('td', {}, el('span', { class: `tag ${meta.cls}`, title: meta.evidence, text: meta.label })),
      el('td', {}, el('span', { class: problem.attempts ? 'num' : 'num zero', text: String(problem.attempts) })),
      el('td', {}, el('span', { class: problem.events ? 'num' : 'num zero', text: String(problem.events) })),
      el('td', {}, el('span', { class: 'num', text: problem.lastAt ? (fmtDay(problem.lastAt, now) ?? '—') : '—' })),
      el('td', {}, el('span', { class: 'evid', text: problem.acceptedSource ? `verdict from ${problem.acceptedSource}` : meta.evidence })),
    ]);
  });

  return card('Problems on disk', {
    note: `${stats.problems.length} folder${stats.problems.length === 1 ? '' : 's'}`,
    source: '~/LeetCodeTutor/problems/',
    body: el('div', { class: 'dash-tablewrap' }, el('table', { class: 'dash-table' }, [
      el('thead', {}, el('tr', {}, [
        el('th', { text: 'Problem' }), el('th', { text: 'Pattern' }), el('th', { text: 'Status' }),
        el('th', { text: 'Snapshots' }), el('th', { text: 'Events' }), el('th', { text: 'Last' }),
        el('th', { text: 'What backs it' }),
      ])),
      el('tbody', {}, rows),
    ])),
  });
}

function warningsSection(stats) {
  if (!stats.warnings.length) return null;
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-warn' }, [
    el('b', { text: 'Read with caveats' }),
    el('ul', {}, stats.warnings.map((warning) => el('li', { text: warning }))),
  ]));
}

/* ============================================================ honest states */

function noWorkspaceState() {
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: 'There is no practice record yet' }),
    el('p', {}, [
      'This screen reads ', el('b', { text: '~/LeetCodeTutor/problems/' }),
      ', and that folder does not exist yet. That is different from having solved nothing — ',
      'there is simply nothing on disk to count.',
    ]),
    el('p', { text: 'It is created the first time you open a problem in Studio. From then on this page fills itself in:' }),
    el('ul', {}, [
      el('li', { text: 'Coverage across all 18 patterns and the Blind 75 / NeetCode 150 / 250 lists.' }),
      el('li', { text: 'How long you read a problem before you start typing, broken down by pattern.' }),
      el('li', { text: 'How often you reveal a solution before solving it.' }),
      el('li', { text: 'How many attempts a solved problem takes you.' }),
    ]),
    el('p', { text: 'None of it is estimated. Every number here will trace back to a file you can open and read.' }),
  ]));
}

function nothingRecordedState(stats) {
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: 'The workspace exists, but nothing is recorded in it yet' }),
    el('p', {}, [
      el('b', { text: '~/LeetCodeTutor' }),
      ` is there and holds ${stats.workspace.problemDirs} problem folder${stats.workspace.problemDirs === 1 ? '' : 's'}, `,
      'but no session events, no saved attempts and no accepted verdicts. So: nothing solved that we can see, and ',
      'nothing to be wrong about.',
    ]),
    el('p', { text: 'The coverage figures below are still exact — they come from the catalog, not from your practice.' }),
  ]));
}

function serverState({ kind, message, onRefresh }) {
  const heading = kind === 'unavailable'
    ? 'This server build has no progress endpoint'
    : kind === 'mock'
      ? 'Running on bundled sample data'
      : 'The workspace could not be read';
  const body = kind === 'mock'
    ? 'Your statistics come only from your own files on disk, and this page is currently served without the studio server. Rather than show made-up numbers, it shows nothing. Start the server and reload.'
    : message;
  return el('section', { class: 'dash-card' }, el('div', { class: 'dash-empty' }, [
    el('h3', { text: heading }),
    el('p', { text: body }),
    el('p', { class: 'dash-quiet', style: 'padding:0;font-style:italic' },
      'No figures are shown rather than approximate ones — an approximate progress number is worse than none.'),
    el('div', { style: 'margin-top:13px' },
      el('button', { class: 'dash-refresh', type: 'button', text: 'Try again', onclick: onRefresh })),
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

  // With no workspace there is nothing to fill a second column with, and a two-column
  // layout with one side blank reads as a page that failed to load rather than as a page
  // that has nothing to report. So that case goes single-column on purpose.
  const body = stats.workspace.exists
    ? [
      statsSection(stats),
      isThinEvidence(stats) && !nothingAtAll ? truthSection(stats) : null,
      // Two columns of roughly equal weight: the weakness view leads the left, and the
      // 18-row pattern table — the tallest thing here — balances it on the right.
      el('div', { class: 'dash-grid' }, [
        el('div', { class: 'dash-col' }, [
          signalsSection(stats),
          activitySection(stats),
          recentSection(stats, now),
        ]),
        el('div', { class: 'dash-col' }, [
          listsSection(stats),
          patternsSection(stats),
        ]),
      ]),
      // Seven columns of evidence want the full width, not half of it.
      problemsSection(stats, now),
    ]
    : [listsSection(stats), patternsSection(stats)];

  const view = el('div', { class: 'dash view' }, [
    headSection(stats, { onRefresh, busy }),

    !stats.workspace.exists ? noWorkspaceState() : null,
    nothingAtAll ? nothingRecordedState(stats) : null,

    ...body,

    warningsSection(stats),

    el('div', { class: 'dash-foot' }, [
      `Read from ${stats.workspace.root} · `,
      `${stats.workspace.sessionsRead} session file${stats.workspace.sessionsRead === 1 ? '' : 's'}, `,
      `${stats.workspace.eventsRead} event${stats.workspace.eventsRead === 1 ? '' : 's'}`,
      stats.workspace.skippedLines
        ? `, ${stats.workspace.skippedLines} unreadable line${stats.workspace.skippedLines === 1 ? '' : 's'} skipped`
        : '',
      ' · no value on this page is estimated',
    ]),
  ]);

  replace(mountEl, view);
}

function renderLoading(mountEl) {
  replace(mountEl, el('div', { class: 'dash view' }, [
    el('div', { class: 'dash-head' }, el('div', {}, [
      el('h1', { text: 'Progress' }),
      el('div', { class: 'sub', text: 'Reading ~/LeetCodeTutor…' }),
    ])),
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
        el('div', { class: 'dash-head' }, el('div', {}, [
          el('h1', { text: 'Progress' }),
          el('div', { class: 'sub', text: 'Your practice record lives on this machine, and it is not reachable right now.' }),
        ])),
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
        el('div', { class: 'dash-head' }, el('div', {}, [
          el('h1', { text: 'Progress' }),
          el('div', { class: 'sub', text: 'The practice record could not be read.' }),
        ])),
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

  check('eventLabel falls back to the raw type rather than hiding it', () => {
    eq(eventLabel('revealed_solution'), 'revealed the solution');
    eq(eventLabel('something_new'), 'something_new');
  });

  check('evidenceSummary reports absence as absence', () => {
    eq(evidenceSummary({ workspace: { exists: false }, totals: {} }), 'no workspace on disk yet');
    eq(
      evidenceSummary({ workspace: { exists: true, problemDirs: 1, eventsRead: 1 }, totals: { attemptFiles: 9 } }),
      '1 problem folder · 1 logged event · 9 code snapshots',
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
    el('div', { class: 'dash-head' }, el('div', {}, [
      el('h1', { text: 'Dashboard self-tests' }),
      el('div', { class: 'sub', text: `${results.length - failed} passed, ${failed} failed.` }),
    ])),
    el('section', { class: 'dash-card' }, el('div', { class: 'dash-selftest' }, results.map((r) => el('div', {
      class: r.pass ? 'ok' : 'bad',
      text: `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`,
    })))),
  ]);
}
