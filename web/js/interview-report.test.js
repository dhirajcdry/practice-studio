// Browser regressions: run by web/tests.html and the scratch interview check.
import { renderReport, attachMomentQuotes, defaultDimensionIndex, dimensionQuestion } from './interview-report.js';

export function checkReportLayout(check) {
  const facts = { durationMs: 100000, plannedMs: 1800000, mode: 'typed', hints: [], runs: [], verdicts: [], phases: [], candidateTurns: 0, finalCode: '' };
  const judgement = { signal: 'Lean hire', headline: '', dimensions: [], strengths: [], improvements: ['Older advice'], moments: [], practice: [{ fix: null, at: null, title: 'Legacy drill', why: 'Reason' }] };
  const render = j => renderReport({ title: 'Fixture', record: {}, report: { facts, judgement: { ...judgement, ...j } } });
  const old = render({});
  check('legacy practice keeps its title, reason and improvements without a duplicate drill line',
    old.querySelector('.rp-practice h4').textContent === 'Legacy drill' && old.textContent.includes('Reason') && old.textContent.includes('Older advice') && !old.querySelector('.rp-drill') && !old.querySelector('.rp-practice .rp-time'));
  const modern = render({ practice: Array.from({ length: 4 }, (_, i) => ({ fix: `Fix ${i}`, at: i === 0 ? 0 : null, title: `Drill ${i}`, why: 'Reason' })) });
  check('modern practice caps three fixes, preserves time zero and removes duplicate improvements', modern.querySelectorAll('.rp-practice li').length === 3 && modern.querySelector('.rp-practice .rp-time').textContent === '0:00' && modern.querySelectorAll('.rp-drill').length === 3 && !modern.textContent.includes('Older advice'));
  const quotes = attachMomentQuotes([{ at: 0 }, { at: 120000 }, { at: 120001 }, { at: null }], [{ evidence: [{ at: 60000, quote: 'Boundary' }, { at: 60000, quote: 'Boundary' }, { at: 60000, quote: 'Second' }, { at: null, quote: 'Untimed' }] }]);
  check('moments attach the first quote within 60 seconds inclusively and each distinct quote only once', quotes[0].evidence?.quote === 'Boundary' && quotes[1].evidence?.quote === 'Second' && quotes[2].evidence === null && quotes[3].evidence === null);
  check('default dimension prefers Weak then Mixed then first, including unrated data', defaultDimensionIndex([{ rating: 'Mixed' }, { rating: 'Weak' }]) === 1 && defaultDimensionIndex([{ rating: 'Solid' }, { rating: 'Mixed' }]) === 1 && defaultDimensionIndex([{ rating: null }, { rating: 'Solid' }]) === 0);
  for (const count of [4, 7, 9]) {
    const body = render({ dimensions: Array.from({ length: count }, (_, i) => ({ name: `Dimension ${i}`, rating: i === count - 1 ? 'Weak' : null, summary: `Summary ${i}`, evidence: [] })) });
    const rows = [...body.querySelectorAll('.rp-dim-row')];
    check(`${count} dimensions select the weakest and update detail without rebuilding the rows`, rows.length === count && rows.at(-1).getAttribute('aria-pressed') === 'true' && (() => { rows[0].click(); return rows[0].getAttribute('aria-pressed') === 'true' && rows.at(-1).getAttribute('aria-pressed') === 'false' && body.querySelector('.rp-dim h4').textContent === 'Dimension 0'; })());
  }
  check('old prose debrief remains readable', renderReport({ title: 'Old', record: {}, report: { facts, judgement: null }, debriefText: 'Original written feedback.' }).textContent.includes('Original written feedback.'));

  // System design: the board and the phase bar come from the record, and say plainly what is missing.
  const designFacts = { ...facts, durationMs: 600000, finalBoard: null, phases: [
    { phase: 'requirements', ms: 240000 }, { phase: 'entities', ms: 120000 }, { phase: 'api', ms: null },
    { phase: 'estimates', ms: null }, { phase: 'design', ms: null }, { phase: 'deepdive', ms: null }, { phase: 'bottlenecks', ms: null }] };
  const design = board => renderReport({ title: 'Design', record: { discipline: 'design' }, report: { facts: designFacts, judgement: { ...judgement, practice: [] } }, board });
  const empty = design([{ id: 'gone', type: 'rectangle', isDeleted: true }]);
  const stats = [...empty.querySelectorAll('.rp-stat')].map(s => s.textContent);
  check('an empty design board says so in the stat and in its own section', stats.some(s => s === 'BoardEmpty') && empty.querySelector('.rp-board-section')?.textContent.includes('The board was empty.') && !empty.querySelector('.rp-board') && !empty.textContent.includes('Semantic graph'));
  const drawn = design([{ id: 'box', type: 'rectangle', x: 0, y: 0, width: 80, height: 40 }]);
  check('a drawn design board is named Drawn and gets a Final board figure', [...drawn.querySelectorAll('.rp-stat')].some(s => s.textContent === 'BoardDrawn') && Boolean(drawn.querySelector('.rp-board-section .rp-board')) && !drawn.querySelector('.rp-solution'));
  const legend = empty.querySelector('.rp-legend')?.textContent || '';
  check('design phases use their own labels, show unplaced time and list unrecorded phases', legend.includes('Requirements 4 min') && legend.includes('Entities 2 min') && legend.includes('No phase recorded 4 min') && legend.includes('Not recorded: API, Estimates, Design, Deep dive, Bottlenecks') && empty.querySelectorAll('.rp-seg').length === 3);
  check('LLD and design dimensions ask their own questions', dimensionQuestion({ name: 'State modeling' }, 'lld').includes('states and transitions') && dimensionQuestion({ name: 'Estimation' }, 'design').includes('estimated the scale')
    && dimensionQuestion({ name: 'Requirements' }, 'lld') !== dimensionQuestion({ name: 'Requirements' }, 'design') && dimensionQuestion({ name: 'Coding' }).startsWith('What should I change')
    && [...LLD, ...DESIGN].every(([name, discipline]) => !dimensionQuestion({ name }, discipline).includes('What would a strong answer have looked like here?')));
}
const LLD = ['Requirements', 'Responsibilities', 'OOP fundamentals', 'Interfaces', 'State modeling', 'Correctness', 'Edge cases', 'Self-verification', 'Extensibility', 'Communication'].map(name => [name, 'lld']);
const DESIGN = ['Requirements', 'Estimation', 'Data modeling', 'Architecture', 'Trade-offs', 'Reliability', 'Communication'].map(name => [name, 'design']);
