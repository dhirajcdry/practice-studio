// The interviewer must never write the candidate's side of the interview.
//
// This is the failure the prompt shouts about in capitals, and shouting is not a
// mechanism. A model that has just asked "how would you shard that?" is under enormous
// pressure from its own training to continue the dialogue, and the most likely next
// token after a question is an answer. Telling it not to lowers the rate. It does not
// make the rate zero, and one occurrence poisons the whole exercise: the candidate reads
// an answer they did not give, and either argues with a ghost or absorbs it as a hint.
//
// So the prompt asks, and this file enforces. The stream is cut at the first token of
// impersonation, which means the bad text is never spoken and never reaches the
// transcript — not flagged after the fact, not repaired, not "cleaned up". Cutting is
// the only honest repair available: once the model has written the candidate's answer,
// everything after it is reasoning about words the candidate never said.
//
// WHAT COUNTS. Only a turn boundary counts — a line that hands the floor to someone
// else and then keeps talking. The word "user" in a sentence is not impersonation, and
// treating it as one would cut the interviewer off mid-question every time it said
// "the user uploads a photo". That false positive is worse than the bug: it would make
// the interviewer mute at exactly the moments it was working properly.

/** Speaker labels that mean "the candidate is talking now". Matched only at the start of
 *  a line, followed by a colon — the shape of a transcript, not of a sentence. */
const CANDIDATE_LABELS = [
  'user', 'candidate', 'me', 'interviewee', 'you', 'applicant',
  'dhiraj', 'student', 'human', 'a', 'b',
];

/** Labels for its own side. Harmless in themselves, but they only ever appear when the
 *  model has started writing a script, and a script has two parts. */
const INTERVIEWER_LABELS = [
  'interviewer', 'assistant', 'claude', 'me (interviewer)', 'senior engineer',
];

const label = (names) => new RegExp(
  `^\\s{0,3}(?:[*_>\\-\\s]{0,4})(?:\\*\\*|__)?\\s*(?:${names.join('|')})\\s*(?:\\*\\*|__)?\\s*:`,
  'i',
);

const CANDIDATE_TURN = label(CANDIDATE_LABELS);
const INTERVIEWER_TURN = label(INTERVIEWER_LABELS);

/** Stage directions — the model narrating the candidate instead of quoting them.
 *  "(candidate pauses)", "*you hesitate*", "[thinks for a moment]". */
const STAGE_DIRECTION = new RegExp(
  '^\\s{0,3}[([*_]+\\s*(?:the\\s+)?(?:candidate|you|user|interviewee)\\b[^)\\]*_\\n]*[)\\]*_]+\\s*$',
  'i',
);

/**
 * Where the interviewer stopped being the interviewer, or -1.
 *
 * Scans whole lines only, so a partial last line — which is the normal state of a
 * stream — is never judged. The caller re-checks as more arrives.
 *
 * @param {string} text the answer so far
 * @returns {number} index into `text` at which to cut, or -1 to keep all of it
 */
export function findImpersonation(text) {
  const source = String(text ?? '');
  let offset = 0;
  let sawInterviewerLabel = false;

  for (const line of source.split('\n')) {
    const end = offset + line.length;
    const isLast = end >= source.length;
    // The final line of a live stream is still being written; "Use" is not yet "User:".
    if (!isLast || source.endsWith('\n')) {
      if (CANDIDATE_TURN.test(line)) return offset;
      if (STAGE_DIRECTION.test(line)) return offset;
      // "Interviewer:" alone is only a label. It becomes impersonation when a second
      // speaker follows, and the check above catches that. But a model that labels its
      // own turn is already writing a transcript, so the next candidate label is not a
      // coincidence — this flag exists to keep that reasoning visible, not to cut here.
      if (INTERVIEWER_TURN.test(line)) sawInterviewerLabel = true;
    }
    offset = end + 1;
  }
  return -1;
}

/** True when the text contains a completed act of impersonation. */
export function impersonates(text) {
  return findImpersonation(text) !== -1;
}

/**
 * Could this unfinished line still turn into "User:"?
 *
 * Tokens do not arrive as lines. "USER:" reaches the filter as "US", "ER", ":" — and by
 * the time the line is terminated and judgeable, every one of those characters has
 * already been emitted and read. So the tail after the last newline is held back while
 * it is still a possible label, and released the moment it cannot be one.
 *
 * The cost of holding is a few characters of latency at the start of a line. The cost of
 * not holding is the candidate reading the first half of an answer they never gave.
 */
export function couldBecomeLabel(tail) {
  const stripped = String(tail).replace(/^[\s>\-*_]{0,6}/, '').replace(/^(?:\*\*|__)/, '');
  if (stripped === '') return true;                 // only whitespace or markdown so far
  // An unclosed bracket or emphasis may still close into a stage direction. Bounded,
  // so an ordinary parenthetical remark is not held for the rest of the turn.
  if (/^[([*_]/.test(stripped)) return stripped.length <= 44 && !/[)\]]/.test(stripped);
  if (stripped.length > 24) return false;           // far too long to be "Candidate:"
  const low = stripped.toLowerCase();
  // Only labels that would actually cause a cut are worth delaying for.
  return CANDIDATE_LABELS.some((name) => `${name}:`.startsWith(low));
}

/**
 * A stream filter that passes tokens through until the interviewer starts writing the
 * candidate's answer, then stops for good.
 *
 * Used on the token stream so nothing bad is ever spoken aloud or shown. Once tripped it
 * stays tripped: a model that has written one turn of dialogue writes the rest of the
 * scene, and letting it resume after a cut would splice the interviewer's next line onto
 * an answer the candidate never gave.
 */
export function createNarrationFilter() {
  let kept = '';        // everything received
  let sent = 0;         // how much of it has been released
  let tripped = false;

  /** How far into `kept` it is safe to emit right now. */
  function safeUpTo() {
    const at = findImpersonation(kept);
    if (at !== -1) return { upTo: at, cut: true };
    const lastBreak = kept.lastIndexOf('\n');
    const tail = kept.slice(lastBreak + 1);
    // A speaker label is impersonation the moment the colon lands. Waiting for the
    // newline — which is what findImpersonation does, correctly, for whole text — would
    // mean waiting until the whole fabricated answer had already been streamed out.
    if (CANDIDATE_TURN.test(tail) || STAGE_DIRECTION.test(tail)) {
      return { upTo: lastBreak + 1, cut: true };
    }
    // Otherwise hold an unfinished line only while it could still become one.
    return { upTo: couldBecomeLabel(tail) ? lastBreak + 1 : kept.length, cut: false };
  }

  return {
    /**
     * @param {string} chunk newly arrived text
     * @returns {{text: string, tripped: boolean}} the part safe to show, and whether
     *   this chunk is where the interviewer broke character
     */
    push(chunk) {
      if (tripped) return { text: '', tripped: false };
      kept += String(chunk ?? '');
      const { upTo, cut } = safeUpTo();
      const text = upTo > sent ? kept.slice(sent, upTo) : '';
      sent = Math.max(sent, upTo);
      if (cut) {
        tripped = true;
        kept = kept.slice(0, upTo);
        sent = kept.length;
      }
      return { text, tripped: cut };
    },

    /**
     * The stream ended. Anything still held back was never going to be a label, so it
     * is released — otherwise a turn ending on a short final line would silently lose
     * its last few words.
     */
    flush() {
      if (tripped || sent >= kept.length) return '';
      const rest = kept.slice(sent);
      sent = kept.length;
      return rest;
    },

    /** Everything that survived, trimmed of the trailing whitespace a cut leaves. */
    text() {
      return kept.replace(/\s+$/, '');
    },

    get tripped() {
      return tripped;
    },
  };
}

/**
 * What to put back when a turn was cut.
 *
 * The candidate must not be left staring at a severed sentence, and must not be told
 * something happened that didn't. If a question survived the cut, that question stands
 * on its own and the interview continues from it. If nothing usable survived, the turn
 * is retried rather than papered over — see routes.mjs.
 */
export function salvageQuestion(text) {
  const body = String(text ?? '').replace(/\s+$/, '');
  if (!body) return null;
  // The last question mark is the live question; anything after it was scene-setting.
  const lastQuestion = body.lastIndexOf('?');
  if (lastQuestion === -1) return null;
  const upTo = body.slice(0, lastQuestion + 1);
  // Keep the paragraph the question sits in, not the whole preamble.
  const start = upTo.lastIndexOf('\n\n');
  return (start === -1 ? upTo : upTo.slice(start + 2)).trim() || null;
}
