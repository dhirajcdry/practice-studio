// Synthetic transcript with the same prose/whitespace shape as a real voice turn.
export const conversationTurns = [
  { kind: 'opening', elapsedMs: 3420000, asked: "Let's focus on the authorization change: without a background job, how would spendable balance account for an authorization that passed 15 minutes ago?\n\n\n" },
  { kind: 'candidate', elapsedMs: 3480000, said: 'I did not understand what the requirement is. Could you clarify it?' },
  { kind: 'turn', elapsedMs: 3480000, asked: 'At a restaurant, checkout can authorize 1,000 cents, then capture up to that amount once the tip is known and release the rest. If nothing is captured within **15 minutes**, the hold lapses.\n\nHow would `get_balance` treat a lapsed hold if nothing runs in the background?\n\n\n' },
];

export const formattedReply = '### Keep the invariant explicit\n\nCompute **available funds** when `get_balance` is called.\n\n- Ignore expired holds.\n- Preserve ownership when a hold is captured.\n\n```python\nremaining = total - sum(hold.amount for hold in active_holds if hold.expires_at > now)\n```\n\nWhich boundary would you test first?\n\n';

// Long saved feedback exercises typography and the scrolled reading boundary.
export const mockFeedback = [
  '## Requirements — Mixed\n\nThe candidate clarified capacity and ownership, but assumed how expiry works instead of asking.\n\n- 04:52 “Should I assign the resource to the next party?” — A concrete example tested the selection policy.\n- 18:33 The candidate assumed a thirty-minute hold; the interviewer corrected it to ten minutes.',
  '## Responsibilities — Mixed\n\nThe split between the resource and reservation manager was reasonable. Ownership remained unclear.\n\n- 11:03 The candidate identified the core entities without a prompt.\n- 27:21 Behaviour was still being assigned when the interviewer asked for final classes.',
  '## Interfaces — Weak\n\nThe signatures do not carry the agreed contract: reserve returns nothing and release has no time input.\n\n- Validate ownership before updating state.\n- Return an explicit reservation identity.',
  '## State modelling — Mixed\n\nMake expiry and cancellation observable in the same model.\n\n1. Reserve an available resource.\n2. Advance beyond the expiry boundary.\n3. Verify that the resource is available again.',
  '### A concrete check\n\n```python\nremaining = capacity - sum(reservation.size for reservation in reservations if reservation.expires_at > now)\n```\n\n| Operation | Expected result |\n| --- | --- |\n| Reserve | Return identity |\n| Cancel | Release once |',
].join('\n\n');
