// The interviewer.
//
// The prompt here is the one Dhiraj has been running by hand, kept close to verbatim
// because it is already tuned — the probe list in particular is the product of real
// interviews and is not something to rewrite from theory. What this file adds is the
// part a prompt cannot do for itself.
//
// A prompt is a request made once, at the start, and then asked to hold for forty-five
// minutes against everything the conversation pulls it toward. Three of its instructions
// are the kind that decay:
//
//   "One question at a time"      — drifts into three-part questions by minute twenty
//   "you talk ~20% of the time"   — unmeasurable from inside the conversation
//   "max 2 follow-ups per gap"    — requires counting, across turns
//   "nudge me if I skip a phase"  — requires knowing which phase we are in
//
// So the server counts. The phase, the follow-up depth, the talk ratio and whether the
// curveball has landed are tracked here and restated on every turn as facts rather than
// as standing orders. A model told "you are on follow-up 2 of 2 on this gap" behaves
// very differently from one told, forty minutes ago, to keep track.
//
// The impersonation rule is not here at all. It is the one rule that must not depend on
// the model choosing to obey, so it lives in narration.mjs and is enforced on the token
// stream. See that file.

import { renderGraph, describeDiff, diffGraphs } from './graph.mjs';

/** The interview walks these in order. The candidate may lead; skipping is noted. */
export const PHASES = Object.freeze([
  { id: 'requirements', label: 'functional + non-functional requirements' },
  { id: 'entities', label: 'core entities' },
  { id: 'api', label: 'API' },
  { id: 'estimates', label: 'scale estimates' },
  { id: 'design', label: 'high-level design & data model' },
  { id: 'deepdive', label: 'one deep dive' },
  { id: 'bottlenecks', label: 'bottlenecks & tradeoffs' },
]);

export const PHASE_IDS = PHASES.map((p) => p.id);

/** A 45-minute interview. The curveball lands in the middle third — late enough that
 *  there is a design to disturb, early enough to leave room to recover. */
export const DEFAULT_MINUTES = 45;
export const CURVEBALL_WINDOW = [0.4, 0.65];

/** The prompt's own ceiling on probing one gap. Counted here so it holds. */
export const MAX_FOLLOWUPS = 2;

/**
 * The standing character. Sent once as the system prompt; everything that changes is
 * sent per turn by {@link buildTurn}.
 */
export function systemPrompt({ level = 'L4', minutes = DEFAULT_MINUTES } = {}) {
  return `You are a senior engineer running a ${minutes}-minute system design interview at a
top-tier tech company. The candidate is targeting ${level}. Stay fully in character until
the debrief.

RULES
- Open with a one-line problem statement and nothing else. Then wait.
- One question at a time. Short turns. You talk ~20% of the time.
- Never write any part of the candidate's answer. Not a sentence, not a lead-in, not
  "Right, so..." — even if they stall, ramble, or go wrong. If they stop mid-thought,
  wait or ask a question. Nothing else.
- Never hint, never suggest the next step. If asked for a hint: "What do you think?"
- Drop one curveball mid-interview (scale spike, new requirement, component failure).
  You will be told when.

PROBING — this is the core of your job
When you spot a gap, do NOT correct the candidate and do NOT save it for the debrief.
Ask the question that forces them to discover it. Test the assumption, don't patch it.

Probe hardest at:
- Key design: does the stated PK/SK actually do what they claim? Does the sort key have
  a partition to sort within? Hot partitions?
- Access paths: for every table/index, which query justifies it? For every component,
  who reads from it? If nothing reads it, ask why it exists.
- Write amplification: make them put a number on fan-out cost before accepting or
  rejecting a design.
- Merged/multi-source reads: staleness skew, ordering, what the merge actually costs,
  what it needs to look up first.
- Delivery semantics: at-least-once vs exactly-once, duplicates, idempotency.
- Bounds: what limits the size of any cache, queue, or list they invoke.
- Numbers they assert: if a figure is off by an order of magnitude or is load-bearing
  for a conclusion, make them defend it.
- Edge/serving layer: LB, CDN, connection handling if absent.

DON'T probe on:
- Misspeaking, transcription noise, or something they self-correct later
- Leaving two reasonable options on the table without picking one
- Arithmetic slips, as long as the estimate still drives a decision
- Narration polish or answer ordering

THE WHITEBOARD
You are shown the candidate's diagram as a component-and-connection list, rebuilt from
their canvas after every change. It is what they have actually drawn — treat it as
ground truth about the picture, and treat what they say as their claim about it. Where
the two disagree, that gap is usually the best question in the room.
Never describe the diagram back to them. Ask about it.

WHAT YOU CAN LOOK UP
Your working directory is the candidate's practice workspace. Every past system design
interview is on disk at design/<timestamp>/interview.md — the questions, what they
answered, the board at each stage, and the debrief. DESIGN.md is your own running note
on what keeps going wrong across all of them.

Use this the way an interviewer who knew the candidate would: not to repeat the same
problem, and to push harder where they have failed before. If DESIGN.md says they have
hand-waved cache invalidation three times, ask about invalidation early and do not let
it go. Do not tell them you are reading their history, and never quote a past interview
at them mid-interview — that belongs in the debrief.

Reading is cheap; do it when it changes what you would ask. You cannot write to an
interview's own record, only to DESIGN.md and design/<id>/NOTES.md. Update DESIGN.md at
the debrief, not during.

WHICH PHASE YOU ARE IN
End every reply with a line containing only [[phase: <id>]], where <id> is one of
requirements, entities, api, estimates, design, deepdive, bottlenecks — the phase the
interview is in *after* your question. It is stripped before the candidate sees or
hears anything, so it costs them nothing; it is how the interview knows where it is
without making the candidate click a button to say so.

OUTPUT
Speak only as the interviewer, in plain prose. No headings, no bullet lists, no labels
like "Interviewer:". This is a conversation being read aloud. Keep turns short — this
is being spoken, and a paragraph read aloud is a monologue.`;
}

/** Matches the phase line wherever it lands, so a stray one mid-answer is still removed. */
const PHASE_TAG = /\[\[\s*phase\s*:\s*([a-z]+)\s*\]\]/gi;

/**
 * Pull the phase out of a reply and take the tag with it.
 *
 * The tag is a control channel sharing a pipe with speech, so the removal has to be
 * exact: anything left behind is read aloud to the candidate as "bracket bracket phase".
 * An unknown or absent id yields null rather than a guess — the phase then simply does
 * not advance, which is recoverable, where a wrong phase silently mis-reports what the
 * interview covered.
 *
 * @returns {{phase: string|null, text: string}}
 */
export function extractPhaseTag(reply) {
  const source = String(reply ?? '');
  let phase = null;
  const text = source.replace(PHASE_TAG, (_, id) => {
    const found = String(id).toLowerCase();
    if (PHASE_IDS.includes(found)) phase = found;
    return '';
  });
  // Collapse the blank line the tag leaves behind, without touching internal spacing.
  return { phase, text: text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') };
}

/**
 * A streaming stripper for the phase tag.
 *
 * Stripping at the end is too late: the tag arrives as ordinary tokens and would be
 * shown, and spoken, character by character before the reply finished. So anything from
 * a `[` onward is withheld while it could still be the opening of a tag, and released
 * the moment it cannot be — the same bet as the impersonation guard, and for the same
 * reason: a few characters of latency is cheaper than reading "bracket bracket phase"
 * aloud to the candidate.
 */
export function createTagStripper() {
  let held = '';
  let phase = null;

  /** Could this trailing fragment still grow into [[phase: x]]? */
  const couldOpen = (tail) => {
    const opener = '[[phase:';
    if (tail.length <= opener.length) return opener.startsWith(tail);
    return tail.toLowerCase().startsWith(opener) && !tail.includes(']]');
  };

  return {
    push(chunk) {
      held += String(chunk ?? '');
      // Complete tags go first, wherever they are.
      const pulled = extractPhaseTag(held);
      if (pulled.phase) phase = pulled.phase;
      held = held.replace(PHASE_TAG, '');
      PHASE_TAG.lastIndex = 0;

      // The earliest bracket that could still open a tag, not the last one: a chunk that
      // ends in `[[` would otherwise release the first bracket, and what is held back
      // becomes `[phase: …]]`, which no longer matches and is shown whole.
      let at = held.indexOf('[');
      while (at !== -1 && !couldOpen(held.slice(at))) at = held.indexOf('[', at + 1);
      if (at !== -1) {
        const out = held.slice(0, at);
        held = held.slice(at);
        return out;
      }
      const out = held;
      held = '';
      return out;
    },
    /** The stream ended; anything still held was never a tag. */
    flush() {
      const pulled = extractPhaseTag(held);
      if (pulled.phase) phase = pulled.phase;
      held = '';
      return pulled.text;
    },
    get phase() { return phase; },
  };
}

/** A fresh interview. Everything mutable about a session lives in this one object. */
export function newInterview({
  prompt, level = 'L4', minutes = DEFAULT_MINUTES, startedAt = null,
} = {}) {
  return {
    prompt: prompt ?? null,
    level,
    minutes,
    startedAt,
    phase: 'requirements',
    visited: [],
    // The gap currently being probed, and how many follow-ups it has cost.
    openGap: null,
    followups: 0,
    curveballDone: false,
    turns: [],
    words: { interviewer: 0, candidate: 0 },
    graph: null,
    debriefed: false,
  };
}

const words = (text) => String(text ?? '').trim().split(/\s+/).filter(Boolean).length;

/** Record one exchange. `said` is the candidate, `asked` is the interviewer. */
export function recordTurn(state, { said = '', asked = '', at = null, gap = null }) {
  state.turns.push({ at, said, asked, phase: state.phase });
  state.words.candidate += words(said);
  state.words.interviewer += words(asked);
  // Probing the same gap again is a follow-up; a new gap resets the budget.
  if (gap && gap === state.openGap) state.followups += 1;
  else if (gap) { state.openGap = gap; state.followups = 1; }
  return state;
}

/** Move to a phase, remembering the ones actually visited. */
export function enterPhase(state, phase) {
  if (!PHASE_IDS.includes(phase)) return state;
  if (state.phase !== phase) {
    if (!state.visited.includes(state.phase)) state.visited.push(state.phase);
    state.phase = phase;
    state.openGap = null;
    state.followups = 0;
  }
  return state;
}

/** Fraction of the interviewer's words out of all words spoken. */
export function talkShare(state) {
  const total = state.words.interviewer + state.words.candidate;
  return total === 0 ? 0 : state.words.interviewer / total;
}

/** Minutes elapsed, or null before the clock starts. */
export function elapsedMinutes(state, now) {
  if (!state.startedAt) return null;
  return (now - state.startedAt) / 60000;
}

/**
 * Whether the curveball is due.
 *
 * Time-based rather than turn-based: a candidate who talks in paragraphs and one who
 * talks in sentences should get it at the same point in the interview.
 */
export function curveballDue(state, now) {
  if (state.curveballDone) return false;
  const elapsed = elapsedMinutes(state, now);
  if (elapsed === null) return false;
  const share = elapsed / state.minutes;
  return share >= CURVEBALL_WINDOW[0] && share <= CURVEBALL_WINDOW[1];
}

/** The phase the clock says we should be near, so drift can be named. */
export function expectedPhase(state, now) {
  const elapsed = elapsedMinutes(state, now);
  if (elapsed === null) return null;
  const share = Math.min(0.999, Math.max(0, elapsed / state.minutes));
  return PHASE_IDS[Math.min(PHASES.length - 1, Math.floor(share * PHASES.length))];
}

/**
 * The per-turn brief: what changed, where we are, and what the standing rules currently
 * evaluate to. Facts, not instructions — the character is already set.
 */
export function buildTurn(state, { said = '', graph = null, previousGraph = null, now = Date.now(), done = false } = {}) {
  if (done) return { text: debriefPrompt(state), kind: 'debrief' };

  const lines = [];

  const elapsed = elapsedMinutes(state, now);
  if (elapsed !== null) {
    lines.push(`[${Math.floor(elapsed)} min elapsed of ${state.minutes}]`);
  }

  // Where we are, and whether that is where we should be.
  const want = expectedPhase(state, now);
  lines.push(`[phase: ${labelOf(state.phase)}]`);
  if (want && want !== state.phase && PHASE_IDS.indexOf(want) > PHASE_IDS.indexOf(state.phase)) {
    lines.push(`[the clock is at "${labelOf(want)}" — if they have finished here, move them on]`);
  }
  const skipped = PHASE_IDS.slice(0, PHASE_IDS.indexOf(state.phase))
    .filter((p) => !state.visited.includes(p));
  if (skipped.length) {
    lines.push(`[never covered: ${skipped.map(labelOf).join(', ')} — nudge, do not cover it for them]`);
  }

  // The follow-up budget, as a count rather than a rule to remember.
  if (state.openGap) {
    const left = MAX_FOLLOWUPS - state.followups;
    lines.push(left > 0
      ? `[probing "${state.openGap}" — ${left} follow-up${left === 1 ? '' : 's'} left on this gap]`
      : `[probing "${state.openGap}" — budget spent. Note it silently and move on.]`);
  }

  // The talk ratio, which cannot be felt from inside the conversation.
  const share = talkShare(state);
  if (state.turns.length >= 3 && share > 0.3) {
    lines.push(`[you have spoken ${Math.round(share * 100)}% of the words. Target is 20%. Ask, don't explain.]`);
  }

  if (curveballDue(state, now)) {
    lines.push('[the curveball is due this turn: a scale spike, a new requirement, or a component failing]');
  }

  // The drawing. Only re-sent when it actually changed, so an unchanged canvas costs
  // nothing and a changed one is unmissable.
  const change = previousGraph ? describeDiff(diffGraphs(previousGraph, graph), graph) : null;
  if (graph && (!previousGraph || change)) {
    lines.push('', 'THE WHITEBOARD NOW:', renderGraph(graph));
  }
  if (change) lines.push('', `Since your last question they: ${change}`);

  lines.push('', said.trim()
    ? `THE CANDIDATE SAID:\n${said.trim()}`
    : '[The candidate has not said anything since your last question.]');

  lines.push('', 'Ask your next question. One question. Interviewer voice only.');
  lines.push('End with the [[phase: …]] line.');
  return { text: lines.join('\n'), kind: 'turn' };
}

function labelOf(id) {
  return PHASES.find((p) => p.id === id)?.label ?? id;
}

/**
 * Hand a fresh thread everything it needs to carry on an interview it never had.
 *
 * A CLI thread can be lost — the server restarted before its id was ever written, or
 * the CLI dropped the session. The interview itself is not lost: every question and
 * every answer is in turns.jsonl. So the replacement thread is given the transcript
 * and told plainly that it is picking up someone else's interview, rather than the
 * candidate being told their work cannot be continued.
 *
 * What is genuinely gone is the model's own reasoning between turns — which lines of
 * questioning it had planned, which gaps it had noted and let go. That is said here
 * too, because an interviewer that believes it remembers what it does not will ask a
 * follow-up to a question it never asked.
 */
export function rehydratePrompt(state, turns) {
  const lines = [
    'You are resuming an interview already in progress. You did not ask these questions —',
    'another instance of you did, and its notes are gone. What follows is the full record.',
    'Do not greet the candidate, do not restart, and do not remark on any of this. Read it',
    'and carry on as though you had been here the whole time.',
    '',
  ];
  if (state.prompt) lines.push(`THE PROBLEM: ${state.prompt}`, '');
  lines.push('WHAT HAS BEEN SAID SO FAR:');
  if (!turns.length) {
    lines.push('  (nothing — the interview had only just started)');
  }
  for (const turn of turns) {
    if (turn.kind === 'debrief') continue;
    const asked = String(turn.asked ?? '').replace(/\s+/g, ' ').trim();
    const said = String(turn.said ?? '').replace(/\s+/g, ' ').trim();
    if (asked) lines.push(`  YOU ASKED: ${asked}`);
    // A silence is stated, so the replacement does not read a gap as agreement.
    if (turn.kind === 'turn') lines.push(`  THEY ANSWERED: ${said || '(nothing — they said nothing)'}`);
  }
  lines.push(
    '',
    'You have lost your own notes on which gaps you were probing, so do not refer back to',
    'a line of questioning as though it were still open. Judge only what is written above.',
  );
  return lines.join('\n');
}

/**
 * The debrief. Unlike every other turn, this one is allowed to be long, is allowed to
 * use structure, and is the only place correction is permitted.
 */
export function debriefPrompt(state) {
  const covered = [...state.visited, state.phase];
  const missed = PHASE_IDS.filter((p) => !covered.includes(p));
  const lines = [
    'The interview is over. Drop the interviewer character and give the debrief.',
    '',
    `1. Verdict against the ${state.level} bar: strong hire / hire / lean no / no hire`,
    '2. Signal by signal: requirements, estimation, data modeling, architecture,',
    '   tradeoff reasoning, communication',
    '3. Hard technical errors — things they stated that are mechanically wrong or would',
    '   not work as described. Be specific and unsparing. This section matters most.',
    `4. What they never said that a strong ${state.level} would have: missing components,`,
    '   unasked-for numbers, unaddressed failure modes.',
    '',
    'Skip process and style feedback unless it materially cost them.',
    '',
    'Then update DESIGN.md: what this interview confirms or breaks about the patterns',
    'you are tracking across their design practice. Keep it short and specific — a',
    'recurring weakness is worth a line, a one-off slip is not.',
    'Judge only what they actually said and drew. Do not invent an exchange that is not',
    'in this conversation.',
  ];
  if (missed.length) {
    lines.push('', `For your own reference, these phases were never reached: ${missed.map(labelOf).join(', ')}.`);
  }
  if (state.graph) {
    lines.push('', 'THE FINAL WHITEBOARD:', renderGraph(state.graph));
  }
  return lines.join('\n');
}

/**
 * The opening. A one-line problem statement and nothing else — so it is worth saying
 * exactly that, in a turn that has no room for anything else.
 */
export function openingPrompt(state, { avoid = [] } = {}) {
  const lines = [];
  if (state.prompt) {
    lines.push(`The problem for this interview is: ${state.prompt}`);
  } else {
    lines.push('Pick a realistic system design problem for this interview.');
    if (avoid.length) {
      lines.push(`They have already been asked these, so pick something else: ${avoid.join('; ')}.`);
    }
  }
  lines.push(
    '',
    'Give the candidate the one-line problem statement and nothing else.',
    'No preamble, no agenda, no "let me know when you are ready". One line, then stop.',
  );
  return lines.join('\n');
}
