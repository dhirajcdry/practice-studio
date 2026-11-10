// What a target level actually asks of a system design candidate.
//
// A level on its own is only a label. Told "the candidate is targeting L4" and nothing
// else, the interviewer falls back on its own idea of a top-tier interview, which is
// roughly senior: it chases every bottleneck to resolution and treats depth the level
// does not require as a gap. This file spells out the bar so the interviewer, the
// practice partner and the report all judge against the same one.
//
// Studio uses Google-style numbering. Other companies differ: Amazon SDE II is Amazon L5
// but is mid-level, Studio's L4. Expectations follow Hello Interview's level guide
// (hellointerview.com/blog/the-system-design-interview-what-is-expected-at-each-level).

const BARS = Object.freeze({
  L3: {
    name: 'junior',
    examples: 'Amazon SDE I, Google L3, Meta E3',
    pass: 'a working design for the core functional requirements, reached with guidance, where they can say what each component does',
    depth: 'Little depth is expected. The interviewer leads most of the way and may suggest where to look next.',
    drive: 'The interviewer drives much of the interview. Needing direction is normal at this level.',
    stretch: 'scaling bottlenecks, contention, failure handling and capacity estimates beyond a rough order of magnitude',
  },
  L4: {
    name: 'mid-level',
    examples: 'Amazon SDE II, Google L4, Meta E4',
    pass: 'a complete, working design that meets the functional requirements, where they can explain what each component does and why it is there, and name the main trade-offs of their choices',
    depth: 'Breadth matters more than depth. Expect one deep dive, which the interviewer may choose and steer. Noticing a hard problem, such as a hot key or write contention, and proposing a reasonable direction is a positive signal even when it is not fully resolved.',
    drive: 'They lead requirements through the high-level design. It is normal for the interviewer to direct the later stages; that is not a mark against them.',
    stretch: 'fully resolving contention or hot spots at extreme scale, multi-region design, precise capacity planning, and operational detail drawn from production experience',
  },
  L5: {
    name: 'senior',
    examples: 'Amazon SDE III, Google L5, Meta E5',
    pass: 'a working design delivered quickly, then real depth in about two places, with the hard parts of this system identified by them rather than by the interviewer',
    depth: 'Go deep in about two areas, with specifics drawn from experience, such as key design, consistency, or failure handling. Fundamentals are assumed and only probed if they expose a gap.',
    drive: 'They should steer: name what makes the system hard, raise the limits of their own design, and pick the deep dives. Heavy interviewer direction is a mark against them.',
    stretch: 'organisation-wide trade-offs and teaching the interviewer something new',
  },
  L6: {
    name: 'staff',
    examples: 'Amazon Principal, Google L6, Meta E6',
    pass: 'leading almost the whole interview as a peer, with depth in several areas and every component justified against the requirements',
    depth: 'Depth in multiple areas. Breadth is assumed. They should say which parts do not need to scale yet.',
    drive: 'They lead almost the entire interview. The interviewer acts as a peer, not a guide.',
    stretch: 'nothing in particular; the open question is judgment',
  },
});

export const LEVEL_KEYS = Object.freeze(Object.keys(BARS));

/**
 * Map a recorded level to Studio's scale. Older records and report difficulties name
 * the role instead ("Amazon SDE II (L5)"), and that L5 is Amazon's, not Studio's, so
 * the role name wins over the number. Anything unrecognised yields null, never a guess.
 */
export function levelKey(level) {
  const text = String(level ?? '').trim();
  if (/\bSDE[\s-]*(III|3)\b/i.test(text)) return 'L5';
  if (/\bSDE[\s-]*(II|2)\b/i.test(text)) return 'L4';
  if (/\bSDE[\s-]*(I|1)\b/i.test(text)) return 'L3';
  const match = /^L([3-6])$/i.exec(text);
  return match ? `L${match[1]}` : null;
}

/** "L4 (mid-level, e.g. Amazon SDE II, Google L4, Meta E4)", or the input unchanged. */
export function levelLabel(level) {
  const key = levelKey(level);
  return key ? `${key} (${BARS[key].name}, e.g. ${BARS[key].examples})` : String(level ?? '');
}

/**
 * The system design bar at a level, as prompt text. Empty for an unknown level, so a
 * caller can always append it.
 */
export function designLevelBar(level) {
  const key = levelKey(level);
  if (!key) return '';
  const bar = BARS[key];
  return `THE ${key} BAR (${bar.name}; e.g. ${bar.examples}). Studio uses Google-style level numbers.
- Passing looks like: ${bar.pass}.
- Depth: ${bar.depth}
- Who drives: ${bar.drive}
- Above this bar, so a stretch rather than a gap: ${bar.stretch}. You may still ask about these, but a weak answer here does not count against them at ${key}.`;
}
