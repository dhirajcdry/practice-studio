// The interviewer's voice, and knowing when your turn is over.
//
// An interview you have to press Send to participate in is not an interview, it is a
// form. These are the two pieces that close the loop: the question is spoken aloud, and
// going quiet is what ends your answer.
//
// SPEECH OUT is the browser's own speechSynthesis. It uses the same macOS system voices
// as `say`, so it works with the wifi off, needs no server round trip, and — the reason
// it beats doing this server-side — can be cancelled in one call, which is what makes
// interrupting possible at all.
//
// SPEECH IN already existed: web/js/voice.js has an RMS analyser with an adaptive noise
// floor, built for cutting dictation into phrases. Ending a *turn* is a different
// question from ending a *phrase* — a phrase ends at any pause, a turn ends when you
// have actually stopped — so turnDecision sits on top of the same signal with a much
// longer fuse.
//
// THE ECHO PROBLEM. An open microphone hears the interviewer. Browser echo cancellation
// helps but is not a guarantee, and a loop where the interviewer transcribes its own
// question as your answer would be both baffling and expensive. So the microphone is
// held shut while it speaks and opens the instant it stops. Interrupting is therefore
// deliberate — a key, not a shout — which is a real difference from a human interviewer
// and is worth knowing about.

/* ============================== pure ============================== */

/** Quiet for this long, after you have said something, means you are done. */
export const END_OF_TURN_MS = 2200;
/** Below this, a "turn" is a cough. */
export const MIN_TURN_CHARS = 2;

/**
 * Should the answer be sent now?
 *
 * @param {{sinceLoud:number, chars:number, speaking:boolean, busy:boolean, pending:number}} s
 *   sinceLoud  ms since the microphone last heard speech
 *   chars      characters transcribed so far this turn
 *   speaking   the interviewer is talking
 *   busy       a turn is already in flight
 *   pending    phrases still being transcribed
 * @returns {'wait'|'send'}
 */
export function turnDecision({ sinceLoud, chars, speaking, busy, pending }) {
  if (speaking || busy) return 'wait';
  if (chars < MIN_TURN_CHARS) return 'wait';
  // Text still in flight would arrive after the turn was sent and be silently lost, or
  // worse, be prepended to the next answer.
  if (pending > 0) return 'wait';
  return sinceLoud >= END_OF_TURN_MS ? 'send' : 'wait';
}

/** Markdown and code read terribly aloud. Spoken text is not written text. */
export function stripForSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' code block ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|$)/g, '$1$2')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cut text into utterances that can be spoken as they arrive.
 *
 * Waiting for the whole question before speaking adds its entire generation time to the
 * silence. Speaking each sentence as it completes means the interviewer starts talking
 * about as soon as a human would.
 *
 * Returns `{ ready, rest }` — complete sentences, and the tail still being written.
 */
export function splitForSpeech(buffer) {
  const text = String(buffer ?? '');
  const ready = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!'.?!'.includes(text[i])) continue;
    // "e.g." and "200M." are not sentence ends; a following space and capital is.
    const next = text[i + 1];
    if (next !== undefined && !/\s/.test(next)) continue;
    const piece = text.slice(start, i + 1).trim();
    if (piece.length >= 2) { ready.push(piece); start = i + 1; }
  }
  return { ready, rest: text.slice(start) };
}

/* ============================== the voice ============================== */

const VOICE_HINTS = ['Samantha', 'Ava', 'Allison', 'Serena', 'Daniel', 'Alex'];

function pickVoice(synth) {
  const voices = synth.getVoices?.() ?? [];
  if (!voices.length) return null;
  for (const hint of VOICE_HINTS) {
    const found = voices.find((v) => v.name?.includes(hint) && /^en/i.test(v.lang ?? ''));
    if (found) return found;
  }
  return voices.find((v) => /^en[-_]US/i.test(v.lang ?? '')) ?? voices.find((v) => /^en/i.test(v.lang ?? '')) ?? null;
}

export function speechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

/**
 * A mouth for the interviewer.
 *
 * `say` queues a sentence. `cancel` stops immediately and empties the queue — that is
 * the interrupt. `onStateChange(speaking)` fires on every transition, and the caller
 * uses it to hold the microphone shut.
 */
export function createSpeaker({ onStateChange = () => {}, rate = 1.04 } = {}) {
  if (!speechSupported()) {
    return {
      supported: false,
      say() {}, cancel() {}, get speaking() { return false; }, dispose() {},
    };
  }
  const synth = window.speechSynthesis;
  let voice = pickVoice(synth);
  let speaking = false;
  let disposed = false;
  // Voices load asynchronously in Chrome; the first call often sees an empty list.
  const onVoices = () => { voice = pickVoice(synth) ?? voice; };
  synth.addEventListener?.('voiceschanged', onVoices);

  function setSpeaking(next) {
    if (speaking === next) return;
    speaking = next;
    onStateChange(next);
  }

  return {
    supported: true,

    say(text) {
      if (disposed) return;
      const clean = stripForSpeech(text);
      if (!clean) return;
      const utterance = new SpeechSynthesisUtterance(clean);
      if (voice) utterance.voice = voice;
      utterance.rate = rate;
      utterance.onstart = () => setSpeaking(true);
      // `speaking` follows the queue, not one utterance: the gap between two queued
      // sentences must not read as "your turn".
      const settle = () => { if (!synth.speaking && !synth.pending) setSpeaking(false); };
      utterance.onend = settle;
      utterance.onerror = settle;
      synth.speak(utterance);
      setSpeaking(true);
    },

    cancel() {
      if (disposed) return;
      try { synth.cancel(); } catch { /* nothing queued */ }
      setSpeaking(false);
    },

    get speaking() { return speaking; },

    dispose() {
      disposed = true;
      try { synth.cancel(); } catch { /* noop */ }
      synth.removeEventListener?.('voiceschanged', onVoices);
    },
  };
}
