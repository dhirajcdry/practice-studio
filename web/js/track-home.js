// The home page shared by Low-level design and System design.
//
// Two boxes and a list, and nothing else:
//   Practise   no clock, no grade. Pick a problem (or bring your own) and start.
//   Mock       a timed interview that ends with a score. Pick a problem (or be surprised),
//              choose the settings, begin.
//   What you've done   every mock and practice session, newest first, with its score if
//              it has one. A row opens it.
//
// Everything comes from saved records (GET /api/track-home plus the track's own interview
// and practice lists). A page visit never starts a model turn, and a session without a
// score shows none rather than a made-up one.
import { el, replace } from './dom.js';
import { screenHeader } from './ui/headers.js';
import { button } from './ui/button.js';
import { createInterviewSetup } from './interview.js';
import { relativeInterviewDate, ratingTone, signalLabel } from './interview-format.js';
import { startPractice, startPracticeFromMock, practiceHref } from './practice.js';

const PICKS = 3;   // suggested problems shown in each box
const RECENT = 6;  // sessions listed before "Show all"
const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;

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
 *   loadInterviews(): Promise<{ interviews: [{ id, slug, title, startedAt, debriefed }] }>,
 *   openInterview(item),
 *   startMock(problem | null, setupState)   null means "choose one for me"
 * }
 */
export function mountTrackHome(host, track) {
  let gone = false;
  const { discipline } = track;
  const notice = el('p', { class: 'th-notice', role: 'status' });
  const fail = error => { if (!gone) notice.textContent = error.message; };

  /* A short list where exactly one row is chosen. The first row is the open option. */
  function picker({ name, open }) {
    let pool = [], offset = 0, chosen = null;
    const list = el('div', { class: 'th-picks', role: 'group', 'aria-label': `${name} problem` });
    const others = button({ label: 'Show others', variant: 'quiet', className: 'th-others', onClick: () => {
      offset = (offset + PICKS) % pool.length; chosen = null; paint();
    } });
    others.hidden = true;
    const row = (problem, label, hint) => el('button', { class: 'ui-action-row th-pick', type: 'button',
      'aria-pressed': String(chosen === problem), dataset: problem ? { slug: problem.slug } : {},
      onclick: () => { chosen = problem; paint(); } }, [
      el('span', { class: 'th-radio', 'aria-hidden': 'true' }),
      el('span', { class: 'th-pick-title th-clip', text: label }),
      hint ? el('span', { class: 'th-pick-hint', text: hint }) : null,
    ]);
    function paint() {
      const shown = Array.from({ length: Math.min(PICKS, pool.length) }, (_, i) => pool[(offset + i) % pool.length]);
      others.hidden = pool.length <= PICKS;
      replace(list, [row(null, open), ...shown.map(p => row(p, p.title, p.hint))]);
    }
    paint();
    return { list, others, get value() { return chosen; }, set(items) { pool = items; paint(); } };
  }

  const practisePick = picker({ name: 'Practice', open: 'Anything, bring your own problem' });
  const mockPick = picker({ name: 'Mock', open: 'Surprise me with a fresh problem' });

  const practise = button({ label: 'Start practising', variant: 'secondary', size: 'lg', className: 'th-practice', onClick: async () => {
    practise.disabled = true;
    const problem = practisePick.value;
    try { await startPractice(problem ? { ...problem.entry, discipline } : { discipline, title: 'Open practice', statement: '' }); }
    catch (error) { fail(error); practise.disabled = false; }
  } });
  const setup = createInterviewSetup({ slug: `${discipline}-new-mock`, discipline, label: 'Mock settings', startLabel: 'Start mock',
    onStart: state => {
      const problem = mockPick.value;
      return track.startMock(problem?.entry || null, problem ? { ...state, slug: problem.slug, title: problem.title } : state);
    } });

  const box = (kind, title, text, pick, foot) => el('section', { class: `th-box th-box--${kind}`, 'aria-labelledby': `th-${kind}-title` }, [
    el('div', { class: 'th-box-body' }, [
      el('div', { class: 'th-box-head' }, [el('h2', { id: `th-${kind}-title`, text: title }), pick.others]),
      el('p', { class: 'th-box-text', text }),
      pick.list,
    ]),
    foot,
  ]);
  const recent = el('section', { class: 'th-recent', 'aria-labelledby': 'th-recent-title' }, [
    el('h2', { id: 'th-recent-title', text: 'What you’ve done' }), el('p', { class: 'th-quiet', text: 'Reading saved practice…' }),
  ]);
  host.classList.add('th-host');
  replace(host, el('div', { class: 'th' }, [
    screenHeader({ title: track.title }),
    el('div', { class: 'th-wrap' }, [
      el('div', { class: 'th-pair' }, [
        box('practise', 'Practise', 'No clock and no grade. Work through a problem with the coach beside you.', practisePick,
          el('div', { class: 'th-box-foot' }, [practise])),
        box('mock', 'Mock', 'A timed interview that ends with a score and a report.', mockPick, setup.root),
      ]),
      recent, notice,
    ]),
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
      if (!gone) replace(recent, [el('h2', { id: 'th-recent-title', text: 'What you’ve done' }), el('p', { class: 'th-quiet', text: error.message })]);
      return;
    }
    if (gone) return;
    const sessions = practice.sessions || [];
    const assessed = new Map(home.assessments.map(a => [a.id, a]));
    const titles = new Map(home.problems.map(p => [p.slug, p.title]));
    for (const a of home.assessments) if (!titles.has(a.slug) && a.title) titles.set(a.slug, a.title);

    // Suggestions come from the catalog. A mock suggests what you have not sat yet;
    // practice suggests what you have, so you can go back over it.
    const lastMock = new Map(), open = new Set();
    for (const mock of list.interviews) {
      lastMock.set(mock.slug, Math.max(lastMock.get(mock.slug) || 0, time(mock.startedAt)));
      if (!mock.debriefed) open.add(mock.slug);
    }
    const catalog = home.problems.map(entry => ({ slug: entry.slug, title: entry.title || 'Untitled problem', entry, at: lastMock.get(entry.slug) || 0 }));
    mockPick.set(catalog.filter(p => !open.has(p.slug)).sort((a, b) => a.at - b.at)
      .map(p => ({ ...p, hint: p.at ? `Mocked ${relativeInterviewDate(p.at).replace(/^(Today|Yesterday)/, word => word.toLowerCase())}` : 'New' })));
    practisePick.set([...catalog].sort((a, b) => b.at - a.at).map(p => ({ ...p, hint: p.at ? 'Mocked' : null })));

    const items = [
      ...list.interviews.map(mock => ({ kind: 'Mock', slug: mock.slug, at: time(mock.startedAt), mock, assessment: assessed.get(mock.id) || null,
        title: titles.get(mock.slug) || mock.title || 'Mock' })),
      ...sessions.map(session => ({ kind: 'Practice', slug: session.slug, at: time(session.updatedAt), session,
        title: session.title || titles.get(session.slug) || 'Practice' })),
    ].sort((a, b) => b.at - a.at);
    paintRecent(items, false);
  })();

  function paintRecent(items, all) {
    const shown = all ? items : items.slice(0, RECENT);
    replace(recent, [
      el('h2', { id: 'th-recent-title', text: 'What you’ve done' }),
      items.length ? el('ul', { class: 'th-list' }, shown.map(sessionRow))
        : el('p', { class: 'th-quiet', text: 'Nothing yet. Your mocks and practice sessions will be listed here.' }),
      items.length > shown.length ? button({ label: `Show all ${items.length}`, variant: 'quiet', className: 'th-all', onClick: () => paintRecent(items, true) }) : null,
    ]);
  }

  function sessionRow(item) {
    const { mock, assessment } = item;
    const score = !mock ? null
      : !mock.debriefed ? el('span', { class: 'th-pill', text: 'Unfinished' })
        : assessment?.signal ? el('span', { class: `th-pill th-pill--${ratingTone(assessment.signal)}`, text: signalLabel(assessment.signal, assessment.reportDifficulty) })
          : null;
    const cells = [
      el('span', { class: 'th-item-title th-clip', text: item.title }),
      el('span', { class: 'th-item-kind', text: item.kind }),
      el('span', { class: 'th-item-score' }, score),
      el('span', { class: 'th-item-date', text: relativeInterviewDate(item.at) }),
    ];
    const main = mock
      ? el('button', { class: 'ui-action-row th-item-open', type: 'button', onclick: () => track.openInterview(mock) }, cells)
      : el('a', { class: 'ui-action-row th-item-open', href: practiceHref(item.session) }, cells);
    // After a finished mock, the useful next step is to go back over it untimed.
    const again = mock?.debriefed ? button({ label: 'Practise it', variant: 'quiet', className: 'th-again', onClick: async event => {
      const control = event.currentTarget; control.disabled = true;
      try { await startPracticeFromMock({ discipline, slug: item.slug, interviewId: mock.id }); }
      catch (error) { fail(error); control.disabled = false; }
    } }) : null;
    return el('li', { class: 'th-item', dataset: { slug: item.slug || '', kind: item.kind.toLowerCase() } }, [main, again]);
  }

  return { destroy() { gone = true; host.classList.remove('th-host'); setup.dispose(); } };
}
