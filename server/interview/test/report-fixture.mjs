// A realistic interviewer report for fake CLIs and visual fixtures. Quotes must match
// what the fixture candidate actually said, or the report marks them unverified.
export function fixtureReport(quote = 'I will use a map.') {
  return JSON.stringify({
    signal: 'Lean hire',
    headline: 'Found the linear idea quickly but tested only after a hint.',
    summary: 'You moved from brute force to a single pass on your own and explained the invariant clearly. Testing came late and only after prompting, and the edge case of a zero at the start was missed until the run failed.',
    moveUp: 'Proposing the single-element and leading-zero cases before the first run would have made this a Hire.',
    dimensions: [
      { name: 'Problem solving', rating: 'Strong', summary: 'Reached the greedy invariant without help.', evidence: [{ at: '00:30', quote, note: 'States the invariant before coding.' }] },
      { name: 'Coding', rating: 'Solid', summary: 'Clean single loop; one off-by-one fixed after a run.', evidence: [{ at: '06:10', quote: '', note: 'Fixed the loop bound after the failing run at 05:40.' }] },
      { name: 'Communication', rating: 'Solid', summary: 'Narrated decisions, went quiet while debugging.', evidence: [{ at: '00:30', quote, note: '' }] },
      { name: 'Testing', rating: 'Weak', summary: 'No cases proposed before running.', evidence: [] },
    ],
    strengths: ['Named the greedy invariant before writing code.', 'Recovered from the failing run without a hint.'],
    improvements: ['Propose two edge cases (single element, leading zero) before the first run.', 'Keep talking while debugging so the interviewer can follow.'],
    moments: [
      { at: '00:30', kind: 'insight', text: 'Proposed tracking the furthest reachable index.' },
      { at: '03:20', kind: 'hint', text: 'Nudged to state complexity.' },
      { at: '05:40', kind: 'bug', text: 'Run failed on [0].' },
      { at: '06:10', kind: 'fix', text: 'Corrected the loop bound.' },
      { at: '08:00', kind: 'verdict', text: 'Accepted on first submit.' },
    ],
    code: { complexity: 'O(n) time · O(1) space', optimal: 'O(n) time · O(1) space', notes: ['Early return when the reach covers the last index would save a pass.'] },
    practice: [
      { title: 'Write 3 edge cases before every first run', why: 'Testing was rated Weak and the [0] case surfaced only from a failing run.' },
      { title: 'Jump Game II under a 20-minute timer', why: 'Same invariant, adds counting — checks the idea transfers.' },
      { title: 'Narrate while debugging', why: 'You went silent for over a minute after the failing run.' },
    ],
  });
}
