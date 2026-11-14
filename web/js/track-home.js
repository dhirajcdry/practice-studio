// The home page shared by Low-level design and System design.
//
// One page, four parts, in the order you need them:
//   Header     the track, and one line of true counts from the records.
//   Continue   the newest unfinished mock, else the latest practice session. Absent when
//              there is neither.
//   Problems   the catalog on the left, with what you have done on each, and on the right
//              the two ways in, Practise and Mock. With a problem chosen they act on it,
//              under its statement and your history with it; with none chosen (the page
//              opens that way) each starts on Surprise me or on a brief you write.
//              The right-hand card stays in view while a long list scrolls past.
//   Where you stand and History, side by side.
//
// Everything comes from saved records (GET /api/track-home plus the track's own interview
// and practice lists). A page visit never starts a model turn, and anything the records do
// not hold is said in words rather than filled in. The shaping is pure and tested in
// web/js/track-home-model.js.
import { el, replace } from './dom.js';
import { button } from './ui/button.js';
import { segmented } from './ui/segmented.js';
import { createBadge } from './ui/badge.js';
import { createSelect } from './ui/select.js';
import { createComposer, bindComposerInput } from './ui/composer.js';
import { createCoachModelPicker } from './coach-model.js';
import { createInterviewSetup, interviewJson } from './interview.js';
import { relativeInterviewDate, ratingTone } from './interview-format.js';
import { startPractice, startPracticeFromMock, practiceHref } from './practice.js';
import { readDraft, saveDraft, clearDraft } from './drafts.js';
import { readSidebar, saveSidebar } from './sidebar-state.js';
import { OWN, SURPRISE, agoWithTime, briefTitle, buildSessions, continueItem, dimensionTrend,
  filterSessions, headerSummary, practiceSettings, problemChoices, signalText, statusLine } from './track-home-model.js';

const RECENT = 8;  // history rows before "Show all"
const LEVELS = ['L3', 'L4', 'L5', 'L6'];

async function getJson(url) {
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'Saved practice could not be read.');
  return result;
}

const quiet = text => el('p', { class: 'th-quiet', text });
const pill = (text, tone = 'neutral') => { const node = createBadge(text, tone); node.classList.add('th-pill'); return node; };
const label = (id, title, tools) => el('header', { class: 'th-card-head' }, [el('h2', { id, class: 'th-label', text: title }), tools || null]);

/**
 * @param host element to render into
 * @param track {
 *   discipline: 'lld' | 'design', title,
 *   loadInterviews(): Promise<{ interviews: [{ id, slug, title, startedAt, debriefed }] }>,
 *   openInterview(item),
 *   startMock(problem | null, setupState)   null means "choose one for me"
 *   startOwnMock?(brief, setupState)        a mock on a brief the learner wrote; only a
 *                                           track that can run one passes it
 * }
 */
export function mountTrackHome(host, track) {
  let gone = false;
  const { discipline } = track;
  const notice = el('p', { class: 'th-notice', role: 'status' });
  const fail = error => { if (!gone) notice.textContent = error.message; };

  // State, set once the records arrive. Nothing is chosen on arrival: both ways in then
  // start on Surprise me unless the learner picks a problem or writes their own.
  let problems = [], items = [], selected = null, filter = 'all', showAll = false;
  const entryFor = slug => problems.find(p => p.slug === slug) || null;

  /* ---------------- the two ways in, built once ----------------
     Each is moved into whichever panel is showing, so its settings, a typed brief and a
     pending start survive a change of problem. */

  // "What to start on" when no problem is chosen: a Problem picker, a line saying what
  // that choice does, and a brief field when it is the learner's own.
  function problemPicker(kind, { hint, placeholder, onChange }) {
    const choices = problemChoices(kind, { ownMock: Boolean(track.startOwnMock) });
    const draftKey = `${discipline}-${kind}-brief`;
    const input = el('textarea', { maxlength: '4000', 'aria-label': kind === 'mock' ? 'Your problem for the mock' : 'Your problem for practice', placeholder });
    input.value = readDraft(draftKey)?.text || '';
    input.addEventListener('input', () => { if (input.value) saveDraft(draftKey, input.value); else clearDraft(draftKey); });
    const grow = bindComposerInput(input);
    const brief = createComposer({ className: 'th-brief', content: [input] });
    const line = el('p', { class: 'th-act-text th-pick-hint' });
    let choice = SURPRISE;
    const select = choices.length > 1 ? createSelect({ label: 'Problem', compact: true, value: choice, options: choices.map(c => [c.id, c.label]),
      onChange: () => { choice = select.value; paint(); onChange?.(); if (choice === OWN) input.focus(); } }) : null;
    const root = el('div', { class: 'th-pick', dataset: { kind } }, [
      select ? el('div', { class: 'th-pick-row' }, [el('span', { class: 'th-pick-label', 'aria-hidden': 'true', text: 'Problem' }), select]) : null,
      line, brief,
    ]);
    function paint() {
      root.dataset.choice = choice;
      line.textContent = hint[choice] || '';
      line.hidden = !line.textContent;
      brief.hidden = choice !== OWN;
      if (!brief.hidden) grow.resize();
    }
    paint();
    return {
      root, get choice() { return choice; }, brief: () => input.value.trim(),
      set disabled(value) { if (select) select.disabled = value; input.disabled = value; },
      forget() { input.value = ''; clearDraft(draftKey); grow.resize(); },
      dispose() { select?.dispose(); grow.dispose(); },
    };
  }

  // Practise: the settings a practice session honours (see practiceSettings), then Start.
  const practiseSaved = readSidebar(`${discipline}-new-practice`).setup || {};
  let practiseRequestId = crypto.randomUUID(), modelPending = false, practising = false, levelTouched = false;
  const practiseNotice = el('p', { class: 'th-notice', role: 'status' });
  const practisePick = problemPicker('practise', {
    hint: { [SURPRISE]: 'Studio prepares a problem you haven’t seen and opens it untimed.' },
    placeholder: 'Describe the problem, or leave this blank and tell the coach.',
    onChange: () => paintPractise(),
  });
  const practiseMode = createSelect({ label: 'Answer mode', compact: true, value: practiseSaved.mode || 'voice', options: [['voice', 'Voice'], ['typed', 'Typed']],
    onChange: () => saveSidebar(`${discipline}-new-practice`, { setup: { mode: practiseMode.value } }) });
  const practiseLevel = createSelect({ label: 'Target level', compact: true, value: 'L4', options: LEVELS.map(x => [x, x]),
    onChange: () => { levelTouched = true; practiseRequestId = crypto.randomUUID(); } });
  const practise = button({ label: 'Start practising', variant: 'secondary', size: 'lg', className: 'th-practice', onClick: () => startPractising() });
  const practiseModel = createCoachModelPicker({ compact: true, onPending: value => { modelPending = value; paintPractise(); } });
  const practiseOptions = el('div', { class: 'th-options ci-setup-options' }, [practiseMode, practiseLevel, practiseModel.root]);
  interviewJson('/api/learner/preferences').then(({ preferences }) => {
    if (!gone && !practising && !levelTouched) practiseLevel.value = preferences?.targetLevel?.[discipline] || preferences?.targetLevel?.default || 'L4';
  }).catch(() => {}); // Starting reports an unavailable preferences store; L4 remains usable.
  function paintPractise() {
    const problem = entryFor(selected);
    practiseLevel.hidden = !practiceSettings(discipline, { chosen: Boolean(problem), choice: practisePick.choice }).includes('level');
    practise.disabled = modelPending || practising;
    practise.querySelector('span').textContent = practising && !problem && practisePick.choice === SURPRISE ? 'Preparing…' : 'Start practising';
    practiseMode.disabled = practiseLevel.disabled = practising;
    practisePick.disabled = practising;
  }
  async function startPractising() {
    if (modelPending || practising) return;
    const problem = entryFor(selected), choice = practisePick.choice;
    const options = { mode: practiseMode.value };
    practising = true; practiseNotice.textContent = ''; paintPractise();
    try {
      // The level is the learner's saved target, as a mock's setup records it.
      if (!practiseLevel.hidden) await interviewJson('/api/learner/preferences', { targetLevel: { [discipline]: practiseLevel.value } });
      if (gone) return;
      if (problem) await startPractice({ ...problem, discipline }, {}, options);
      else if (choice === OWN) {
        const brief = practisePick.brief();
        await startPractice(brief ? { discipline, title: briefTitle(brief), statement: brief } : { discipline, title: 'Open practice', statement: '' }, {}, options);
        practisePick.forget();
      } else {
        // The prepared problem arrives in its public shape only (title and statement);
        // its interviewer-only facts and curveball never reach this page.
        const prepared = (await interviewJson('/api/mock/prepare', { discipline, targetLevel: practiseLevel.value, minutes: 45, requestId: practiseRequestId })).problem;
        if (gone) return;
        await startPractice({ discipline, slug: prepared.slug, title: prepared.title, statement: prepared.statement }, {}, options);
        practiseRequestId = crypto.randomUUID();
      }
    } catch (error) {
      if (!gone) practiseNotice.textContent = error.message || 'Could not start practice. Try again.';
    } finally { practising = false; if (!gone) paintPractise(); }
  }

  // Mock: the shared interview setup. A retry keeps its start request, as everywhere.
  const mockPick = problemPicker('mock', {
    hint: { [SURPRISE]: 'Studio prepares a problem you haven’t sat, chosen from what your reports say to work on.' },
    placeholder: 'Describe the system to design, in a sentence or two.',
  });
  const setup = createInterviewSetup({ slug: `${discipline}-new-mock`, discipline, label: 'Mock settings', startLabel: 'Start mock',
    onStart: state => {
      const problem = entryFor(selected);
      if (problem) return track.startMock(problem, { ...state, slug: problem.slug, title: problem.title });
      if (mockPick.choice === OWN && track.startOwnMock) {
        const brief = mockPick.brief();
        if (!brief) throw Error('Write your problem first. A sentence or two is enough.');
        const started = track.startOwnMock(brief, state);
        mockPick.forget();
        return started;
      }
      return track.startMock(null, state);
    } });

  const practiseAct = el('div', { class: 'th-act th-act--practise' }, [
    el('div', { class: 'th-act-head' }, [el('h3', { text: 'Practise' }), el('p', { class: 'th-act-text', text: 'No clock, no grade. The coach works beside you.' })]),
    practisePick.root, el('div', { class: 'th-start' }, [practiseOptions, practiseNotice, practise])]);
  const mockAct = el('div', { class: 'th-act th-mock' }, [
    el('div', { class: 'th-act-head' }, [el('h3', { text: 'Mock' })]), mockPick.root, el('div', { class: 'th-start' }, setup.root)]);
  const actions = el('div', { class: 'th-actions' }, [practiseAct, mockAct]);

  const summary = el('p', { class: 'th-summary', text: 'Reading saved practice…' });
  const continueSlot = el('div', { class: 'th-continue-slot' });
  const picker = el('div', { class: 'th-picker', role: 'group', 'aria-label': 'Problems' }, quiet('Reading problems…'));
  const detail = el('section', { class: 'th-detail', 'aria-live': 'polite' });
  const stand = el('section', { class: 'th-stand th-card', 'aria-labelledby': 'th-stand-title' }, [label('th-stand-title', 'Where you stand'), quiet('Reading reports…')]);
  const history = el('section', { class: 'th-history th-card', 'aria-labelledby': 'th-history-title' }, [label('th-history-title', 'History'), quiet('Reading saved practice…')]);

  host.classList.add('th-host');
  const page = el('div', { class: 'th' }, el('div', { class: 'th-wrap' }, [
    el('header', { class: 'th-head' }, [el('h1', { class: 'th-title', text: track.title }), summary]),
    continueSlot,
    el('section', { class: 'th-problems', 'aria-labelledby': 'th-problems-title' }, [
      el('h2', { id: 'th-problems-title', class: 'th-sr', text: 'Problems' }),
      el('div', { class: 'th-md' }, [picker, detail]),
    ]),
    el('div', { class: 'th-lower' }, [stand, history]),
    notice,
  ]));
  replace(host, page);

  /* ---------------- the card stays in view ----------------
     The detail card sticks under the app bar while the list beside it scrolls past, but
     only when all of it fits on screen; a taller card scrolls with the page so its Start
     buttons are never out of reach. The bar's real height is measured, since themes size
     it differently. The CSS applies it only when list and card sit side by side. */
  function measurePin() {
    if (gone) return;
    const bar = document.querySelector('.topbar');
    const barHeight = bar && /sticky|fixed/.test(getComputedStyle(bar).position) ? bar.getBoundingClientRect().height : 0;
    page.style.setProperty('--th-bar', `${Math.round(barHeight)}px`);
    const gap = parseFloat(getComputedStyle(page).getPropertyValue('--space-5')) || 20;
    detail.classList.toggle('is-pinned', detail.offsetHeight > 0 && barHeight + 2 * gap + detail.offsetHeight <= innerHeight);
  }
  const pinObserver = new ResizeObserver(() => measurePin());
  pinObserver.observe(detail);
  const topbar = document.querySelector('.topbar');
  if (topbar) pinObserver.observe(topbar);
  window.addEventListener('resize', measurePin);

  (async () => {
    let home, list, practice;
    try {
      [home, list, practice] = await Promise.all([
        getJson(`/api/track-home?discipline=${discipline}`),
        track.loadInterviews(),
        getJson(`/api/practice?discipline=${discipline}`),
      ]);
    } catch (error) {
      if (gone) return;
      summary.textContent = error.message;
      replace(picker, quiet(error.message));
      replace(stand, [label('th-stand-title', 'Where you stand'), quiet(error.message)]);
      replace(history, [label('th-history-title', 'History'), quiet(error.message)]);
      page.dataset.state = 'error';
      return;
    }
    if (gone) return;
    problems = home.problems.map(p => ({ ...p, title: p.title || 'Untitled problem' }));
    items = buildSessions({ interviews: list.interviews || [], sessions: practice.sessions || [], assessments: home.assessments || [], problems });
    const current = continueItem(items);
    summary.textContent = headerSummary(problems, items);
    replace(continueSlot, current ? continueBand(current) : []);
    paintPicker(); paintDetail();
    paintStand(home.rubric || [], home.assessments || []);
    paintHistory();
    page.dataset.state = 'ready';
  })();

  /* ---------------- Continue ---------------- */
  function continueBand(item) {
    const mock = item.kind === 'mock';
    const when = mock ? `started ${agoWithTime(item.at)}` : `last worked on ${agoWithTime(item.at)}`;
    return el('section', { class: 'th-continue', 'aria-label': 'Continue' }, [
      el('span', { class: 'th-dot', 'aria-hidden': 'true' }),
      el('p', { class: 'th-continue-what' }, [el('strong', { text: `${mock ? 'Mock' : 'Practice'} · ${item.title}` }), el('span', { class: 'th-continue-when', text: ` · ${when}` })]),
      button({ label: mock ? 'Resume' : 'Continue', variant: 'primary', className: 'th-resume', onClick: () => open(item) }),
    ]);
  }
  const open = item => item.mock ? track.openInterview(item.mock) : (location.hash = practiceHref(item.session));

  /* ---------------- the problem list ----------------
     A group of toggles: choosing a problem points both ways in at it; choosing it again,
     Escape, or Clear in the panel goes back to starting on something new. */
  const rows = () => [...picker.querySelectorAll('.th-problem')];
  function choose(slug, focus = false) {
    selected = slug;
    const all = rows();
    for (const row of all) {
      const on = row.dataset.slug === slug;
      row.setAttribute('aria-pressed', String(on));
      row.tabIndex = on || (!slug && row === all[0]) ? 0 : -1;
      if (on && focus) row.focus();
    }
    paintDetail();
  }
  function paintPicker() {
    if (!problems.length) { replace(picker, quiet('No problems in the library yet.')); return; }
    replace(picker, problems.map((p, i) => el('button', { class: 'ui-action-row th-problem', type: 'button', 'aria-pressed': String(p.slug === selected),
      tabindex: p.slug === selected || (!selected && i === 0) ? '0' : '-1', dataset: { slug: p.slug }, onclick: () => choose(selected === p.slug ? null : p.slug) }, [
      el('span', { class: 'th-problem-title', text: p.title }),
      el('span', { class: 'th-problem-line', text: statusLine(p.slug, items) }),
    ])));
  }
  picker.addEventListener('keydown', event => {
    const row = event.target.closest('.th-problem');
    if (!row) return;
    if (event.key === 'Escape' && selected) { event.preventDefault(); choose(null); row.focus(); return; }
    const keys = { ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const all = rows(), at = all.indexOf(row), step = keys[event.key];
    const next = Number.isFinite(step) ? Math.max(0, Math.min(all.length - 1, at + step)) : step < 0 ? 0 : all.length - 1;
    choose(all[next].dataset.slug, true);
  });

  /* ---------------- the panel ---------------- */
  function paintDetail() {
    const problem = entryFor(selected);
    practiseNotice.textContent = '';
    practisePick.root.hidden = mockPick.root.hidden = Boolean(problem);
    paintPractise();
    if (!problem) {
      replace(detail, el('div', { class: 'th-detail-body', dataset: { chosen: 'none' } }, [
        el('div', {}, [el('h2', { class: 'th-detail-title', text: 'Start something new' }),
          el('p', { class: 'th-statement', text: problems.length
            ? 'Pick a problem from the list, or start on a surprise or on your own problem.'
            : 'Start on a surprise or on your own problem.' })]),
        actions,
      ]));
      return;
    }
    const mine = items.filter(item => item.slug === problem.slug);
    replace(detail, el('div', { class: 'th-detail-body', dataset: { chosen: problem.slug } }, [
      el('div', { class: 'th-detail-head' }, [
        el('div', { class: 'th-detail-name' }, [el('h2', { class: 'th-detail-title', text: problem.title }),
          problem.statement ? el('p', { class: 'th-statement', text: problem.statement }) : null]),
        button({ label: 'Clear', icon: 'close', variant: 'quiet', className: 'th-clear', title: 'Start on something new instead', onClick: () => {
          const row = picker.querySelector(`.th-problem[data-slug="${CSS.escape(problem.slug)}"]`);
          choose(null); row?.focus();
        } }),
      ]),
      // With nothing done, the list row already says "Not tried yet".
      mine.length ? el('div', {}, [el('h3', { class: 'th-label', text: 'Your history with this problem' }), el('ul', { class: 'th-past-list' }, mine.map(pastRow))]) : null,
      actions,
    ]));
  }
  function outcome(item, withLevel = false) {
    if (item.kind !== 'mock') return null;
    if (!item.finished) return pill('Unfinished');
    const signal = signalText(item), level = withLevel ? item.assessment?.targetLevel : null;
    return signal ? pill(level ? `${signal} · ${level}` : signal, ratingTone(item.assessment.signal)) : el('span', { class: 'th-unscored', text: 'No grade' });
  }
  function again(item) {
    if (item.kind !== 'mock' || !item.finished) return null;
    return button({ label: 'Practise it', variant: 'quiet', className: 'th-again', onClick: async event => {
      const control = event.currentTarget; control.disabled = true;
      try { await startPracticeFromMock({ discipline, slug: item.slug, interviewId: item.mock.id }); }
      catch (error) { fail(error); control.disabled = false; }
    } });
  }
  const opener = (item, className, cells) => item.mock
    ? el('button', { class: `ui-action-row ${className}`, type: 'button', onclick: () => open(item) }, cells)
    : el('a', { class: `ui-action-row ${className}`, href: practiceHref(item.session) }, cells);
  function pastRow(item) {
    return el('li', { class: 'th-past', dataset: { kind: item.kind } }, [
      opener(item, 'th-past-open', [
        el('span', { class: 'th-past-kind', text: item.kind === 'mock' ? 'Mock' : 'Practice' }),
        el('span', { class: 'th-past-score' }, item.kind === 'mock' ? outcome(item, true) : el('span', { class: 'th-unscored', text: item.session?.source ? 'Untimed · from a mock' : 'Untimed' })),
      ]),
      again(item) || el('span', { class: 'th-again-slot', 'aria-hidden': 'true' }),
      el('span', { class: 'th-past-date', text: relativeInterviewDate(item.at) }),
    ]);
  }

  /* ---------------- where you stand ---------------- */
  function paintStand(rubric, assessments) {
    const trend = dimensionTrend(rubric, assessments);
    const head = label('th-stand-title', 'Where you stand');
    if (!trend.lead) {
      replace(stand, [head,
        el('p', { class: 'th-stand-empty', text: assessments.length
          ? 'None of your finished mocks has a structured report yet, so no skill has a rating.'
          : 'No finished mock yet, so no skill has a rating.' }),
        el('p', { class: 'th-quiet', text: 'A mock rates each of these, with evidence from what you said and wrote:' }),
        el('ul', { class: 'th-rubric-names' }, rubric.map(name => el('li', {}, pill(name)))),
      ]);
      return;
    }
    const lead = trend.lead;
    replace(stand, [head,
      lead.headline ? el('p', { class: 'th-lead-headline', text: lead.headline }) : null,
      lead.moveUp ? el('p', { class: 'th-moveup', text: `To move up: ${lead.moveUp}` }) : null,
      el('ul', { class: 'th-dims', 'aria-label': `Each skill: one mark per report for the last ${trend.reports === 1 ? 'report' : `${trend.reports} reports`}, oldest first, then the newest rating` },
        trend.rows.map(row => el('li', { class: 'th-dim', dataset: { name: row.name } }, [
          el('span', { class: 'th-dim-name', text: row.name }),
          marks(row.marks),
          el('span', { class: 'th-dim-rating' }, row.latest ? pill(row.latest.rating, ratingTone(row.latest.rating)) : el('span', { class: 'th-unscored', text: 'No evidence yet' })),
        ]))),
    ]);
  }
  function marks(list) {
    const words = list.map(m => m.rating || 'not rated').join(', ');
    return el('span', { class: 'th-marks', role: 'img', 'aria-label': `Oldest first: ${words}` },
      list.map(m => el('i', { class: m.rating ? `th-mark th-mark--${ratingTone(m.rating)}` : 'th-mark' })));
  }

  /* ---------------- history ---------------- */
  const filters = segmented({ label: 'Show', value: filter, className: 'th-filter', options: [
    { id: 'all', label: 'All' }, { id: 'mocks', label: 'Mocks' }, { id: 'practice', label: 'Practice' },
  ], onChange: id => { filter = id; showAll = false; filters.setValue(id); paintHistory(); } });
  function paintHistory() {
    const shown = filterSessions(items, filter), visible = showAll ? shown : shown.slice(0, RECENT);
    const head = label('th-history-title', 'History', items.length ? filters : null);
    replace(history, [head,
      !items.length ? quiet('No mocks or practice sessions yet.')
        : shown.length ? el('ul', { class: 'th-rows' }, visible.map(sessionRow))
          : quiet(filter === 'mocks' ? 'No mocks yet.' : 'No practice sessions yet.'),
      shown.length > visible.length ? button({ label: `Show all ${shown.length}`, variant: 'quiet', className: 'th-all', onClick: () => { showAll = true; paintHistory(); } }) : null,
    ]);
  }
  function sessionRow(item) {
    return el('li', { class: 'th-item', dataset: { slug: item.slug || '', kind: item.kind } }, [
      opener(item, 'th-item-open', [
        el('span', { class: 'th-item-title', text: item.title }),
        el('span', { class: 'th-item-kind', text: item.kind === 'mock' ? 'Mock' : 'Practice' }),
        el('span', { class: 'th-item-score' }, outcome(item)),
        el('span', { class: 'th-item-date', text: relativeInterviewDate(item.at) }),
      ]),
      again(item) || el('span', { class: 'th-again-slot', 'aria-hidden': 'true' }),
    ]);
  }

  return { destroy() {
    gone = true; host.classList.remove('th-host');
    pinObserver.disconnect(); window.removeEventListener('resize', measurePin);
    setup.dispose(); practiseModel.dispose(); practiseMode.dispose(); practiseLevel.dispose();
    practisePick.dispose(); mockPick.dispose();
  } };
}
