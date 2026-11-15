// The home page shared by Low-level design and System design.
//
// One page, four parts, in the order you need them:
//   Header     the track, and one line of true counts from the records.
//   Continue   the newest unfinished mock, else the latest practice session. Absent when
//              there is neither.
//   Stage      one wide card with a Practise | Mock switch at its top. The chosen mode owns
//              the card: its promise and what it gives on the left, its settings, the
//              Problem row and the page's one Start button on the right. The problem is
//              shared by both modes (pick once, then choose how to do it): Surprise me by
//              default, your own brief, or a library problem chosen from chips that carry
//              each problem's status.
//   Where you stand and History, side by side.
//
// Everything comes from saved records (GET /api/track-home plus the track's own interview
// and practice lists). A page visit never starts a model turn, and anything the records do
// not hold is said in words rather than filled in. The shaping is pure and tested in
// web/js/track-home-model.js.
import { el, replace } from './dom.js';
import { button } from './ui/button.js';
import { icon } from './ui/icon.js';
import { segmented } from './ui/segmented.js';
import { createBadge } from './ui/badge.js';
import { createSelect } from './ui/select.js';
import { createComposer, bindComposerInput } from './ui/composer.js';
import { createCoachModelPicker } from './coach-model.js';
import { createInterviewSetup, interviewJson, setupField } from './interview.js';
import { relativeInterviewDate, ratingTone } from './interview-format.js';
import { startPractice, startPracticeFromMock, practiceHref } from './practice.js';
import { readDraft, saveDraft, clearDraft } from './drafts.js';
import { readSidebar, saveSidebar } from './sidebar-state.js';
import { MODES, OWN, SURPRISE, TONE_LABELS, agoWithTime, briefTitle, buildSessions, continueItem, dimensionTrend, filterProblems,
  filterSessions, headerSummary, lastLine, modeOrDefault, practiceSettings, problemTone, signalText, statusLine } from './track-home-model.js';

const RECENT = 8;        // history rows before "Show all"
const LEVELS = ['L3', 'L4', 'L5', 'L6'];
const FILTER_AT = 12;    // library problems before the picker offers a filter

// What each mode promises, as true statements about how it behaves (see docs/UI.md).
const COPY = {
  practise: { name: 'Practise', tag: 'Untimed · coached', icon: 'chat', promise: 'No clock, no grade. The coach works beside you.',
    gets: ['Ask for a hint, a check or a worked example whenever you like', 'Stop when you want; nothing is scored', 'Save any reply to your learning notes'] },
  mock: { name: 'Mock', tag: 'Timed · graded', icon: 'clock', promise: 'Timed and graded, with a report at the end.',
    gets: ['An interviewer who stays quiet unless it needs to step in', 'The clock runs for the length you set', 'A report that rates each skill from evidence and gives a hire signal at your level'] },
};

async function getJson(url) {
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'Saved practice could not be read.');
  return result;
}

const quiet = text => el('p', { class: 'th-quiet', text });
const pill = (text, tone = 'neutral') => { const node = createBadge(text, tone); node.classList.add('th-pill'); return node; };
const label = (id, title, tools) => el('header', { class: 'th-card-head' }, [el('h2', { id, class: 'th-label', text: title }), tools || null]);
const dot = tone => el('i', { class: 'th-sd', dataset: { tone }, 'aria-hidden': 'true' });

/**
 * @param host element to render into
 * @param track {
 *   discipline: 'lld' | 'design', title,
 *   loadInterviews(): Promise<{ interviews: [{ id, slug, title, startedAt, debriefed }] }>,
 *   openInterview(item),
 *   startMock(problem | null, setupState)   null means "choose one for me"
 *   startOwnMock?(brief, setupState)        a mock on a brief the learner wrote (both
 *                                           tracks pass it)
 * }
 */
export function mountTrackHome(host, track) {
  let gone = false;
  const { discipline } = track;
  const notice = el('p', { class: 'th-notice', role: 'status' });
  const fail = error => { if (!gone) notice.textContent = error.message; };

  // State, set once the records arrive. The problem starts on Surprise me; the mode is the
  // one this viewer last used on this track (Practise on a first visit).
  let problems = [], items = [], choice = SURPRISE, filter = 'all', showAll = false, open = false;
  let mode = modeOrDefault(readSidebar(`${discipline}-home`).mode);
  const entryFor = slug => problems.find(p => p.slug === slug) || null;

  /* ---------------- the problem, shared by both modes ----------------
     One brief for both modes, kept as a draft until a start succeeds. Older per-mode drafts
     are read once so nothing typed before this layout is lost. */
  const draftKey = `${discipline}-brief`, oldDrafts = [`${discipline}-mock-brief`, `${discipline}-practise-brief`];
  const input = el('textarea', { maxlength: '4000', 'aria-label': 'Your problem' });
  input.value = readDraft(draftKey)?.text || oldDrafts.map(key => readDraft(key)?.text).find(Boolean) || '';
  input.addEventListener('input', () => { if (input.value) saveDraft(draftKey, input.value); else clearDraft(draftKey); });
  const grow = bindComposerInput(input);
  const briefHint = el('p', { class: 'th-brief-hint' });
  const brief = el('div', { class: 'th-brief-wrap' }, [createComposer({ className: 'th-brief', content: [input] }), briefHint]);
  const forgetBrief = () => { input.value = ''; clearDraft(draftKey); for (const key of oldDrafts) clearDraft(key); grow.resize(); };

  const qMark = el('span', { class: 'th-qmark', 'aria-hidden': 'true' });
  const qTitle = el('strong', { class: 'th-qtitle' });
  const qSub = el('span', { class: 'th-qsub' });
  const clear = button({ label: 'Clear', icon: 'close', variant: 'quiet', className: 'th-qclear', ariaLabel: 'Clear the problem: back to Surprise me',
    onClick: () => { choose(SURPRISE); change.focus(); } });
  const changeText = el('span', { text: 'Change' });
  const change = el('button', { type: 'button', class: 'btn btn--quiet th-qchange', 'aria-expanded': 'false', 'aria-controls': `th-qpanel-${discipline}`,
    onclick: () => { setOpen(!open); if (open && !filterBox.hidden) filterInput.focus(); } }, [changeText, icon('chevron', 15)]);
  const filterInput = el('input', { type: 'text', class: 'th-qfilter-input', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Filter problems' });
  const filterBox = el('label', { class: 'th-qfilter', hidden: true }, [icon('search', 15), filterInput]);
  const chips = el('div', { class: 'th-chips', role: 'group', 'aria-label': 'Problems' });
  const noMatch = quiet('No problem matches.');
  const legend = el('p', { class: 'th-legend' });
  const panel = el('div', { class: 'th-qpanel', id: `th-qpanel-${discipline}`, hidden: true }, [filterBox, chips, noMatch, legend]);
  const qrow = el('div', { class: 'th-qrow' }, [
    el('div', { class: 'th-qhead' }, [el('span', { class: 'th-qlabel', text: 'Problem' }), qMark,
      el('span', { class: 'th-qvalue' }, [qTitle, qSub]), clear, change]),
    panel, brief,
  ]);
  const chip = (id, content, title) => el('button', { type: 'button', class: 'btn btn--quiet th-chip', 'aria-pressed': 'false', dataset: { choice: id }, title,
    onclick: () => { choose(id); setOpen(false); (id === OWN ? input : change).focus(); } }, content);
  const surpriseChip = chip(SURPRISE, [icon('dice', 14), el('span', { text: 'Surprise me' })]);
  const ownChip = chip(OWN, [icon('edit', 14), el('span', { text: 'My own problem' })]);
  let problemChips = [];

  function paintChips() {
    // Built once when the records arrive; the filter only hides chips.
    problemChips = problems.map(p => {
      const status = statusLine(p.slug, items), node = chip(p.slug, [dot(problemTone(p.slug, items)), el('span', { text: p.title })], `${p.title} · ${status}`);
      node.classList.add('th-problem'); node.dataset.slug = p.slug;
      return node;
    });
    replace(chips, [surpriseChip, ownChip, ...problemChips]);
    const tones = new Set(problems.map(p => problemTone(p.slug, items)));
    replace(legend, Object.entries(TONE_LABELS).filter(([tone]) => tones.has(tone)).map(([tone, text]) => el('span', {}, [dot(tone), text])));
    legend.hidden = !tones.size;
    filterBox.hidden = problems.length <= FILTER_AT;
    filterInput.placeholder = `Filter ${problems.length} problems`;
    applyFilter();
  }
  function applyFilter() {
    const shown = new Set(filterProblems(problems, filterInput.value).map(p => p.slug));
    for (const node of problemChips) node.hidden = !shown.has(node.dataset.slug);
    noMatch.hidden = !problems.length || shown.size > 0;
    if (!problems.length) { noMatch.hidden = false; noMatch.textContent = 'No problems in the library yet.'; } else noMatch.textContent = 'No problem matches.';
  }
  filterInput.addEventListener('input', applyFilter);
  filterInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const visible = problemChips.filter(node => !node.hidden);
    if (visible.length === 1) visible[0].click();
  });
  // Arrow keys move between the chips that are showing.
  chips.addEventListener('keydown', event => {
    const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys) || !event.target.closest('.th-chip')) return;
    event.preventDefault();
    const all = [...chips.querySelectorAll('.th-chip:not([hidden])')], at = all.indexOf(event.target.closest('.th-chip')), step = keys[event.key];
    all[Number.isFinite(step) ? Math.max(0, Math.min(all.length - 1, at + step)) : step < 0 ? 0 : all.length - 1]?.focus();
  });
  // Escape or a click elsewhere folds the chips.
  qrow.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault(); event.stopPropagation();
    setOpen(false); change.focus();
  });
  const outside = event => { if (open && !qrow.contains(event.target)) setOpen(false); };
  document.addEventListener('pointerdown', outside, true);

  function setOpen(value) {
    open = value;
    panel.hidden = !open;
    qrow.dataset.open = String(open);
    change.setAttribute('aria-expanded', String(open));
    changeText.textContent = open ? 'Done' : 'Change';
    if (open) {
      const at = chips.querySelector('.th-chip[aria-pressed="true"]:not([hidden])');
      if (at) chips.scrollTop = at.offsetTop - chips.offsetTop - chips.clientHeight / 2 + at.offsetHeight / 2;
    } else if (filterInput.value) { filterInput.value = ''; applyFilter(); }
  }
  function choose(id) {
    choice = id;
    practiseNotice.textContent = '';
    paintProblem(); paintPractise();
    if (choice === OWN) grow.resize();
  }
  function paintProblem() {
    const problem = entryFor(choice);
    qrow.dataset.choice = problem ? 'problem' : choice;
    for (const node of chips.querySelectorAll('.th-chip')) node.setAttribute('aria-pressed', String(node.dataset.choice === choice));
    replace(qMark, problem ? dot(problemTone(problem.slug, items)) : icon(choice === OWN ? 'edit' : 'dice', 15));
    qTitle.textContent = problem ? problem.title : choice === OWN ? 'My own problem' : 'Surprise me';
    qSub.textContent = problem ? statusLine(problem.slug, items)
      : choice === OWN ? 'brief below' : mode === 'mock' ? 'one you haven’t seen, picked from your reports' : 'one you haven’t seen';
    clear.hidden = choice === SURPRISE;
    brief.hidden = choice !== OWN;
    input.placeholder = mode === 'mock'
      ? discipline === 'lld' ? 'Describe the problem to design, in a sentence or two.' : 'Describe the system to design, in a sentence or two.'
      : 'Describe the problem, or leave this blank and tell the coach.';
    // An LLD mock needs the interviewer's private notes, prepared from your brief first.
    briefHint.textContent = mode === 'mock'
      ? discipline === 'lld' ? 'Studio prepares the interviewer’s notes for your problem, then the clock starts.' : 'A sentence or two is enough. The interviewer works from what you write here.'
      : 'The coach works from what you write here.';
  }

  /* ---------------- Practise: its settings and Start ----------------
     Both modes' controls are built once; the switch only shows one, so settings, the
     problem, a typed brief and a pending start all survive a flip. */
  const practiseSaved = readSidebar(`${discipline}-new-practice`).setup || {};
  let practiseRequestId = crypto.randomUUID(), modelPending = false, practising = false, levelTouched = false;
  const practiseNotice = el('p', { class: 'th-notice th-start-notice', role: 'status' });
  const practiseMode = createSelect({ label: 'Answer mode', compact: true, value: practiseSaved.mode || 'voice', options: [['voice', 'Voice'], ['typed', 'Typed']],
    onChange: () => saveSidebar(`${discipline}-new-practice`, { setup: { mode: practiseMode.value } }) });
  const practiseLevel = createSelect({ label: 'Target level', compact: true, value: 'L4', options: LEVELS.map(x => [x, x]),
    onChange: () => { levelTouched = true; practiseRequestId = crypto.randomUUID(); } });
  const practiseLevelField = setupField('Level', practiseLevel, 'level');
  const practise = button({ label: 'Start practising', variant: 'primary', size: 'lg', className: 'th-practice th-go', onClick: () => startPractising() });
  const practiseLabel = practise.querySelector('span');
  const practiseModel = createCoachModelPicker({ compact: true, onPending: value => { modelPending = value; paintPractise(); } });
  const practiseOptions = el('div', { class: 'th-options ci-setup-options ci-setup-fields' }, [
    setupField('Answer', practiseMode, 'answer'), practiseLevelField, setupField('Coach', practiseModel.root, 'model')]);
  interviewJson('/api/learner/preferences').then(({ preferences }) => {
    if (!gone && !practising && !levelTouched) practiseLevel.value = preferences?.targetLevel?.[discipline] || preferences?.targetLevel?.default || 'L4';
  }).catch(() => {}); // Starting reports an unavailable preferences store; L4 remains usable.
  function paintPractise() {
    const problem = entryFor(choice);
    practiseLevelField.hidden = !practiceSettings(discipline, { chosen: Boolean(problem), choice: problem ? null : choice }).includes('level');
    // The coach picker can report pending while it is built, before the row exists.
    if (practiseLevelField.parentElement) practiseLevelField.parentElement.dataset.count = practiseLevelField.hidden ? '2' : '3';
    practise.disabled = modelPending || practising;
    practiseLabel.textContent = practising && !problem && choice === SURPRISE ? 'Preparing…' : 'Start practising';
    // A start in flight keeps the problem it started on.
    practiseMode.disabled = practiseLevel.disabled = change.disabled = clear.disabled = input.disabled = practising;
    if (practising && open) setOpen(false);
  }
  async function startPractising() {
    if (modelPending || practising) return;
    const problem = entryFor(choice), own = !problem && choice === OWN;
    const options = { mode: practiseMode.value };
    practising = true; practiseNotice.textContent = ''; paintPractise();
    try {
      // The level is the learner's saved target, as a mock's setup records it.
      if (!practiseLevelField.hidden) await interviewJson('/api/learner/preferences', { targetLevel: { [discipline]: practiseLevel.value } });
      if (gone) return;
      if (problem) await startPractice({ ...problem, discipline }, {}, options);
      else if (own) {
        const text = input.value.trim();
        await startPractice(text ? { discipline, title: briefTitle(text), statement: text } : { discipline, title: 'Open practice', statement: '' }, {}, options);
        forgetBrief();
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

  /* ---------------- Mock: the shared interview setup ----------------
     A retry keeps its start request, as everywhere. */
  const setup = createInterviewSetup({ slug: `${discipline}-new-mock`, discipline, label: 'Mock settings', startLabel: 'Start mock', fields: true,
    onStart: async state => {
      const problem = entryFor(choice);
      if (problem) return track.startMock(problem, { ...state, slug: problem.slug, title: problem.title });
      if (choice === OWN) {
        if (!track.startOwnMock) throw Error('This track cannot run a mock on your own problem yet. Practise it instead.');
        const text = input.value.trim();
        if (!text) throw Error('Write your problem first. A sentence or two is enough.');
        // The brief is kept until the mock has started, so a failed preparation loses nothing.
        const started = await track.startOwnMock(text, state);
        forgetBrief();
        return started;
      }
      return track.startMock(null, state);
    } });
  setup.root.querySelector('.ci-start')?.classList.add('th-go');

  /* ---------------- the stage ---------------- */
  const tabs = MODES.map(id => el('button', { type: 'button', role: 'tab', class: 'btn btn--quiet th-sw', id: `th-sw-${discipline}-${id}`, dataset: { mode: id },
    'aria-controls': `th-stage-${discipline}`, onclick: () => setMode(id, true) }, [
    el('span', { class: 'th-sw-icon', 'aria-hidden': 'true' }, icon(COPY[id].icon, 20)),
    el('span', { class: 'th-sw-text' }, [el('span', { class: 'th-sw-name', text: COPY[id].name }), el('span', { class: 'th-sw-tag', text: COPY[id].tag })]),
  ]));
  const switcher = el('div', { class: 'th-switch', role: 'tablist', 'aria-label': 'How to work' }, tabs);
  switcher.addEventListener('keydown', event => {
    const keys = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: 1, ArrowUp: -1, Home: -Infinity, End: Infinity };
    if (!(event.key in keys)) return;
    event.preventDefault();
    const at = MODES.indexOf(mode), step = keys[event.key];
    const next = Number.isFinite(step) ? (at + step + MODES.length) % MODES.length : step < 0 ? 0 : MODES.length - 1;
    setMode(MODES[next], true); tabs[next].focus();
  });
  const lastLines = {};
  const blurb = id => {
    lastLines[id] = el('p', { class: 'th-last', text: 'Reading saved practice…' });
    return el('div', { class: 'th-mode', dataset: { mode: id } }, [
      el('div', {}, [el('h2', { class: 'th-mode-name', text: COPY[id].name }), el('p', { class: 'th-mode-promise', text: COPY[id].promise })]),
      el('ul', { class: 'th-gets' }, COPY[id].gets.map(text => el('li', {}, [icon('check', 14), el('span', { text })]))),
      lastLines[id],
    ]);
  };
  const blurbs = MODES.map(blurb);
  // The right column is one flex column: each mode's settings, the shared Problem row, then
  // that mode's notice and Start, ordered by CSS so nothing moves in the DOM on a flip.
  const stageBody = el('div', { class: 'th-stage-body', id: `th-stage-${discipline}`, role: 'tabpanel' }, [
    el('div', { class: 'th-stage-left' }, blurbs),
    el('div', { class: 'th-stage-right' }, [
      el('div', { class: 'th-set th-set--practise' }, [practiseOptions, practiseNotice, practise]),
      el('div', { class: 'th-set th-mock' }, setup.root),
      qrow,
    ]),
  ]);
  const stage = el('section', { class: 'th-stage', 'aria-label': 'Start' }, [switcher, stageBody]);
  function setMode(id, remember = false) {
    mode = id;
    stage.dataset.mode = id;
    tabs.forEach(tab => { const on = tab.dataset.mode === id; tab.setAttribute('aria-selected', String(on)); tab.tabIndex = on ? 0 : -1; });
    blurbs.forEach(node => { node.hidden = node.dataset.mode !== id; });
    stageBody.setAttribute('aria-labelledby', `th-sw-${discipline}-${id}`);
    paintProblem();
    if (remember) saveSidebar(`${discipline}-home`, { mode: id });
  }
  setMode(mode); paintPractise();

  const summary = el('p', { class: 'th-summary', text: 'Reading saved practice…' });
  const continueSlot = el('div', { class: 'th-continue-slot' });
  const stageSlot = el('div', { class: 'th-stage-slot' }, quiet('Reading problems…'));
  const stand = el('section', { class: 'th-stand th-card', 'aria-labelledby': 'th-stand-title' }, [label('th-stand-title', 'Where you stand'), quiet('Reading reports…')]);
  const history = el('section', { class: 'th-history th-card', 'aria-labelledby': 'th-history-title' }, [label('th-history-title', 'History'), quiet('Reading saved practice…')]);

  host.classList.add('th-host');
  const page = el('div', { class: 'th' }, el('div', { class: 'th-wrap' }, [
    el('header', { class: 'th-head' }, [el('h1', { class: 'th-title', text: track.title }), summary]),
    continueSlot,
    stageSlot,
    el('div', { class: 'th-lower' }, [stand, history]),
    notice,
  ]));
  replace(host, page);

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
      replace(stageSlot, quiet(error.message));
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
    for (const id of MODES) lastLines[id].textContent = lastLine(id, items);
    paintChips(); paintProblem(); paintPractise();
    replace(stageSlot, stage);
    if (choice === OWN) grow.resize();
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
      button({ label: mock ? 'Resume' : 'Continue', variant: 'secondary', className: 'th-resume', onClick: () => openItem(item) }),
    ]);
  }
  const openItem = item => item.mock ? track.openInterview(item.mock) : (location.hash = practiceHref(item.session));

  function outcome(item) {
    if (item.kind !== 'mock') return null;
    if (!item.finished) return pill('Unfinished');
    const signal = signalText(item);
    return signal ? pill(signal, ratingTone(item.assessment.signal)) : el('span', { class: 'th-unscored', text: 'No grade' });
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
    ? el('button', { class: `ui-action-row ${className}`, type: 'button', onclick: () => openItem(item) }, cells)
    : el('a', { class: `ui-action-row ${className}`, href: practiceHref(item.session) }, cells);

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
    document.removeEventListener('pointerdown', outside, true);
    setup.dispose(); practiseModel.dispose(); practiseMode.dispose(); practiseLevel.dispose(); grow.dispose();
  } };
}
