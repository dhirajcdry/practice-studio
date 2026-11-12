// The home page shared by Low-level design and System design.
//
// It answers three questions in order: what should I do next, how am I doing on each
// skill, and where did I leave each problem. Everything comes from saved records
// (GET /api/track-home plus the track's own interview and practice lists); a page
// visit never starts a model turn, and a skill with no evidence is shown as unknown.
import { el, replace } from './dom.js';
import { screenHeader } from './ui/headers.js';
import { createBadge } from './ui/badge.js';
import { button } from './ui/button.js';
import { icon } from './ui/icon.js';
import { createInterviewSetup } from './interview.js';
import { createLearnerSummary } from './learner.js';
import { openLearningNotes } from './learning.js';
import { relativeInterviewDate, ratingTone, signalLabel } from './interview-format.js';
import { startPractice, startPracticeFromMock, practiceHref } from './practice.js';

const GRID_COLUMNS = 8;
const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const shortDate = value => new Date(time(value)).toLocaleDateString([], { month: 'short', day: 'numeric' });

async function getJson(url) {
  const response = await fetch(url);
  const result = await response.json();
  if (!response.ok) throw Error(result.error?.message || 'Saved practice could not be read.');
  return result;
}

/**
 * @param host element to render into
 * @param track {
 *   discipline: 'lld' | 'design', title,
 *   loadInterviews(): Promise<{ interviews: [{ id, slug, title, startedAt, debriefed }], presetSlugs?: Set }>,
 *   openInterview(item), createNewMock(): { root, dispose }, startMock(problem, setupState)
 * }
 */
export function mountTrackHome(host, track) {
  let gone = false;
  const disposers = [];
  const own = thing => { disposers.push(() => thing?.dispose?.()); return thing; };
  const { discipline } = track;
  const notice = el('p', { class: 'th-notice', role: 'status' });
  const fail = error => { if (!gone) notice.textContent = error.message; };

  // Starting points live behind the header actions, so the page opens on evidence.
  const newMock = own(track.createNewMock());
  const startPanel = el('section', { class: 'th-start', hidden: true, 'aria-label': 'New mock interview' }, [newMock.root]);
  const newButton = button({ label: 'Start a new mock', variant: 'primary', className: 'th-new', onClick: () => {
    startPanel.hidden = !startPanel.hidden;
    newButton.setAttribute('aria-expanded', String(!startPanel.hidden));
    if (!startPanel.hidden) startPanel.querySelector('button, [tabindex]')?.focus();
  } });
  newButton.setAttribute('aria-expanded', 'false');
  const openPractice = button({ label: 'Untimed practice', variant: 'secondary', className: 'th-practice', onClick: async () => {
    openPractice.disabled = true;
    try { await startPractice({ discipline, title: 'Open practice', statement: '' }); }
    catch (error) { fail(error); openPractice.disabled = false; }
  } });
  const meta = el('span', { text: 'Reading saved practice…' });
  const body = el('div', { class: 'th-body' }, [startPanel, el('p', { class: 'dim', text: 'Reading saved practice…' })]);
  replace(host, el('div', { class: 'th' }, [
    screenHeader({ title: track.title, meta: [meta], actions: { primary: newButton, secondary: [openPractice] } }),
    body,
  ]));

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
      replace(body, [startPanel, el('div', { class: 'th-empty card ui-inset ui-inset--roomy' }, ['The saved practice could not be read. ', error.message])]);
      return;
    }
    if (gone) return;
    const model = buildModel(home, list, practice.sessions || []);
    const graded = home.assessments.filter(a => a.structured);
    meta.textContent = [
      plural(model.mockCount, 'mock'),
      graded.length !== model.mockCount ? `${graded.length} graded` : null,
      model.practiceCount ? plural(model.practiceCount, 'practice session') : null,
    ].filter(Boolean).join(' · ');
    const learner = own(createLearnerSummary(discipline));
    replace(body, [
      startPanel,
      nextSession(graded, model),
      skillGrid(home.rubric, graded, model),
      problemSection(model),
      learner.root,
      notice,
    ]);
  })();

  /* ------------------------------------------------------------- model */

  function buildModel(home, list, sessions) {
    const problems = new Map();
    const problem = (slug, title, statement) => {
      const item = problems.get(slug) || { slug, title: null, statement: null, mocks: [], practice: [], last: 0, catalog: false };
      item.title ||= title || null; item.statement ||= statement || null;
      problems.set(slug, item); return item;
    };
    for (const p of home.problems) Object.assign(problem(p.slug, p.title, p.statement), { catalog: true, entry: p });
    const byId = new Map(home.assessments.map(a => [a.id, a]));
    for (const mock of list.interviews) {
      const assessment = byId.get(mock.id) || null;
      const item = problem(mock.slug, mock.title || assessment?.title, assessment?.statement);
      item.mocks.push({ ...mock, assessment });
      item.last = Math.max(item.last, time(mock.startedAt));
    }
    for (const session of sessions) {
      const item = problem(session.slug, session.title, session.statement);
      item.practice.push(session);
      item.last = Math.max(item.last, time(session.updatedAt));
    }
    for (const item of problems.values()) {
      item.mocks.sort((a, b) => time(b.startedAt) - time(a.startedAt));
      item.practice.sort((a, b) => time(b.updatedAt) - time(a.updatedAt));
      item.title ||= 'Untitled problem';
      item.preset = list.presetSlugs?.has(item.slug) || false;
    }
    const all = [...problems.values()];
    return {
      active: all.filter(p => p.mocks.length || p.practice.length).sort((a, b) => b.last - a.last),
      untried: all.filter(p => !p.mocks.length && !p.practice.length && p.catalog),
      mockCount: list.interviews.length,
      practiceCount: sessions.length,
      bySlug: problems,
      mockById: new Map(list.interviews.map(m => [m.id, m])),
    };
  }

  /* ------------------------------------------------------ next session */

  function nextSession(graded, model) {
    const source = graded.find(a => a.practice?.length);
    const card = el('section', { class: 'th-next card ui-inset ui-inset--roomy', 'aria-labelledby': 'th-next-title' });
    if (!source) {
      replace(card, [
        el('h2', { id: 'th-next-title', text: 'Next session' }),
        el('p', { class: 'dim', text: graded.length
          ? 'Your graded mocks did not record a practice suggestion.'
          : 'No graded mock yet. A mock gives you a rating on each skill and a specific thing to practise next.' }),
        graded.length ? null : el('div', { class: 'th-next-actions' }, [button({ label: 'Start a new mock', variant: 'secondary', onClick: () => newButton.click() })]),
      ]);
      return card;
    }
    const [first, ...rest] = source.practice;
    const mock = model.mockById.get(source.id);
    const title = model.bySlug.get(source.slug)?.title || source.title || 'your latest mock';
    const practise = button({ label: 'Practise this', variant: 'primary', onClick: async () => {
      practise.disabled = true;
      try { await startPracticeFromMock({ discipline, slug: source.slug, interviewId: source.id }); }
      catch (error) { fail(error); practise.disabled = false; }
    } });
    replace(card, [
      el('div', { class: 'th-next-eyebrow' }, [
        el('h2', { id: 'th-next-title', text: 'Next session' }),
        el('span', { class: 'dim', text: `From your latest graded mock: ${title}, ${relativeInterviewDate(time(source.date))}` }),
      ]),
      el('p', { class: 'th-next-drill', text: first.title }),
      first.why ? el('p', { class: 'th-next-why', text: first.why }) : null,
      first.fix ? el('p', { class: 'th-next-fix' }, [el('strong', { text: 'Try: ' }), first.fix]) : null,
      source.moveUp ? el('p', { class: 'th-next-moveup dim' }, [el('strong', { text: 'What would raise the grade: ' }), source.moveUp]) : null,
      el('div', { class: 'th-next-actions' }, [
        practise,
        mock ? button({ label: 'Open the report', variant: 'secondary', onClick: () => track.openInterview(mock) }) : null,
      ]),
      rest.length ? el('div', { class: 'th-next-more' }, [
        el('h3', { text: 'Also suggested' }),
        el('ul', {}, rest.map(item => el('li', {}, [el('strong', { text: item.title }), item.why ? el('span', { class: 'dim', text: item.why }) : null]))),
      ]) : null,
    ]);
    return card;
  }

  /* --------------------------------------------------------- skill grid */

  function skillGrid(rubric, graded, model) {
    const section = el('section', { class: 'th-skills card ui-inset ui-inset--roomy', 'aria-labelledby': 'th-skills-title' });
    const heading = el('div', { class: 'th-section-head' }, [el('h2', { id: 'th-skills-title', text: 'Skills' })]);
    if (!graded.length) {
      replace(section, [heading, el('p', { class: 'dim', text: `Each graded mock rates ${rubric.length} skills. None recorded yet.` })]);
      return section;
    }
    const columns = graded.slice(0, GRID_COLUMNS).reverse(); // oldest on the left
    const hidden = graded.length - columns.length;
    heading.append(el('span', { class: 'dim', text: graded.length === 1
      ? 'One graded mock so far, so this is a single reading, not a trend.'
      : `${plural(graded.length, 'graded mock')}${hidden ? `, latest ${columns.length} shown` : ''}. Oldest on the left.` }));
    const head = el('tr', {}, [
      el('th', { scope: 'col', class: 'th-skill-name' }, el('span', { class: 'th-sr', text: 'Skill' })),
      ...columns.map(a => {
        const mock = model.mockById.get(a.id);
        const label = `${model.bySlug.get(a.slug)?.title || a.title || 'Mock'}, ${shortDate(a.date)}`;
        return el('th', { scope: 'col' }, mock
          ? el('button', { class: 'btn btn--quiet th-col', type: 'button', 'aria-label': `Open ${label}`, onclick: () => track.openInterview(mock) }, shortDate(a.date))
          : el('span', { class: 'th-col', text: shortDate(a.date) }));
      }),
      el('th', { scope: 'col', class: 'th-latest', text: 'Latest' }),
    ]);
    const signalRow = el('tr', { class: 'th-signal-row' }, [
      el('th', { scope: 'row', class: 'th-skill-name', text: 'Overall' }),
      ...columns.map(a => el('td', {}, cell(a.signal, signalLabel(a.signal, a.reportDifficulty)))),
      el('td', { class: 'th-latest' }, latestBadge(graded[0].signal, signalLabel(graded[0].signal, graded[0].reportDifficulty))),
    ]);
    const rows = rubric.map(name => {
      const ratings = columns.map(a => a.dimensions.find(d => d.name === name)?.rating || null);
      const everRated = graded.map(a => a.dimensions.find(d => d.name === name)?.rating).filter(Boolean);
      const low = everRated.filter(r => r === 'Weak' || r === 'Mixed').length;
      const latest = graded.find(a => a.dimensions.find(d => d.name === name)?.rating);
      const latestRating = latest?.dimensions.find(d => d.name === name).rating || null;
      return el('tr', {}, [
        el('th', { scope: 'row', class: 'th-skill-name', text: name }),
        ...ratings.map(rating => el('td', {}, cell(rating, rating))),
        el('td', { class: 'th-latest' }, [
          latestBadge(latestRating, latestRating),
          everRated.length > 1 ? el('span', { class: 'th-tally dim', text: `${low} of ${everRated.length} weak or mixed` }) : null,
        ]),
      ]);
    });
    replace(section, [heading,
      el('div', { class: 'th-grid-scroll' }, el('table', { class: 'th-grid' }, [el('thead', {}, head), el('tbody', {}, [signalRow, ...rows])])),
      el('p', { class: 'th-legend dim' }, ['Ratings are the interviewer model’s judgement from each report. A dash means the report gave no evidence for that skill.']),
    ]);
    return section;
  }

  function cell(value, label) {
    if (!value) return el('span', { class: 'th-cell th-cell--none', 'aria-label': 'No evidence', text: '–' });
    const short = label.replace(/\s*\(Beginner\)$/, '').split(' ').map(w => w[0]).join('').toUpperCase();
    return el('span', { class: `th-cell th-cell--${ratingTone(value)}`, 'aria-label': label, text: short });
  }
  function latestBadge(value, label) {
    return value ? createBadge(label, ratingTone(value)) : el('span', { class: 'dim', text: 'No evidence' });
  }

  /* ----------------------------------------------------------- problems */

  function problemSection(model) {
    const section = el('section', { class: 'th-problems', 'aria-labelledby': 'th-problems-title' });
    const parts = [el('div', { class: 'th-section-head' }, [el('h2', { id: 'th-problems-title', text: 'Your problems' }),
      model.active.length ? el('span', { class: 'dim', text: 'Most recent first' }) : null])];
    parts.push(model.active.length
      ? el('div', { class: 'th-problem-list' }, model.active.map(problemRow))
      : el('p', { class: 'dim', text: 'Nothing practised yet.' }));
    if (model.untried.length) {
      parts.push(el('div', { class: 'th-section-head th-untried-head' }, [el('h2', { text: 'Not tried yet' })]),
        el('div', { class: 'th-problem-list' }, model.untried.map(problemRow)));
    }
    replace(section, parts);
    return section;
  }

  function problemRow(problem) {
    const latestMock = problem.mocks[0], latestPractice = problem.practice[0];
    const latestGraded = problem.mocks.find(m => m.assessment?.structured)?.assessment;
    const unfinished = problem.mocks.find(m => !m.debriefed);
    const detail = el('div', { class: 'th-problem-detail ui-stack', hidden: true, id: `th-detail-${problem.slug}` });

    let badge;
    if (unfinished) badge = createBadge('Unfinished mock', 'neutral');
    else if (latestGraded?.signal) badge = createBadge(signalLabel(latestGraded.signal, latestGraded.reportDifficulty), ratingTone(latestGraded.signal));
    else if (latestMock?.debriefed) badge = createBadge('Feedback, not graded', 'neutral');
    else if (problem.practice.length) badge = createBadge('Practised', 'accent');

    let primary = null;
    if (unfinished) primary = button({ label: 'Open mock', variant: 'secondary', onClick: () => track.openInterview(unfinished) });
    else if (latestPractice && time(latestPractice.updatedAt) > time(latestMock?.startedAt)) primary = el('a', { class: 'btn btn--secondary', href: practiceHref(latestPractice), text: 'Continue practice' });
    else if (latestMock) primary = button({ label: 'Review', variant: 'secondary', onClick: () => track.openInterview(latestMock) });

    const toggle = el('button', { class: 'btn btn--icon th-expand', type: 'button', 'aria-expanded': 'false', 'aria-controls': detail.id, 'aria-label': `More for ${problem.title}` }, icon('chevron', 15));
    toggle.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open; toggle.setAttribute('aria-expanded', String(open));
      if (open) fillDetail(detail, problem); else replace(detail, []);
    });

    // An untried problem's one action is to begin; the choice of how lives in its detail.
    if (!primary && problem.catalog) primary = button({ label: 'Mock it', variant: 'secondary', onClick: () => {
      if (detail.hidden) toggle.click();
      if (!detail.querySelector('.th-setup .ci-start, .th-setup button')) detail.querySelector('.th-mock')?.click();
    } });

    const counts = [problem.mocks.length ? plural(problem.mocks.length, 'mock') : null,
      problem.practice.length ? plural(problem.practice.length, 'practice session') : null,
      problem.last ? relativeInterviewDate(problem.last) : 'Not tried yet'].filter(Boolean);
    return el('article', { class: 'th-problem ui-inset', dataset: { slug: problem.slug } }, [
      el('div', { class: 'th-problem-head ui-cluster' }, [
        el('div', { class: 'ui-cluster-content ui-stack th-problem-copy' }, [
          el('div', { class: 'th-problem-title' }, [el('strong', { text: problem.title }), badge || null]),
          el('div', { class: 'ui-meta' }, counts.map(text => el('span', { text }))),
          latestGraded?.headline ? el('p', { class: 'th-headline', text: latestGraded.headline }) : null,
        ]),
        el('div', { class: 'th-problem-actions' }, [primary, toggle]),
      ]),
      detail,
    ]);
  }

  function fillDetail(detail, problem) {
    const setupHost = el('div', { class: 'th-setup' });
    const status = el('p', { class: 'th-notice', role: 'status' });
    let setup = null;
    const canMock = problem.catalog;
    const mockAgain = canMock ? button({ label: problem.mocks.length ? 'Mock it again' : 'Mock this problem', variant: 'secondary', className: 'th-mock', onClick: () => {
      if (setup) { setup.dispose(); setup = null; replace(setupHost, []); return; }
      setup = own(createInterviewSetup({ slug: problem.slug, title: problem.title, discipline,
        onCancel: () => { setup?.dispose(); setup = null; replace(setupHost, []); },
        onStart: state => track.startMock(problem.entry, state) }));
      replace(setupHost, setup.root);
      // Keep the result of the click beside the problem, including on small screens.
      setupHost.scrollIntoView({ block: 'nearest' });
    } }) : null;
    const practise = canMock ? button({ label: 'Practise untimed', variant: 'quiet', onClick: async () => {
      practise.disabled = true;
      try { await startPractice({ ...problem.entry, discipline }); }
      catch (error) { status.textContent = error.message; practise.disabled = false; }
    } }) : null;
    const notes = button({ label: 'Learning notes', variant: 'quiet', onClick: () => openLearningNotes(problem.slug, problem.title) });

    const history = [
      ...problem.mocks.map(mock => ({ at: time(mock.startedAt), node: historyRow({
        label: 'Mock', when: mock.startedAt,
        state: !mock.debriefed ? 'Unfinished' : mock.assessment?.signal ? signalLabel(mock.assessment.signal, mock.assessment.reportDifficulty) : 'Feedback, not graded',
        tone: mock.assessment?.signal ? ratingTone(mock.assessment.signal) : 'neutral',
        text: mock.assessment?.headline || null,
        action: button({ label: mock.debriefed ? 'Review' : 'Open', variant: 'quiet', onClick: () => track.openInterview(mock) }),
        extra: mock.debriefed ? button({ label: 'Practise from it', variant: 'quiet', onClick: async event => {
          event.currentTarget.disabled = true;
          try { await startPracticeFromMock({ discipline, slug: problem.slug, interviewId: mock.id }); }
          catch (error) { status.textContent = error.message; }
        } }) : null,
      }) })),
      ...problem.practice.map(session => ({ at: time(session.updatedAt), node: historyRow({
        label: session.source ? 'Practice from a mock' : 'Practice', when: session.updatedAt, state: null, text: null,
        action: el('a', { class: 'btn btn--quiet', href: practiceHref(session), text: 'Continue' }),
      }) })),
    ].sort((a, b) => b.at - a.at).map(x => x.node);

    replace(detail, [
      problem.statement ? el('p', { class: 'th-statement', text: problem.statement }) : null,
      history.length ? el('div', { class: 'th-history' }, history) : null,
      el('div', { class: 'th-detail-actions' }, [mockAgain, practise, notes]),
      setupHost, status,
    ]);
  }

  function historyRow({ label, when, state, tone = 'neutral', text, action, extra = null }) {
    return el('div', { class: 'th-history-row ui-row' }, [
      el('div', { class: 'ui-row-content th-history-copy' }, [
        el('div', { class: 'th-history-title' }, [el('span', { text: label }), el('span', { class: 'dim', text: relativeInterviewDate(time(when)) }), state ? createBadge(state, tone) : null]),
        text ? el('span', { class: 'dim th-history-text', text }) : null,
      ]),
      el('div', { class: 'ui-row-trailing th-history-actions' }, [extra, action]),
    ]);
  }

  return { destroy() { gone = true; for (const dispose of disposers) dispose(); } };
}
