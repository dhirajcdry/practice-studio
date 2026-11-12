// The read-only summary behind the LLD and System Design home pages.
//
// Everything here is derived on read from records the profile reader already
// validates. Nothing is stored, nothing is inferred: a mock without a structured
// report says so, a skill without evidence has no rating, and the page never
// receives a number it would have to explain away.
import { readLearnerProfile } from './profile.mjs';
import { listProblems, publicProblem } from './selection.mjs';
import { DESIGN_DIMENSIONS, LLD_DIMENSIONS } from '../interview/report.mjs';

export const TRACK_RUBRICS = { lld: LLD_DIMENSIONS, design: DESIGN_DIMENSIONS };

const time = value => typeof value === 'number' ? value : Date.parse(value) || 0;

export async function readTrackHome(root, discipline) {
  if (!TRACK_RUBRICS[discipline]) throw Error('Invalid track.');
  const [profile, problems] = await Promise.all([
    readLearnerProfile(root, { discipline, fullEvidence: true }),
    listProblems(root, discipline),
  ]);
  const assessments = profile.assessments
    .filter(a => a.discipline === discipline)
    .map(a => ({
      id: a.id, slug: a.slug, title: a.title, statement: a.statement, date: a.date,
      structured: a.evidenceStatus === 'recorded',
      signal: a.signal, headline: a.headline || null, summary: a.summary, moveUp: a.moveUp || null,
      reportDifficulty: a.reportDifficulty || null, targetLevel: a.targetLevel,
      // Only a rating backed by evidence counts; the parser already nulls the rest.
      dimensions: a.dimensions.map(d => ({ name: d.name, rating: d.rating, summary: d.summary || null })),
      practice: a.practice,
    }))
    .sort((a, b) => time(b.date) - time(a.date));
  return {
    discipline,
    rubric: TRACK_RUBRICS[discipline],
    assessments,
    problems: problems.map(publicProblem),
    warnings: profile.warnings,
  };
}
