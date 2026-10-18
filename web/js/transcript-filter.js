// Shared by browser dictation and the server's interview boundary. No DOM or I/O.
const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hallucinations = new Set(['thanks', 'thank you', 'you', 'bye', 'bye bye', 'thank you for watching', 'thanks for watching']);

export function filterTranscript(text) {
  const clean = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    // Preserve attached notation such as O(n) and f(x).
    .replace(/(^|[^\p{L}\p{N}_])\([^)]*\)/gu, '$1 ')
    .replace(/[♪♫][^♪♫]*[♪♫]/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = normalized(clean);
  if (!words || (words.split(' ').length <= 5 && hallucinations.has(words))) return '';
  return clean;
}

export function isFillerReply(text) {
  const words = normalized(text);
  return !words || /^(?:(?:mm hm|mm hmm|mhm|m hmm|uh huh|sure|okay|ok|all right|alright|take your time|go ahead|i see|got it|understood)(?: |$))+$/.test(words);
}

// Require sustained audible speech, not just the peak of a key press. RMS alone
// cannot identify sound sources; the transcript filter is the second boundary.
export function hasVoicedAudio({ voicedMs = 0, sustainedMs = 0, energy = 0 } = {}) {
  return voicedMs >= 250 && sustainedMs >= 200 && energy / voicedMs >= 0.012 ** 2;
}
