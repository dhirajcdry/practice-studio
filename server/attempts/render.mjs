// One attempt as a document — minute by minute, what was said beside what was done.
//
// The reader is the coach: a model that gets one file and has to understand a sitting well
// enough to say something true about it. That rules out both extremes. A raw event dump is
// unreadable; a summary is a claim this file has no business making. So: a timeline, in
// order, with the person's own words verbatim and every number exactly as recorded.
//
// Minutes are the grain because that is roughly how thinking is remembered — "about six
// minutes in, before the first run". Every entry still carries its exact clock time, so
// nothing inside a minute is reordered or flattened.

const pad = (n) => String(n).padStart(2, '0');

/** mm:ss from the start of the attempt — how far in, not what time it was. */
function offset(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

function clock(at) {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function minutes(ms) {
  const m = Math.round(ms / 60000);
  return m === 1 ? '1 minute' : `${m} minutes`;
}

/* ----------------------------------- diffing ----------------------------------- */

/** Minimal LCS line diff. Solution files are tens of lines; this does not need to be fast. */
export function diffLines(before, after) {
  const a = (before ?? '').split('\n');
  const b = (after ?? '').split('\n');
  const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: ' ', text: a[i] }); i += 1; j += 1; }
    else if (table[i + 1][j] >= table[i][j + 1]) { out.push({ kind: '-', text: a[i] }); i += 1; }
    else { out.push({ kind: '+', text: b[j] }); j += 1; }
  }
  while (i < a.length) { out.push({ kind: '-', text: a[i] }); i += 1; }
  while (j < b.length) { out.push({ kind: '+', text: b[j] }); j += 1; }
  return out;
}

/** Changed lines with a little context, so a one-line edit is one line, not a whole file. */
function renderDiff(before, after, { context = 1 } = {}) {
  const all = diffLines(before, after);
  const keep = new Set();
  all.forEach((line, index) => {
    if (line.kind === ' ') return;
    for (let k = index - context; k <= index + context; k += 1) if (k >= 0 && k < all.length) keep.add(k);
  });
  if (keep.size === 0) return null;

  const lines = [];
  let skipping = false;
  all.forEach((line, index) => {
    if (!keep.has(index)) { if (!skipping) { lines.push('  …'); skipping = true; } return; }
    skipping = false;
    lines.push(`${line.kind} ${line.text}`);
  });
  return lines.join('\n');
}

/* ---------------------------------- the entries ---------------------------------- */

/**
 * Everything that happened, on one clock, in order.
 *
 * Speech chunks are merged here rather than kept as files: the capture cuts every 120
 * seconds regardless of whether a sentence was finished, so chunk boundaries are an
 * artefact of the recorder and carry no meaning. Consecutive chunks inside one minute
 * become one paragraph.
 */
export function buildEntries(attempt) {
  const entries = [];

  for (const chunk of attempt.speech) {
    entries.push({
      at: chunk.at,
      kind: 'said',
      text: chunk.text,
      seconds: chunk.seconds,
      missing: chunk.text === null,
      file: chunk.file,
    });
  }

  let previous = null;
  for (const snap of attempt.snapshots) {
    entries.push({ at: snap.at, kind: 'code', code: snap.code, before: previous, name: snap.name });
    previous = snap.code;
  }

  const bySubmissionId = new Map(attempt.submissions.map((s) => [s.id, s]));

  for (const event of attempt.events) {
    const at = Date.parse(event.at);
    switch (event.type) {
      case 'run_result':
        entries.push({ at, kind: 'run', ...event.data });
        break;
      case 'submitted':
        entries.push({ at, kind: 'submitted', ...event.data, code: bySubmissionId.get(event.data?.submissionId)?.code ?? null });
        break;
      case 'verdict':
        entries.push({ at, kind: 'verdict', ...event.data });
        break;
      case 'revealed_solution':
        entries.push({ at, kind: 'note', text: 'Opened the reference solution.' });
        break;
      case 'revealed_article':
        entries.push({ at, kind: 'note', text: 'Opened the article.' });
        break;
      default:
        break;   // ran_locally is the pair of run_result; recorded_audio is already speech
    }
  }

  for (const turn of attempt.chats) {
    entries.push({ at: Date.parse(turn.at), kind: 'coach', ask: turn.ask, answer: turn.answer, tools: turn.tools ?? [] });
  }

  return entries.filter((e) => Number.isFinite(e.at)).sort((a, b) => a.at - b.at);
}

/* ---------------------------------- the document ---------------------------------- */

function outcomeOf(entries) {
  const verdicts = entries.filter((e) => e.kind === 'verdict');
  if (verdicts.length === 0) return { line: 'No submission.', accepted: false };
  const last = verdicts[verdicts.length - 1];
  const accepted = last.accepted === true;
  const counts = Number.isFinite(last.passed) && Number.isFinite(last.total) ? ` ${last.passed}/${last.total}` : '';
  return { line: `${last.verdict ?? (accepted ? 'Accepted' : 'Not accepted')}${counts}`, accepted };
}

/**
 * A stretch of talking, one line per captured chunk, each stamped with how far in it was.
 *
 * The two pulls here are opposite and both real. Merged into one paragraph it reads as the
 * continuous thought it was, but thirteen minutes of speech is then an unnavigable wall.
 * Split into separate blocks it is navigable but fragmented, and the 120-second cut lands
 * mid-sentence — which is the thing that made the raw files unreadable in the first place.
 *
 * So: one block, one line per chunk, each prefixed with its offset. It reads top to bottom
 * as one thought, and "what was I saying at 11:04, just before I submitted" is answerable
 * by looking. The words are never edited — only the leading and trailing space.
 */
function speechBlock(chunks, startMs) {
  return chunks
    .map(({ at, text }) => `> \`${offset(at - startMs)}\`  ${text.replace(/\s+/g, ' ').trim()}`)
    .join('\n>\n');
}

export function renderAttempt(attempt, { title = null } = {}) {
  const entries = buildEntries(attempt);
  const startMs = Date.parse(attempt.started.at);
  const endMs = attempt.ended ? Date.parse(attempt.ended.at) : (entries.at(-1)?.at ?? startMs);
  const elapsed = attempt.ended?.data?.elapsedSeconds != null
    ? attempt.ended.data.elapsedSeconds * 1000
    : endMs - startMs;

  const runs = entries.filter((e) => e.kind === 'run');
  const passedRuns = runs.filter((e) => e.passed === e.total && e.total > 0).length;
  const submissions = entries.filter((e) => e.kind === 'submitted');
  const spokenSeconds = attempt.speech.reduce((sum, c) => sum + (c.seconds ?? 0), 0);
  const spokenWords = attempt.speech.reduce((sum, c) => sum + (c.text ? c.text.split(/\s+/).length : 0), 0);
  const outcome = outcomeOf(entries);
  const missingSpeech = attempt.speech.filter((c) => c.text === null).length;

  const out = [];
  out.push(`# ${title ?? attempt.slug} — attempt of ${new Date(startMs).toLocaleString()}`);
  out.push('');
  out.push(`- **Outcome** ${outcome.line}`);
  out.push(`- **Took** ${minutes(elapsed)} (${offset(elapsed)})`);
  out.push(`- **Ran it** ${runs.length} times${runs.length ? `, ${passedRuns} clean` : ''}`);
  out.push(`- **Submitted** ${submissions.length} time${submissions.length === 1 ? '' : 's'}`);
  if (attempt.speech.length) {
    out.push(`- **Thought aloud** ${minutes(spokenSeconds * 1000)}, about ${spokenWords} words`);
  }
  if (attempt.chats.length) out.push(`- **Asked the coach** ${attempt.chats.length} time${attempt.chats.length === 1 ? '' : 's'}`);
  if (!attempt.ended) out.push('- **Note** this attempt has no end event — it was still open, or Stop was never recorded.');
  if (missingSpeech) {
    out.push(`- **Note** ${missingSpeech} of ${attempt.speech.length} recordings have no transcript on disk; those minutes are marked, not guessed.`);
  }
  out.push('');
  out.push(`Attempt id \`${attempt.attemptId}\`. Assembled from the raw logs — regenerate with \`npm run attempts\`.`);
  out.push('');
  out.push('## Timeline');
  out.push('');

  let lastMinute = null;
  let pending = [];        // consecutive speech chunks, not yet written
  let pendingFrom = null;  // when this stretch of talking began

  /**
   * Write an unbroken stretch of talking as one block.
   *
   * Not per chunk, and not per minute. The recorder cuts every 120 seconds regardless of
   * whether a sentence was finished — one real chunk boundary in this workspace falls
   * between "the answer is in between this" and "On the first element of this 2D array" —
   * so both the file boundary and the minute boundary are artefacts. What is real is
   * "they talked from here to here without doing anything else", and that is the unit.
   */
  const flushSpeech = (toMs) => {
    if (!pending.length) return;
    const from = offset(pendingFrom - startMs);
    const to = offset((toMs ?? pendingFrom) - startMs);
    out.push(`### ${from}${to !== from ? ` – ${to}` : ''}  ·  thinking aloud`);
    out.push('');
    out.push(speechBlock(pending, startMs));
    out.push('');
    pending = [];
    pendingFrom = null;
    lastMinute = null;   // the next action re-states its minute rather than assuming one
  };

  for (const entry of entries) {
    if (entry.kind === 'said') {
      if (entry.missing) {
        flushSpeech(entry.at);
        out.push(`*(${Math.round(entry.seconds ?? 0)}s recorded at ${clock(entry.at)}, transcript missing on disk)*`);
        out.push('');
      } else if (entry.text) {
        if (!pending.length) pendingFrom = entry.at;
        pending.push({ at: entry.at, text: entry.text });
      }
      continue;
    }

    flushSpeech(entry.at);

    const minute = Math.floor((entry.at - startMs) / 60000);
    if (minute !== lastMinute) {
      out.push(`### ${offset(minute * 60000)}`);
      out.push('');
      lastMinute = minute;
    }

    switch (entry.kind) {
      case 'run': {
        const ok = entry.total > 0 && entry.passed === entry.total;
        const bits = [`**ran** ${entry.passed ?? '?'}/${entry.total ?? '?'}`];
        if (entry.totalMs != null) bits.push(`${entry.totalMs}ms`);
        if (entry.errorKind) bits.push(entry.errorKind);
        out.push(`- \`${clock(entry.at)}\` ${bits.join(' · ')}${ok ? '' : '  ← did not pass'}`);
        break;
      }
      case 'code': {
        const diff = renderDiff(entry.before, entry.code);
        if (entry.before === null) {
          out.push(`- \`${clock(entry.at)}\` **the code at the first run**`);
          out.push('');
          out.push('  ```python');
          out.push(entry.code.replace(/\n$/, '').split('\n').map((l) => `  ${l}`).join('\n'));
          out.push('  ```');
        } else if (diff) {
          out.push(`- \`${clock(entry.at)}\` **edited**`);
          out.push('');
          out.push('  ```diff');
          out.push(diff.split('\n').map((l) => `  ${l}`).join('\n'));
          out.push('  ```');
        } else {
          out.push(`- \`${clock(entry.at)}\` ran the same code again, unchanged`);
        }
        break;
      }
      case 'submitted':
        out.push(`- \`${clock(entry.at)}\` **submitted** → [${entry.submissionId}](${entry.submissionUrl ?? ''})`);
        break;
      case 'verdict': {
        const counts = Number.isFinite(entry.passed) ? ` ${entry.passed}/${entry.total}` : '';
        const speed = [entry.runtime, entry.memory].filter(Boolean).join(', ');
        out.push(`- \`${clock(entry.at)}\` **${entry.verdict ?? (entry.accepted ? 'Accepted' : 'Not accepted')}**${counts}${speed ? ` (${speed})` : ''}`);
        break;
      }
      case 'coach':
        out.push(`- \`${clock(entry.at)}\` **asked the coach** — "${(entry.ask ?? '').replace(/\s+/g, ' ').slice(0, 160)}"`);
        if (entry.answer) {
          out.push('');
          out.push(entry.answer.split('\n').map((l) => `  | ${l}`).join('\n'));
        }
        break;
      case 'note':
        out.push(`- \`${clock(entry.at)}\` ${entry.text}`);
        break;
      default:
        break;
    }
    out.push('');
  }
  flushSpeech(entries.at(-1)?.at ?? startMs);

  const finalCode = attempt.submissions.at(-1)?.code ?? attempt.snapshots.at(-1)?.code ?? null;
  if (finalCode) {
    out.push('## Where it ended up');
    out.push('');
    out.push('```python');
    out.push(finalCode.replace(/\n$/, ''));
    out.push('```');
    out.push('');
  }

  return out.join('\n');
}
