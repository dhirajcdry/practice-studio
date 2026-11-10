import { splitForSpeech, stripForSpeech } from './speech.js';

function withoutLinkTargets(text) {
  let result = '', start = 0;
  for (const match of text.matchAll(/!?\[([^\]]*)\]\(/g)) {
    if (match.index < start) continue;
    let end = match.index + match[0].length, depth = 1;
    for (; end < text.length && depth; end++) {
      if (text[end] === '(') depth++;
      if (text[end] === ')') depth--;
    }
    if (depth) break;
    result += text.slice(start, match.index) + match[1]; start = end;
  }
  return result + text.slice(start);
}

// Only expose complete Markdown constructs to cleanup. In particular, an opening
// fence or link arriving one character at a time must never become spoken code.
function stablePrefix(text, final) {
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '`' || text.startsWith('~~~', i)) {
      const run = text.slice(i).match(c === '`' ? /^`+/ : /^~+/)[0];
      if (i + run.length === text.length && !final) return text.slice(0, i);
      const end = text.indexOf(run, i + run.length);
      if (end < 0) return text.slice(0, i);
      i = end + run.length - 1;
    } else if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const begin = c === '!' ? i + 1 : i;
      const label = text.indexOf(']', begin + 1);
      if (label < 0 || (label + 1 === text.length && !final)) return text.slice(0, i);
      if (text[label + 1] === '(') {
        let depth = 1, end = label + 2;
        for (; end < text.length && depth; end++) {
          if (text[end] === '(') depth++;
          if (text[end] === ')') depth--;
        }
        if (depth) return text.slice(0, i);
        i = end - 1;
      } else i = label;
    } else if ((c === '*' || c === '_') && (c !== '_' || !/\w/.test(text[i - 1] || ''))) {
      const run = text.slice(i).match(c === '*' ? /^\*+/ : /^_+/)[0];
      // A list marker is complete only once its separating space arrives.
      if (run === '*' && /\s/.test(text[i + 1] || '') && /(?:^|\n)\s*$/.test(text.slice(0, i))) continue;
      const end = text.indexOf(run, i + run.length);
      if (end < 0) return text.slice(0, i);
      i = end + run.length - 1;
    }
  }
  return text;
}

/** One instance per reply. cancel() also cancels its speaker; finish() is idempotent. */
// Each request becomes a separate WAV. Wait for a complete sentence so a timer
// cannot cut its delivery in half; join tiny openers to the following sentence.
// Only unusually long text needs a bounded clause/word split before completion.
export function createSpeechStream(speaker, { maxChars = 400 } = {}) {
  const limit = Math.max(40, Math.min(500, maxChars));
  let source = '', consumed = 0, closed = false;
  function flush(final = false) {
    // Keep the last raw word until its delimiter arrives: it could still become a
    // URL, an abbreviation, or just the first half of a longer word.
    const safe = stablePrefix(final ? source : source.replace(/\S+$/, ''), final);
    const clean = stripForSpeech(withoutLinkTargets(safe.replace(/~~~[\s\S]*?~~~/g, ' ')));
    let tail = clean.slice(consumed);
    const emit = n => {
      const piece = tail.slice(0, n).trim();
      consumed += n; tail = tail.slice(n);
      // This is already a bounded speech phrase. Splitting it again at punctuation
      // would undo the grouping of short openers such as "Good question."
      if (piece) speaker.say(piece, { splitSentences: false });
    };
    while (tail.trim()) {
      const sentences = splitForSpeech(tail + ' ').ready;
      let sentenceEnd = 0;
      for (const sentence of sentences) {
        const end = tail.indexOf(sentence, sentenceEnd) + sentence.length;
        if (end > limit) break;
        sentenceEnd = end;
        if (tail.slice(0, end).trim().split(/\s+/).length >= 4) break;
      }
      if (sentenceEnd && (tail.slice(0, sentenceEnd).trim().split(/\s+/).length >= 4
        || (final && !tail.slice(sentenceEnd).trim()))) {
        emit(sentenceEnd); continue;
      }
      if (tail.length > limit) {
        const window = tail.slice(0, limit + 1);
        const clause = [...window.matchAll(/[,;:]\s+/g)].at(-1);
        let cut = clause && clause.index >= limit / 2 ? clause.index + 1 : window.lastIndexOf(' ');
        if (cut <= 0) cut = limit;
        emit(cut); continue;
      }
      if (final) emit(tail.length);
      break;
    }
  }
  return {
    push(delta) {
      if (closed) return;
      source += String(delta ?? ''); flush();
    },
    finish() { if (closed) return; flush(true); closed = true; },
    cancel() { closed = true; speaker.cancel(); },
  };
}
