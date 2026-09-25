// Dictation into the coach composer (ARCHITECTURE.md §7, API-CONTRACT-P2.md Phase 5).
//
// Click to speak, click to stop, and the words appear in the box as you say them —
// this stands in for typing, so it behaves like typing. It always writes a DRAFT: the
// microphone never sends a message, it only fills the box for you to read first.
//
// Thinking aloud through a whole attempt is a different job and belongs to the floating
// recorder; speech recorded here is not counted as practice.
//
// Three rules this file exists to keep, in order of importance:
//
//   1. Recording never starts without an explicit press. There is no
//      voice-activation, no "always listening", no start on page load.
//   2. While the microphone is live it is unmistakable on screen, and the moment
//      it is not, every track is stopped — so the operating system's own
//      recording indicator goes out too. A stopped recorder with a live track is
//      still a hot microphone.
//   3. A recording with no speech in it is an ERROR and is shown as one. An empty
//      transcript is never dressed up as a successful take.

import { el, clear, replace } from './dom.js';
import { transcribeAudio, logSessionEvent } from './api.js';

/** A hard ceiling, so a stuck key cannot leave the microphone open all afternoon. */
const MAX_TAKE_MS = 5 * 60 * 1000;
/** Below this there is nothing to transcribe — say so rather than posting silence. */
const MIN_TAKE_MS = 500;

/* ============================== shaping (pure) ============================== */

/** A pause this long ends a phrase. Shorter, and ordinary hesitation cuts a sentence. */
export const SILENCE_MS = 700;
/** Nothing shorter is worth a round trip. */
export const MIN_PHRASE_MS = 900;
/** A monologue with no pauses still arrives, in pieces, rather than after it ends. */
export const MAX_PHRASE_MS = 12_000;

/**
 * When to close the current phrase — the whole of the cutting logic, with no audio in it.
 *
 * @param {{age:number, sinceLoud:number, hadSpeech:boolean}} state
 *   age        ms since this phrase started
 *   sinceLoud  ms since the last frame loud enough to be speech
 *   hadSpeech  whether this phrase has heard anything at all
 * @returns {'wait'|'cut'|'drop'} cut sends it to be transcribed; drop bins it as silence
 */
export function phraseDecision({ age, sinceLoud, hadSpeech }) {
  if (!hadSpeech) return age > MAX_PHRASE_MS ? 'drop' : 'wait';
  if (age > MAX_PHRASE_MS) return 'cut';
  if (age > MIN_PHRASE_MS && sinceLoud > SILENCE_MS) return 'cut';
  return 'wait';
}

/**
 * Turn a getUserMedia rejection into something a person can act on. The browser's
 * own wording ("Permission denied") does not say what to do next.
 * @param {any} error
 * @returns {{head:string, body:string}}
 */
export function describeMicError(error) {
  const name = (error && (error.name || error.constructor?.name)) || '';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        head: 'Microphone blocked',
        body: 'This page was refused access to the microphone. Allow it for 127.0.0.1 in your browser’s site settings, then press Speak again. Nothing was recorded.',
      };
    case 'NotFoundError':
    case 'OverconstrainedError':
      return {
        head: 'No microphone found',
        body: 'The browser could not find an input device. Plug one in or pick one in your system sound settings, then try again.',
      };
    case 'NotReadableError':
      return {
        head: 'Microphone is busy',
        body: 'Another application is holding the microphone, so this page could not open it. Close that app and try again.',
      };
    case 'AbortError':
      return { head: 'Recording stopped', body: 'The microphone was released before anything was captured.' };
    default:
      return {
        head: 'Microphone unavailable',
        body: `The microphone could not be opened${error?.message ? `: ${error.message}` : ''}. Nothing was recorded.`,
      };
  }
}

/**
 * Turn a transcription outcome into the notice the panel shows. Kept pure and
 * separate because the one failure that matters — a take with no speech in it —
 * must never be able to render as a success.
 *
 * @param {object} result what `transcribeAudio` resolved to
 * @returns {{ok:boolean, tone:string, head:string, body:string}}
 */
export function shapeTranscription(result) {
  if (result && result.ok === true) {
    return { ok: true, tone: '', head: 'Transcribed', body: result.text };
  }
  const kind = result?.kind || 'server';
  const message = result?.message || 'The recording could not be transcribed.';
  const HEADS = {
    empty_transcript: 'Nothing was heard',
    no_audio: 'No audio in that take',
    unavailable: 'This server cannot transcribe yet',
    offline: 'The studio server is not answering',
    timeout: 'The transcriber never came back',
    cancelled: 'Recording discarded',
    too_short: 'That take was too short',
    mic: 'Microphone unavailable',
  };
  return {
    ok: false,
    tone: kind === 'cancelled' || kind === 'too_short' ? 'warn' : (kind === 'unavailable' || kind === 'offline' ? 'warn' : 'err'),
    head: HEADS[kind] || 'The recording was not transcribed',
    body: message,
  };
}

/** mm:ss, for the recording clock. */
export function formatTake(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The recorder's preferred container, or '' to let the browser choose. */
function pickMimeType() {
  const Recorder = window.MediaRecorder;
  if (!Recorder || typeof Recorder.isTypeSupported !== 'function') return '';
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']) {
    if (Recorder.isTypeSupported(type)) return type;
  }
  return '';
}

function extensionFor(mimeType) {
  if (/mp4|m4a/.test(mimeType)) return 'm4a';
  if (/ogg/.test(mimeType)) return 'ogg';
  if (/wav/.test(mimeType)) return 'wav';
  return 'webm';
}

/** True when this browser can record at all. Checked before the button is drawn. */
export function voiceSupported() {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
}

/** The little microphone on the button — drawn, not a font glyph. */
function micGlyph() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 12 14');
  svg.setAttribute('width', '11');
  svg.setAttribute('height', '13');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS(ns, 'rect');
  body.setAttribute('x', '4'); body.setAttribute('y', '1');
  body.setAttribute('width', '4'); body.setAttribute('height', '7');
  body.setAttribute('rx', '2');
  body.setAttribute('fill', 'currentColor');
  const arc = document.createElementNS(ns, 'path');
  arc.setAttribute('d', 'M2 7a4 4 0 0 0 8 0M6 11v2');
  arc.setAttribute('stroke', 'currentColor');
  arc.setAttribute('stroke-width', '1.3');
  arc.setAttribute('fill', 'none');
  arc.setAttribute('stroke-linecap', 'round');
  svg.append(body, arc);
  return svg;
}

/* ============================== the control ============================== */

/**
 * Build the dictation control: the speak button, the recording indicator, and a status
 * line that says nothing at all unless something went wrong.
 *
 * @param {object} options
 * @param {() => string} options.getSlug        the problem being recorded against
 * @param {(text:string, meta:object) => void} options.onTranscript  called only on a real transcript
 * @param {(state:string) => void} [options.onState]  'idle' | 'recording' | 'working'
 * @returns {{root:HTMLElement, isRecording:() => boolean, stop:() => void, dispose:() => void}}
 */
export function createVoiceControl({
  getSlug, onTranscript, onState = () => {}, logTakes = true, onLevel = () => {},
}) {
  // Dictation, not think-aloud. The floating recorder owns thinking aloud; this is here
  // so a long message to the coach can be spoken instead of typed, and it must not be
  // counted as practice speech.
  let mode = 'dictation';
  let state = 'idle';            // idle | opening | recording | working
  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let ticker = null;
  let capTimer = null;
  let wantRecording = false;     // the button is *currently* held
  let disposed = false;

  const clock = el('span', { class: 'mono tnum vc-clock', text: '0:00' });
  const indicator = el('span', { class: 'vc-rec', hidden: true }, [
    el('i', { class: 'vc-dot' }),
    el('span', { class: 'mono', text: 'Recording' }),
    clock,
  ]);

  const talkLabel = el('span', { text: 'Speak' });
  const talkButton = el('button', {
    class: 'vc-talk', type: 'button',
    'aria-label': 'Record a message for the coach. Click again to stop.',
  }, [micGlyph(), talkLabel]);

  const status = el('div', { class: 'vc-status', hidden: true });

  const root = el('div', { class: 'vc' }, [
    el('div', { class: 'vc-row' }, [talkButton, el('span', { class: 'spacer' }), indicator]),
    status,
  ]);

  function note(tone, head, body) {
    if (!head && !body) { status.hidden = true; clear(status); return; }
    status.hidden = false;
    status.className = 'vc-status ' + (tone || '');
    replace(status, [
      head ? el('span', { class: 'mono vc-statushead', text: head }) : null,
      el('span', { class: 'vc-statusbody', text: body }),
    ]);
  }

  function setState(next) {
    state = next;
    root.classList.toggle('is-recording', next === 'recording');
    root.classList.toggle('is-working', next === 'working');
    indicator.hidden = next !== 'recording';
    talkButton.setAttribute('aria-pressed', String(next === 'recording'));
    talkButton.disabled = next === 'working';
    talkLabel.textContent = next === 'recording' ? 'Stop'
      : next === 'working' ? 'Transcribing…'
      : next === 'opening' ? 'Opening mic…'
      : 'Speak';
    onState(next === 'opening' ? 'recording' : next);
  }

  /** The one place tracks are released. Called from every exit, success or not. */
  function releaseMicrophone() {
    if (stream) {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch { /* already gone */ }
      }
    }
    stream = null;
    clearInterval(ticker); ticker = null;
    clearTimeout(capTimer); capTimer = null;
    closeAudio();
  }

  /* ---- live dictation: phrases in, text out, while you are still talking ---- */
  //
  // It used to record the whole take, stop, upload, wait, and paste. Which is not
  // dictation — it is a voice memo with a transcription step, and it meant sitting in
  // silence not knowing whether the microphone had heard anything.
  //
  // Now the take is cut into phrases and each one is transcribed as it ends, so the
  // words appear in the box a beat behind your voice, the way dictation is supposed to
  // work. The cut is made at a PAUSE, never on a timer: a fixed six-second window would
  // slice through the middle of words and hand back mangled text. Silence is where
  // speech already has its seams.
  //
  // Audio still never leaves this machine — the transcriber is the local one, and this
  // only changes how often it is asked.

  /** How loud counts as speech, over the room's own noise floor. */
  const SPEECH_RMS = 0.012;

  let audioCtx = null;
  let analyser = null;
  let levelTimer = null;
  let samples = null;
  let noiseFloor = 0.004;
  let lastLoudAt = 0;
  let phraseStartedAt = 0;
  let phraseHadSpeech = false;
  let sending = 0;             // phrases in flight
  let seq = 0;                 // order in, order out
  let nextToEmit = 0;
  const held = new Map();      // seq -> text, waiting for its turn
  let spokenChars = 0;

  function closeAudio() {
    clearInterval(levelTimer); levelTimer = null;
    analyser = null;
    if (audioCtx) { try { audioCtx.close(); } catch { /* already closed */ } }
    audioCtx = null;
  }

  /** RMS of the current frame, 0..1. */
  function level() {
    if (!analyser || !samples) return 0;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
    return Math.sqrt(sum / samples.length);
  }

  function watchLevel() {
    levelTimer = setInterval(() => {
      if (state !== 'recording' || !recorder) return;
      const now = Date.now();
      const rms = level();
      // The floor drifts down toward the quietest thing heard, so a noisy room does not
      // read as continuous speech and a silent one does not need a magic constant.
      noiseFloor = rms < noiseFloor ? rms : noiseFloor * 0.995 + rms * 0.005;
      const loud = rms > Math.max(SPEECH_RMS, noiseFloor * 3);
      if (loud) { lastLoudAt = now; phraseHadSpeech = true; }

      // The same signal, offered to whoever is listening. The design interview uses it
      // to decide the turn is over; nothing here needs to know that.
      onLevel({ loud, sinceLoud: now - lastLoudAt, pending: sending });

      const decision = phraseDecision({
        age: now - phraseStartedAt,
        sinceLoud: now - lastLoudAt,
        hadSpeech: phraseHadSpeech,
      });
      // 'drop' recycles a buffer of pure room tone rather than posting it.
      if (decision === 'cut') cutPhrase();
      else if (decision === 'drop') cutPhrase({ drop: true });
    }, 100);
  }

  /** Close the current phrase; a new one starts immediately unless the take is over. */
  function cutPhrase({ drop = false, final = false, force = false } = {}) {
    if (!recorder) return;
    const current = recorder;
    const hadSpeech = (phraseHadSpeech || force) && !drop;
    const startedThisPhrase = phraseStartedAt;
    recorder = null;

    current.addEventListener('stop', () => {
      const blob = chunks.length ? new Blob(chunks, { type: current.mimeType || 'audio/webm' }) : null;
      chunks = [];
      if (hadSpeech && blob && blob.size > 0) {
        sendPhrase(blob, current.mimeType, Date.now() - startedThisPhrase);
      }
      if (!final && state === 'recording' && stream) beginPhrase();
      else if (final) settle();
    }, { once: true });

    try { current.stop(); } catch { if (final) settle(); }
  }

  function beginPhrase() {
    if (!stream || disposed) return;
    const mimeType = pickMimeType();
    try {
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (error) {
      releaseMicrophone();
      setState('idle');
      note('err', 'Recorder unavailable', `This browser refused to open a recorder${error?.message ? `: ${error.message}` : ''}. Nothing was recorded.`);
      return;
    }
    chunks = [];
    phraseStartedAt = Date.now();
    lastLoudAt = phraseStartedAt;
    phraseHadSpeech = false;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data);
    });
    recorder.addEventListener('error', () => {
      releaseMicrophone();
      setState('idle');
      note('err', 'Recording failed', 'The browser stopped the recorder mid-take. Anything already transcribed is still in the box.');
    });
    recorder.start();
  }

  async function sendPhrase(blob, mimeType, ms) {
    const mine = seq;
    seq += 1;
    sending += 1;
    let text = '';
    try {
      const result = await transcribeAudio(getSlug(), blob, {
        filename: `phrase.${extensionFor(mimeType)}`,
        mode,
      });
      const shaped = shapeTranscription(result);
      if (shaped.ok) text = result.text;
      // A phrase that came back empty is not an error worth interrupting for: you
      // paused, or coughed. The take as a whole is checked when it ends.
      else if (shaped.tone === 'err') note(shaped.tone, shaped.head, shaped.body);
    } catch {
      note('err', 'Transcription failed', 'That phrase could not be transcribed. The microphone is still open.');
    }
    sending -= 1;
    emitInOrder(mine, text, ms);
    settle();
  }

  /**
   * Phrases are transcribed in parallel, so they can finish out of order — and text
   * arriving out of order is worse than text arriving slowly. Each one waits for its turn.
   */
  function emitInOrder(mine, text, ms) {
    held.set(mine, { text, ms });
    while (held.has(nextToEmit)) {
      const entry = held.get(nextToEmit);
      held.delete(nextToEmit);
      nextToEmit += 1;
      if (disposed) continue;
      if (entry.text && entry.text.trim() !== '') {
        spokenChars += entry.text.length;
        onTranscript(entry.text.trim(), { mode, durationSeconds: Math.round(entry.ms / 1000), live: true });
      }
    }
  }

  /** The take is over and nothing is still in flight: close the books. */
  function settle() {
    if (state !== 'working' || sending > 0 || recorder) return;
    setState('idle');
    const elapsed = Date.now() - startedAt;
    if (spokenChars === 0) {
      note('warn', 'Nothing heard', 'The microphone was open but no speech was transcribed. Nothing was added to the box.');
    } else {
      note('', '', '');
      // A system design interview has no problem slug and keeps its own record, so
      // there is no session log to append to. Dictating there must not post an event
      // that can only be rejected.
      if (!logTakes) return;
      logSessionEvent(getSlug(), 'recorded_audio', {
        mode,
        durationSeconds: Math.round(elapsed / 1000),
        characters: spokenChars,
      }).catch(() => {});
    }
  }

  async function start() {
    if (disposed || state === 'recording' || state === 'opening' || state === 'working') return;
    if (!voiceSupported()) {
      note('err', 'Voice needs a newer browser', 'This browser has no MediaRecorder, so recording is not possible here. Typing to the coach still works.');
      return;
    }
    wantRecording = true;
    setState('opening');

    let granted;
    try {
      // Asked for explicitly rather than left to the default: in the design interview the
      // speakers are playing the interviewer while this microphone is open.
      granted = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      wantRecording = false;
      setState('idle');
      const described = describeMicError(error);
      note('err', described.head, described.body);
      return;
    }

    // The button may have been pressed again while the permission prompt was up. That is
    // not a recording, and the microphone must not stay open for it.
    if (!wantRecording || disposed) {
      for (const track of granted.getTracks()) track.stop();
      setState('idle');
      return;
    }

    stream = granted;
    seq = 0;
    nextToEmit = 0;
    held.clear();
    spokenChars = 0;
    sending = 0;
    noiseFloor = 0.004;

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // A context created without a gesture starts suspended, and a suspended analyser
      // reports pure silence forever — which reads as "you never spoke" and throws the
      // whole take away. Ask for it to run before trusting a single sample.
      if (audioCtx.state === 'suspended') await audioCtx.resume().catch(() => {});
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      audioCtx.createMediaStreamSource(stream).connect(analyser);
    } catch {
      // No level metering: fall back to fixed-length phrases rather than no dictation.
      closeAudio();
    }

    startedAt = Date.now();
    setState('recording');
    beginPhrase();
    if (!recorder) return;            // beginPhrase already reported why
    note('', '', '');
    clock.textContent = '0:00';
    ticker = setInterval(() => { clock.textContent = formatTake(Date.now() - startedAt); }, 250);
    if (analyser) watchLevel();
    else levelTimer = setInterval(() => { if (state === 'recording') cutPhrase(); }, 6000);
    capTimer = setTimeout(() => {
      if (state !== 'recording') return;
      stop();
      note('warn', 'Five minutes', 'That is the longest the microphone stays open in one go, so it was closed here.');
    }, MAX_TAKE_MS);
  }

  function stop() {
    wantRecording = false;
    if (state === 'opening') { setState('idle'); return; }
    if (state !== 'recording') return;
    clearInterval(ticker); ticker = null;
    clearTimeout(capTimer); capTimer = null;
    // Tracks first, so the operating system's recording indicator goes out the moment
    // you press Stop rather than whenever the last phrase finishes uploading.
    const last = recorder;
    setState('working');
    // If the meter never heard anything all take, send the audio anyway rather than
    // silently discarding it. Metering is an optimisation; the recording is the point.
    if (last) cutPhrase({ final: true, force: seq === 0 && Date.now() - startedAt > MIN_PHRASE_MS });
    releaseMicrophone();
    if (!last) settle();
  }

  /* ---- the gesture: click to start, click to stop ---- */
  //
  // It used to be press-and-hold. That is fine for a two-second push-to-talk and wrong
  // for this: dictating a paragraph meant holding the mouse button down for a minute,
  // unable to move the pointer, look at your code, or think. A toggle costs one extra
  // click and gives the whole time back.
  //
  // Nothing here starts recording on its own, which is the property worth keeping — a
  // microphone that opens without being asked is not a feature.

  const release = () => { if (wantRecording || state === 'recording') stop(); };

  talkButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (state === 'recording' || state === 'opening' || wantRecording) stop();
    else start();
  });

  // A tab that goes away mid-take should not leave the microphone live behind it.
  window.addEventListener('blur', () => { if (state === 'recording') stop(); });

  if (!voiceSupported()) {
    talkButton.disabled = true;
    note('warn', 'No microphone here', 'This browser cannot record audio, so voice is off. The coach still reads what you type.');
  }

  return {
    root,
    start,
    isRecording: () => state === 'recording' || state === 'opening',
    currentMode: () => mode,
    stop,
    dispose() {
      disposed = true;
      wantRecording = false;
      try { recorder?.stop(); } catch { /* noop */ }
      recorder = null;
      releaseMicrophone();
      window.removeEventListener('blur', release);
    },
  };
}
