// The pure half of the LLD and System design home (web/js/track-home.js).
//
// Everything here is shaped from saved records only: the track's interview list, its
// practice sessions and GET /api/track-home. Nothing is averaged, scored or guessed. A
// count that is zero or unknown is left out, a mock without a structured report has no
// signal, and a skill without an evidence-backed rating says so.
import { signalLabel } from './interview-format.js';

// With no library problem chosen, each way in starts on one of these.
export const SURPRISE = 'surprise';   // a problem Studio prepares, one you have not seen
export const OWN = 'own';             // a brief you write yourself
export const TREND = 5;               // finished mocks drawn in each skill's marks
const DAY = 86400000;

export const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const startOfDay = at => { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "today", "yesterday", "3 days ago", then a short date. Lower case, for use mid-sentence. */
export function ago(at, now = Date.now()) {
  if (!at) return '';
  const days = Math.round((startOfDay(now) - startOfDay(at)) / DAY);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  const date = new Date(at);
  return date.toLocaleDateString([], { month: 'short', day: 'numeric', ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: 'numeric' } : {}) });
}
/** "today 12:56", "yesterday 09:10", else as ago(). For the Continue band. */
export function agoWithTime(at, now = Date.now()) {
  const day = ago(at, now);
  if (day !== 'today' && day !== 'yesterday') return day;
  return `${day} ${new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

/**
 * Every mock and practice session as one list, newest first.
 * @returns [{ kind: 'mock'|'practice', key, slug, title, at, finished, mock?, session?, assessment? }]
 */
export function buildSessions({ interviews = [], sessions = [], assessments = [], problems = [] }) {
  const assessed = new Map(assessments.map(a => [a.id, a]));
  const titles = new Map(problems.map(p => [p.slug, p.title]));
  for (const a of assessments) if (a.slug && !titles.has(a.slug) && a.title) titles.set(a.slug, a.title);
  return [
    ...interviews.map(mock => ({ kind: 'mock', key: `mock:${mock.id}`, slug: mock.slug || null, at: time(mock.startedAt), finished: Boolean(mock.debriefed),
      mock, assessment: assessed.get(mock.id) || null, title: titles.get(mock.slug) || mock.title || 'Mock' })),
    ...sessions.map(session => ({ kind: 'practice', key: `practice:${session.id}`, slug: session.slug || null, at: time(session.updatedAt), finished: false,
      session, title: session.title || titles.get(session.slug) || 'Practice' })),
  ].sort((a, b) => b.at - a.at);
}

/** The signal as display text, or '' when the mock has none on record. */
export const signalText = item => item.assessment?.signal ? signalLabel(item.assessment.signal, item.assessment.reportDifficulty) : '';

/** What to pick up: the newest unfinished mock, else the latest practice session, else null. */
export function continueItem(items) {
  return items.find(item => item.kind === 'mock' && !item.finished) || items.find(item => item.kind === 'practice') || null;
}

/** One line per catalog problem, built only from its records. */
export function statusLine(slug, items, now = Date.now()) {
  const mine = items.filter(item => item.slug === slug);
  const mocks = mine.filter(item => item.kind === 'mock'), practice = mine.filter(item => item.kind === 'practice');
  const open = mocks.find(item => !item.finished);
  if (open) return `Mock unfinished · started ${ago(open.at, now)}`;
  if (mocks.length) {
    const last = mocks[0], signal = signalText(last);
    return [`Mocked ${plural(mocks.length, 'time')}`, signal ? `last: ${signal}` : null, ago(last.at, now)].filter(Boolean).join(' · ');
  }
  if (practice.length > 1) return `Practised ${practice.length} times · last ${ago(practice[0].at, now)}`;
  if (practice.length) return `Practised ${ago(practice[0].at, now)}`;
  return 'Not tried yet';
}

/**
 * What a way in can start on when no library problem is chosen, Surprise me first (the
 * default). A mock on your own brief exists only where the track can run one: system
 * design takes any prompt, while an LLD mock needs a prepared scenario with private facts.
 */
export function problemChoices(kind, { ownMock = false } = {}) {
  return [{ id: SURPRISE, label: 'Surprise me' }, ...(kind === 'practise' || ownMock ? [{ id: OWN, label: 'My own problem' }] : [])];
}

/**
 * The settings a practice session really honours. Answer mode and the coach model always;
 * the target level only where it changes something: system design practice coaches to the
 * saved level, and a surprise problem is prepared for it. Practice has no clock.
 */
export function practiceSettings(discipline, { chosen = false, choice = SURPRISE } = {}) {
  return ['mode', ...(discipline === 'design' || (!chosen && choice === SURPRISE) ? ['level'] : []), 'model'];
}

/** A short name for a brief: its first line, cut at a word near 80 characters. */
export function briefTitle(text, max = 80) {
  const line = String(text || '').trim().split(/\r?\n/)[0].trim().replace(/\s+/g, ' ');
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1), space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, '')}…`;
}

/** The quiet line under the title. Zero or unknown parts are left out. */
export function headerSummary(problems, items, now = Date.now()) {
  const mocks = items.filter(item => item.kind === 'mock');
  const finished = mocks.filter(item => item.finished).length, open = mocks.length - finished;
  const practice = items.length - mocks.length;
  const newest = items.find(item => item.at)?.at;
  return [
    problems.length ? plural(problems.length, 'problem') : null,
    finished ? `${plural(finished, 'mock')} finished` : null,
    open ? `${open} unfinished` : null,
    practice ? plural(practice, 'practice session') : null,
    newest ? `last session ${ago(newest, now)}` : null,
  ].filter(Boolean).join(' · ');
}

/**
 * Where you stand, one row per rubric skill.
 * `latest` is the newest evidence-backed rating across every structured report; `marks`
 * are the last TREND structured reports, oldest to newest, with null where that report
 * gave no evidence-backed rating. `lead` is the newest structured report, for its headline.
 */
export function dimensionTrend(rubric = [], assessments = []) {
  const reports = assessments.filter(a => a.structured).sort((a, b) => time(b.date) - time(a.date));
  const recent = reports.slice(0, TREND).reverse();
  const rate = (report, name) => report.dimensions?.find(d => d.name === name) || null;
  return {
    lead: reports[0] || null,
    reports: recent.length,
    rows: rubric.map(name => {
      const found = reports.map(report => ({ report, dim: rate(report, name) })).find(x => x.dim?.rating);
      return {
        name,
        latest: found ? { rating: found.dim.rating, summary: found.dim.summary || null, date: found.report.date, title: found.report.title || null } : null,
        marks: recent.map(report => ({ rating: rate(report, name)?.rating || null, date: report.date, title: report.title || null })),
      };
    }),
  };
}

/** The History filter. */
export const filterSessions = (items, filter) => filter === 'mocks' ? items.filter(i => i.kind === 'mock')
  : filter === 'practice' ? items.filter(i => i.kind === 'practice') : items;
