// The case list a learner sees: LeetCode's examples first, then the cases they (or the
// tutor) added. Shared by the testcases routes and the tutor's case tools, so "Case 3"
// means the same case in the panel, in a tutor tool call, and in a run.
//
// Everything here works from an already-loaded problem ({ metaData, exampleTestcases,
// descriptionHtml, pythonStub }); where that came from (network-backed cache for the
// routes, cache-only for the tutor) is the caller's business.

import { classifyProblem } from './meta.mjs';
import { buildCases } from './testcases.mjs';
import { neetcodeExpectedHtml } from '../neetcode.mjs';
import { linesPerCase, whyNotRunnable } from './cases.mjs';

/**
 * The examples and the problem's shape, exactly as GET /api/problems/:slug/testcases
 * reports them. Deliberately the same `buildCases` the runner calls, so the list shown is
 * the list executed.
 *
 * @returns {{runnable:false, reason:string} |
 *   {runnable:true, examples:Array, params:string[], perCase:number, shape:object, reason?:string}}
 */
export function problemCases(problem, slug) {
  const shape = classifyProblem(problem.metaData, { pythonStub: problem.pythonStub, slug });
  if (shape.kind === 'unsupported') return { runnable: false, reason: shape.message };

  const perCase = linesPerCase(shape);
  const built = buildCases({
    perCase,
    testcases: problem.exampleTestcases,
    descriptionHtml: problem.metaData?.neetcode ? neetcodeExpectedHtml(problem.metaData) : problem.descriptionHtml,
    // So the Expected box shows the same value the run will compare against, rather than
    // LeetCode's prose form of it.
    prefixExpected: shape.answerFrom?.sizeFromReturn === true,
  });
  const examples = built.ok
    ? built.cases.map((c, index) => ({
      index,
      input: c.input ?? null,
      // Absent rather than guessed: LeetCode publishes expected outputs only inside the
      // description prose, and some problems simply do not have one to scrape.
      expected: c.expected ?? null,
      source: 'example',
    }))
    : [];
  return {
    runnable: true,
    examples,
    // The parameter names, so the editor can label the boxes the way the signature does
    // instead of calling them "line 1" and "line 2".
    params: shape.kind === 'design' ? ['calls', 'arguments'] : shape.params.map((p) => p.name ?? p),
    perCase,
    shape,
    ...(built.ok ? {} : { reason: built.message }),
  };
}

/**
 * Why this list of added cases cannot be saved for this problem, or null if it can.
 * Refused where it was typed, with the reason, rather than accepted and failed later as a
 * confusing grouping error across the whole run.
 */
export function whyCasesRejected(problem, slug, cases) {
  if (!problem) return null;
  const shape = classifyProblem(problem.metaData, { pythonStub: problem.pythonStub, slug });
  if (shape.kind === 'unsupported') return null;
  const perCase = linesPerCase(shape);
  for (const [i, c] of cases.entries()) {
    const why = whyNotRunnable(c?.input ?? '', perCase);
    if (why) return `Case ${i + 1}: ${why}`;
  }
  return null;
}
