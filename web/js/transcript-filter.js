// Shared by browser dictation and the server's interview boundary. No DOM or I/O.
const normalized = text => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const hallucinations = new Set(['thanks', 'thank you', 'you', 'bye', 'bye bye', 'thank you for watching', 'thanks for watching']);

// Whisper learned these sign-offs from subtitled videos and produces them on silence or
// noise. A phrase is dropped only when EVERY clause in it is a sign-off and at least one
// is a video sign-off nobody says in an interview ("see you in the next video", "thanks
// for watching", "subscribe", subtitle credits). A plain "Thanks, have a good day" stays.
const videoSignOff = /^(?:(?:and|so|okay|ok|well) )?(?:(?:i ll|i will|we ll|we will) )?see you (?:all |guys )?in the next(?: (?:video|one|episode|lesson|clip))?$|^(?:thanks|thank you)(?: so much| very much)? for watching$|^(?:please )?(?:(?:like|comment)(?: and)? )*(?:share )?(?:and )?subscribe(?: to (?:my|the|our) channel)?$|^(?:subtitles|captions|transcription|translated|subtitled) by\b|^amara org\b/;
const signOff = /^(?:(?:and|so|okay|ok|well) )?(?:thanks|thank you(?: so much| very much)?|bye(?: bye)?|goodbye|take care|(?:(?:i ll|i will|we ll|we will) )?see you(?: next time| soon| later)?|(?:i hope )?(?:you )?(?:have|had) a (?:good|great|nice|wonderful) (?:time|day|night|one|weekend)|thanks for listening|(?:please )?(?:like|comment|share)(?: this video)?)$/;
function isVideoSignOff(clean) {
  const clauses = clean.split(/[,!?;:]+|\.(?!\w)|\band\b/i).map(normalized).filter(Boolean);
  return clauses.length > 0 && clauses.some(c => videoSignOff.test(c)) && clauses.every(c => videoSignOff.test(c) || signOff.test(c));
}

export function filterTranscript(text) {
  const clean = String(text ?? '')
    .replace(/\[[^\]]*\]/g, ' ')
    // Preserve attached notation such as O(n) and f(x).
    .replace(/(^|[^\p{L}\p{N}_])\([^)]*\)/gu, '$1 ')
    .replace(/[♪♫][^♪♫]*[♪♫]/g, ' ')
    .replace(/[♪♫]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const words = normalized(clean);
  if (!words || (words.split(' ').length <= 5 && hallucinations.has(words)) || isVideoSignOff(clean)) return '';
  return clean;
}

export function isFillerReply(text) {
  const words = normalized(text);
  // "Okay, go ahead" agrees a plan with the candidate; it is an answer, not filler.
  if (/^(?:(?:okay|ok|sure|all right|alright) )?go ahead$/.test(words)) return false;
  return !words || /^(?:(?:mm hm|mm hmm|mhm|m hmm|uh huh|sure|okay|ok|all right|alright|take your time|go ahead|i see|got it|understood|no rush|and|keep going|keep thinking|keep thinking out loud|keep thinking aloud|noted|recorded)(?: |$))+$/.test(words);
}

// Require sustained audible speech, not just the peak of a key press. RMS alone
// cannot identify sound sources; the transcript filter is the second boundary.
export function hasVoicedAudio({ voicedMs = 0, sustainedMs = 0, energy = 0 } = {}) {
  return voicedMs >= 250 && sustainedMs >= 200 && energy / voicedMs >= 0.012 ** 2;
}
