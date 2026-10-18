// Synthetic judge records for demo mode and browser checks. Never sent to a judge.
export const detailsFixture = {
  runtime: { display: '23 ms', ms: 23, percentile: 44, unit: 'ms', distribution: [{ bucket: 12, label: '12', pct: 20 }, { bucket: 23, label: '23', pct: 45 }, { bucket: 34, label: '34', pct: 35 }] },
  memory: { display: '20.1 MB', mb: 20.1, percentile: 55, unit: 'KB', distribution: [{ bucket: 20480, label: '20480', pct: 30 }, { bucket: 20582, label: '20582', pct: 40 }, { bucket: 21504, label: '21504', pct: 30 }] },
};
export function submissionFixtures() {
  return [
    { submissionId: '3', at: '2026-10-18T09:05:00Z', source: 'studio', verdict: 'Accepted', accepted: true, runtimeMs: 23, beatsRuntimePct: 44, memoryMb: 20.1, beatsMemoryPct: 55, testsPassed: 178, testsTotal: 178, code: 'class Solution:\n    def solve(self):\n        return 1\n', failure: null, details: structuredClone(detailsFixture), hasDetails: true, leadUp: { minutes: 12, localRuns: 8, coachAsks: 1 } },
    { submissionId: '2', at: '2026-10-18T08:55:00Z', source: 'studio', verdict: 'Time Limit Exceeded', accepted: false, testsPassed: 79, testsTotal: 178, code: 'while True:\n    pass\n', failure: { kind: 'time_limit', lastTestcase: '[1,2,3]\n6', expectedOutput: '3', output: 'null' }, details: null, hasDetails: false, leadUp: null },
    { submissionId: '1', at: '2026-10-17T08:00:00Z', source: 'studio', verdict: 'Wrong Answer', accepted: false, code: null, failure: null, details: null, hasDetails: false, leadUp: null },
    { submissionId: 'nc-1', at: '2026-10-16T08:00:00Z', source: 'neetcode', verdict: 'Accepted', accepted: true, testsPassed: 10, testsTotal: 10, code: 'return True', failure: null, details: null, hasDetails: false, leadUp: null },
  ];
}
