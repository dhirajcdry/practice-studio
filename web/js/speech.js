import { voicePreferences } from './speech-preferences.js';

// The interviewer's voice, and knowing when your turn is over.
//
// An interview you have to press Send to participate in is not an interview, it is a
// form. These are the two pieces that close the loop: the question is spoken aloud, and
// going quiet is what ends your answer.
//
// SPEECH OUT uses local Kokoro when available, with browser speech as a fallback.
// Cancellation owns both playback and pending synthesis.
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
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$/gm, ' ')
    .replace(/^\s*\|\s*/gm, '')
    .replace(/\s*\|\s*/g, ', ')
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
  let fenced = false;
  for (let i = 0; i < text.length; i += 1) {
    if (text.startsWith('```', i)) { fenced = !fenced; i += 2; continue; }
    if (fenced) continue;
    if (!'.?!'.includes(text[i])) continue;
    // "e.g." and "200M." are not sentence ends; a following space and capital is.
    let end = i + 1;
    while (end < text.length && /[\"'”’)*_\]]/.test(text[end])) end++;
    const next = text[end];
    // A terminal mark is held until a following chunk supplies whitespace. The
    // caller flushes the final `rest` once generation is complete.
    if (next === undefined || !/\s/.test(next)) continue;
    const before = text.slice(0, i + 1);
    // Hold common abbreviations and decimal numbers until the next chunk clarifies
    // whether this is really a sentence boundary.
    if (i > 0 && /\d\.\d$/.test(before)) continue;
    if (/(?:^|\s)(?:e\.g|i\.e|dr|mr|mrs|ms|prof|sr|jr|vs)\.$/i.test(before)) continue;
    const piece = text.slice(start, end).trim();
    if (piece.length >= 2) { ready.push(piece); start = end; }
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
  return typeof window !== 'undefined' && (typeof window.Audio === 'function' || ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window));
}

/**
 * A mouth for the interviewer.
 *
 * `say` queues a sentence. `cancel` stops immediately and empties the queue — that is
 * the interrupt. `onStateChange(speaking)` fires on every transition, and the caller
 * uses it to hold the microphone shut.
 */
export function createSpeaker({ onStateChange = () => {}, onPlayback = () => {}, preferences = voicePreferences } = {}) {
  const synth = typeof window !== 'undefined' ? window.speechSynthesis : null;
  let disposed = false, speaking = false, generation = 0, running = false;
  let queue = [], active = null, audio = null, finishPlayback = null;
  let status = null, failed = false;
  let playback = { phase: 'idle', text: '', engine: null };
  const controllers = new Set();
  const setSpeaking = next => {
    if (speaking !== next) { speaking = next; onStateChange(next); }
  };
  const setPlayback = (phase, item = null, engine = null, message) => {
    playback = { phase, text: item?.text ?? '', engine, ...(message ? { message } : {}) };
    try { onPlayback({ ...playback }); } catch { /* observers must not break playback */ }
  };
  async function request(url, options = {}) {
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw Error('Speech unavailable');
      return url.endsWith('/status') ? await response.json() : await response.blob();
    } finally { clearTimeout(timer); controllers.delete(controller); }
  }
  function prepare(item) {
    if (item.prepared) return;
    // Catch here: a prefetched failure must never become an unhandled rejection.
    item.prepared = (async () => {
      if (item.options.engine === 'system' || failed) return null;
      status ??= request('/api/tts/status');
      if (!(await status).available || item.generation !== generation) return null;
      return await request('/api/tts', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: item.text, voice: item.options.voice, speed: item.options.speed }),
      });
    })().catch(() => { if (item.generation === generation) failed = true; return null; });
  }
  function systemSpeak(item) {
    if (!synth || !window.SpeechSynthesisUtterance) return Promise.reject(Error('System speech unavailable'));
    return new Promise((resolve, reject) => {
      const token = item.generation;
      let settled = false;
      const start = () => {
        if (!settled && token === generation && !disposed) {
          setSpeaking(true);
          setPlayback('speaking', item, 'system');
        }
      };
      const done = () => { if (!settled) { settled = true; resolve(); } };
      finishPlayback = resolve;
      const utterance = new window.SpeechSynthesisUtterance(item.text);
      const voice = pickVoice(synth);
      if (voice) utterance.voice = voice;
      utterance.rate = item.options.speed;
      utterance.onstart = start;
      utterance.onend = done;
      utterance.onerror = () => { if (!settled) { settled = true; reject(Error('System speech failed')); } };
      try { synth.speak(utterance); } catch (error) { if (!settled) { settled = true; reject(error); } }
    });
  }
  async function play(blob, item) {
    audio ??= new window.Audio();
    const url = URL.createObjectURL(blob);
    try {
      await new Promise((resolve, reject) => {
        finishPlayback = resolve;
        let ended = false;
        audio.onended = () => { ended = true; resolve(); };
        audio.onerror = () => { ended = true; reject(Error('Audio playback failed')); };
        audio.src = url;
        Promise.resolve(audio.play()).then(() => {
          // `play()` resolving is the first reliable signal that audio actually
          // started; don't label synthesis/preload as speaking.
          if (!ended && item.generation === generation && !disposed) {
            setSpeaking(true);
            setPlayback('speaking', item, 'natural');
          }
        }).catch(reject);
      });
    } finally {
      if (audio.src === url) audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    }
  }
  async function drain(token) {
    running = true;
    try {
      while (queue.length && token === generation && !disposed) {
        active = queue.shift();
        const item = active;
        setPlayback('preparing', item, null);
        prepare(item);
        if (queue[0]) prepare(queue[0]);
        const blob = await item.prepared;
        if (token !== generation || disposed) return;
        if (blob) {
          try { await play(blob, item); }
          catch (error) {
            if (token !== generation) return;
            failed = true;
            try { await systemSpeak(item); }
            catch (fallbackError) {
              if (token !== generation || disposed) return;
              setPlayback('error', item, null, fallbackError?.message || error?.message || 'Speech failed');
              queue = [];
              return;
            }
          }
        } else {
          try { await systemSpeak(item); }
          catch (error) {
            if (token === generation) { setPlayback('error', item, null, error?.message || 'Speech unavailable'); queue = []; }
          }
        }
        if (token !== generation) return;
        active = null; finishPlayback = null;
      }
    } finally {
      if (token === generation) { running = false; active = null; setSpeaking(false); if (playback.phase !== 'error') setPlayback('idle'); }
    }
  }
  function cancel() {
    generation += 1;
    queue = []; active = null; running = false;
    for (const controller of controllers) controller.abort();
    controllers.clear(); status = null;
    if (audio) { audio.pause(); audio.onended = audio.onerror = null; }
    try { synth?.cancel(); } catch { /* already stopped */ }
    finishPlayback?.(); finishPlayback = null;
    setSpeaking(false);
    setPlayback('idle');
  }
  return {
    supported: speechSupported(),
    prepare() {
      if (disposed || preferences().engine === 'system' || failed) return Promise.resolve(null);
      status ??= request('/api/tts/status');
      return status.catch(() => null);
    },
    say(text) {
      if (disposed) return;
      const clean = stripForSpeech(text);
      if (!clean) return;
      const { ready, rest } = splitForSpeech(clean);
      for (const sentence of [...ready, ...(rest.trim() ? [rest.trim()] : [])]) {
        const options = preferences();
        queue.push({ text: sentence, options, generation });
        // Gate the microphone throughout preparation for either engine. Captions
        // still use the actual playback phase, which changes only on audio start.
        setSpeaking(true);
      }
      if (!running) void drain(generation);
      else if (queue[0]) prepare(queue[0]);
    },
    cancel,
    get speaking() { return speaking; },
    get playback() { return { ...playback }; },
    dispose() { cancel(); disposed = true; },
  };
}
