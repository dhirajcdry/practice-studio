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

import { icon } from './ui/icon.js';
import { el, clear, replace } from './dom.js';
import { transcribeAudio, logSessionEvent } from './api.js';
import { filterTranscript, hasVoicedAudio } from './transcript-filter.js';

/** A hard ceiling, so a stuck key cannot leave the microphone open all afternoon. */
const MAX_TAKE_MS = 5 * 60 * 1000;
/** Below this there is nothing to transcribe — say so rather than posting silence. */
const PREVIEW_MS = 900;

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
        body: 'This page was refused access to the microphone. Allow it for 127.0.0.1 in your browser’s site settings, then try the microphone again. Nothing was recorded.',
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
 * @param {(text:string) => void} [options.onPreview]  provisional text, empty when cleared
 * @param {(state:string) => void} [options.onState]  'idle' | 'opening' | 'recording' | 'working'
 * @returns {{root:HTMLElement, isRecording:() => boolean, flush:() => Promise<void>, stop:() => void, dispose:() => void}}
 */
export function createVoiceControl({
  getSlug, onTranscript, onPreview, onState = () => {}, logTakes = true, onLevel = () => {},
  recordingMode = 'dictation', getAttemptId = () => null, maxTakeMs = MAX_TAKE_MS,
  reportEmptyTake = true, onSettled = () => {},
}) {
  // Dictation, not think-aloud. The floating recorder owns thinking aloud; this is here
  // so a long message to the coach can be spoken instead of typed, and it must not be
  // counted as practice speech.
  let mode = recordingMode;
  let state = 'idle';            // idle | opening | recording | working
  let stream = null;
  let recorder = null;
  let chunks = [];
  let startedAt = 0;
  let ticker = null;
  let capTimer = null;
  let wantRecording = false;     // the button is *currently* held
  let disposed = false;
  let finishing = false;

  const clock = el('span', { class: 'mono tnum vc-clock', text: '0:00' });
  const indicator = el('span', { class: 'vc-rec', hidden: true }, [
    el('i', { class: 'vc-dot' }),
    el('span', { class: 'mono', text: 'Recording' }),
    clock,
  ]);

  const talkLabel = el('span', { text: 'Speak' });
  const talkButton = el('button', {
    class: 'btn btn--quiet vc-talk', type: 'button',
    'aria-label': 'Record a message for the coach. Click again to stop.',
  }, [micGlyph(), talkLabel]);

  const status = el('div', { class: 'vc-status', hidden: true, role: 'status' });
  const preview = el('div', { class: 'vc-preview', hidden: true, 'aria-label': 'Live transcript preview', 'aria-live': 'polite' });

  const root = el('div', { class: 'vc' }, [
    el('div', { class: 'vc-row' }, [talkButton, el('span', { class: 'spacer' }), indicator]),
    preview, status,
  ]);

  function note(tone, head, body) {
    if (!head && !body) { status.hidden = true; clear(status); return; }
    status.hidden = false;
    status.className = 'vc-status ' + (tone || '');
    replace(status, [
      head ? el('span', { class: 'mono vc-statushead', text: head }) : null,
      body ? el('span', { class: 'vc-statusbody', text: body }) : null,
      el('button', { class: 'btn btn--icon icon-btn vc-dismiss', type: 'button', 'aria-label': 'Dismiss microphone notice', onclick: () => { if (!failedPhrases.size) note('', '', ''); } }, icon('close')),
    ]);
  }

  function setState(next) {
    state = next;
    // The guard follows actual work, including a detached take's final request. An
    // idle mounted composer must not make every page reload ask for confirmation.
    if (next === 'idle') {
      if (!failedPhrases.size || finishing) window.removeEventListener('beforeunload', beforeUnload);
      if (finishing) { finishing = false; disposed = true; }
    } else window.addEventListener('beforeunload', beforeUnload);
    root.classList.toggle('is-recording', next === 'recording');
    root.classList.toggle('is-working', next === 'working');
    indicator.hidden = next !== 'recording';
    talkButton.setAttribute('aria-pressed', String(next === 'recording'));
    talkButton.disabled = next === 'working';
    talkButton.setAttribute('aria-label', next === 'recording' ? 'Stop recording'
      : next === 'working' ? 'Transcribing' : 'Record a message for the coach');
    talkLabel.textContent = next === 'recording' ? 'Stop'
      : next === 'working' ? 'Transcribing…'
      : next === 'opening' ? 'Opening mic…'
      : 'Speak';
    onState(next);
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
  let voicedMs = 0, sustainedMs = 0, currentVoicedMs = 0, energy = 0;
  let closing = 0;
  let sending = 0;             // phrases in flight
  let seq = 0;                 // order in, order out
  let nextToEmit = 0;
  const held = new Map();      // seq -> text, waiting for its turn
  let spokenChars = 0;
  let takeError = false;
  let retryWhenSettled = false;
  const failedPhrases = new Map();
  let previewBusy = false;
  let lastPreviewAt = 0;
  let previewController = null;
  let previewSequence = null;
  let takeGeneration = 0;
  let currentSequence = null;
  const provisional = new Map();
  const finalized = new Set();
  const flushes = new Set();

  function settleFlushes() {
    for (const wait of flushes) {
      const error = disposed || wait.generation !== takeGeneration
        ? 'Recording changed before your last words were ready.'
        : takeError ? 'Some recorded words need retrying. Retry or discard the failed audio before sending.' : '';
      if (!error && nextToEmit <= wait.through) continue;
      flushes.delete(wait); clearTimeout(wait.timer);
      if (error) wait.reject(Error(error)); else wait.resolve();
    }
  }

  // Finish only the phrases captured so far. The physical microphone, meter and
  // next phrase stay live while ASR finishes, the model replies and audio plays.
  function flush() {
    return new Promise((resolve, reject) => {
      const wait = { through: seq - 1, generation: takeGeneration, resolve, reject };
      wait.timer = setTimeout(() => {
        flushes.delete(wait);
        reject(Error('Still transcribing your last words. Try again when they appear.'));
      }, 65000);
      flushes.add(wait);
      cutPhrase();
      settleFlushes();
    });
  }

  function paintPreview() {
    const text = [...provisional].sort(([a], [b]) => a - b).map(([, value]) => value).filter(Boolean).join(' ');
    if (onPreview) onPreview(text);
    else { preview.hidden = !text; preview.textContent = text; }
  }

  function clearPreview(through = Infinity) {
    for (const index of provisional.keys()) if (index <= through) provisional.delete(index);
    paintPreview();
    if (previewSequence !== null && previewSequence <= through) {
      previewController?.abort();
      previewController = null; previewSequence = null; previewBusy = false;
    }
  }

  async function showPreview(current, blob) {
    if (previewBusy || disposed || recorder !== current || state !== 'recording' || !phraseHadSpeech) return;
    previewBusy = true;
    const phraseSequence = currentSequence, generation = takeGeneration;
    const controller = new AbortController();
    previewController = controller; previewSequence = phraseSequence;
    try {
      const result = await transcribeAudio(getSlug(), blob, {
        filename: `preview.${extensionFor(current.mimeType)}`, mode: 'dictation', preview: true, signal: controller.signal,
      });
      if (!disposed && !controller.signal.aborted && generation === takeGeneration && phraseSequence >= nextToEmit && !finalized.has(phraseSequence) && result.ok) {
        provisional.set(phraseSequence, filterTranscript(result.text));
        paintPreview();
      }
    } finally {
      if (previewController === controller) { previewBusy = false; previewController = null; previewSequence = null; }
    }
  }

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
      const loud = rms > Math.max(SPEECH_RMS, noiseFloor * 3);
      // Learn the room from quiet frames, never from the speech we're capturing.
      // Otherwise a long answer raises its own threshold until it looks like silence.
      if (!loud) noiseFloor = rms < noiseFloor ? rms : noiseFloor * 0.995 + rms * 0.005;
      if (loud) {
        lastLoudAt = now;
        voicedMs += 100; currentVoicedMs += 100; energy += rms * rms * 100;
        sustainedMs = Math.max(sustainedMs, currentVoicedMs);
      } else currentVoicedMs = 0;
      phraseHadSpeech = hasVoicedAudio({ voicedMs, sustainedMs, energy });

      // The same signal, offered to whoever is listening. The design interview uses it
      // to decide the turn is over; nothing here needs to know that.
      onLevel({ loud: loud && phraseHadSpeech, level: Math.min(1, Math.sqrt(rms * 9)), elapsedMs: now - startedAt, sinceLoud: now - lastLoudAt, pending: sending + closing, failed: takeError });

      const decision = phraseDecision({
        age: now - phraseStartedAt,
        sinceLoud: now - lastLoudAt,
        hadSpeech: phraseHadSpeech,
      });
      // Unvoiced audio is discarded, including periodic cuts and Stop.
      if (decision === 'cut') cutPhrase();
      else if (decision === 'drop') cutPhrase({ drop: true });
      else if (now - lastPreviewAt >= PREVIEW_MS && now - phraseStartedAt >= PREVIEW_MS && !previewBusy) {
        lastPreviewAt = now;
        recorder?.requestData();
      }
    }, 100);
  }

  /** Close the current phrase; a new one starts immediately unless the take is over. */
  function cutPhrase({ drop = false, final = false } = {}) {
    if (!recorder) return;
    const current = recorder;
    const phraseSequence = currentSequence;
    const hadSpeech = phraseHadSpeech && !drop;
    const startedThisPhrase = phraseStartedAt;
    recorder = null;
    closing += 1;

    current.addEventListener('stop', () => {
      closing -= 1;
      if (disposed) return;
      const blob = chunks.length ? new Blob(chunks, { type: current.mimeType || 'audio/webm' }) : null;
      chunks = [];
      if (hadSpeech && blob && blob.size > 0) {
        sendPhrase(blob, current.mimeType, Date.now() - startedThisPhrase, phraseSequence);
      } else { finalized.add(phraseSequence); emitInOrder(phraseSequence, '', 0); }
      if (!final && state === 'recording' && stream) beginPhrase();
      else settle();
    }, { once: true });

    try { current.stop(); } catch { closing -= 1; settle(); }
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
    currentSequence = seq++;
    phraseStartedAt = Date.now();
    lastPreviewAt = phraseStartedAt;
    lastLoudAt = phraseStartedAt;
    phraseHadSpeech = false;
    voicedMs = sustainedMs = currentVoicedMs = energy = 0;
    const current = recorder;
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data && event.data.size > 0) {
        chunks.push(event.data);
        if (recorder === current && state === 'recording') {
          // Include the container header and all preceding chunks: a lone WebM chunk is not decodable.
          showPreview(current, new Blob(chunks, { type: current.mimeType || 'audio/webm' })).catch(() => {});
        }
      }
    });
    recorder.addEventListener('error', () => {
      releaseMicrophone();
      setState('idle');
      note('err', 'Recording failed', 'The browser stopped the recorder mid-take. Anything already transcribed is still in the box.');
    });
    recorder.start();
  }

  function showRecovery() {
    const reason = [...failedPhrases.values()][0]?.reason || 'Transcription failed.';
    note('err', 'Some words need another pass', `${reason} Audio is held temporarily in this tab for retry. Automatic sending is paused.`);
    status.append(el('button', {class:'btn btn--secondary',type:'button',text:'Retry transcription',onclick:retry}),
      el('button', {class:'btn btn--quiet',type:'button',text:'Discard failed audio',onclick:discardFailed}));
  }
  async function retry() {
    if (disposed || !failedPhrases.size) return;
    if (state !== 'idle' || sending || closing) { retryWhenSettled = true; stop(); return; }
    retryWhenSettled = false;
    setState('working'); note('', '', 'Retrying your recorded words…');
    await Promise.all([...failedPhrases].map(([index, phrase]) => sendPhrase(phrase.blob, phrase.mimeType, phrase.ms, index)));
  }
  function discardFailed() {
    if (disposed || state === 'working') return;
    const indices = [...failedPhrases.keys()]; failedPhrases.clear(); takeError = false; clearPreview();
    for (const index of indices) emitInOrder(index, '', 0);
    if (state === 'idle') window.removeEventListener('beforeunload', beforeUnload);
    note('warn', 'Failed audio discarded', 'Confirmed words remain in your answer.');
  }
  async function sendPhrase(blob, mimeType, ms, retryIndex) {
    const mine = retryIndex ?? seq++;
    let failed = false, reason = '';
    sending += 1;
    let text = '';
    try {
      const result = await transcribeAudio(getSlug(), blob, {
        filename: `phrase.${extensionFor(mimeType)}`,
        mode, attemptId: getAttemptId(),
      });
      const shaped = shapeTranscription(result);
      if (shaped.ok) text = filterTranscript(result.text);
      // A phrase that came back empty is not an error worth interrupting for: you
      // paused, or coughed. The take as a whole is checked when it ends.
      else if (!['no_audio', 'empty_transcript'].includes(result.kind)) {
        failed = true; reason = shaped.body;
      }
    } catch {
      failed = true; reason = 'The transcriber could not be reached.';
    }
    sending -= 1;
    if (disposed && !finishing) return;
    finalized.add(mine);
    if (failed) {
      failedPhrases.set(mine, {blob,mimeType,ms,reason}); held.set(mine, {failed:true}); takeError = true;
      showRecovery();
      settleFlushes();
    } else {
      provisional.set(mine, text); paintPreview();
      failedPhrases.delete(mine); takeError = failedPhrases.size > 0; emitInOrder(mine, text, ms);
    }
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
      if (entry.failed) break;
      const emittedIndex = nextToEmit;
      held.delete(nextToEmit);
      nextToEmit += 1;
      if (disposed && !finishing) continue;
      clearPreview(emittedIndex);
      if (entry.text && entry.text.trim() !== '') {
        spokenChars += entry.text.length;
        onTranscript(entry.text.trim(), { mode, durationSeconds: Math.round(entry.ms / 1000), live: true });
      }
    }
    settleFlushes();
  }

  /** The take is over and nothing is still in flight: close the books. */
  function settle() {
    if (state !== 'working' || sending > 0 || closing > 0 || recorder) return;
    setState('idle');
    const elapsed = Date.now() - startedAt;
    if (takeError) { if (retryWhenSettled) { retry(); return; } showRecovery(); return; }
    clearPreview();
    if (spokenChars === 0 && reportEmptyTake) {
      note('warn', '', 'No speech detected. Try again.');
    } else {
      note('', '', '');
      // A system design interview has no problem slug and keeps its own record, so
      // there is no session log to append to. Dictating there must not post an event
      // that can only be rejected.
      if (logTakes && spokenChars > 0) logSessionEvent(getSlug(), 'recorded_audio', {
        mode,
        durationSeconds: Math.round(elapsed / 1000),
        characters: spokenChars,
      }).catch(() => {});
    }
    onSettled();
  }

  async function start() {
    if (disposed || state === 'recording' || state === 'opening' || state === 'working') return;
    if (failedPhrases.size) { showRecovery(); return; }
    if (!voiceSupported()) {
      note('err', 'Voice needs a newer browser', 'This browser has no MediaRecorder, so recording is not possible here. Typing to the coach still works.');
      return;
    }
    wantRecording = true;
    takeGeneration += 1;
    settleFlushes();
    note('', '', '');
    clearPreview();
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
    for (const track of stream.getTracks()) track.addEventListener?.('ended', () => {
      if (state !== 'recording') return;
      stop(); note('warn', 'Microphone disconnected', 'Your confirmed words are kept. Reconnect the microphone to continue.');
    }, { once: true });
    seq = 0;
    nextToEmit = 0;
    held.clear();
    finalized.clear();
    spokenChars = 0;
    takeError = false;
    sending = 0;
    noiseFloor = 0.004;

    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // A context created without a gesture starts suspended, and a suspended analyser
      // reports pure silence forever — which reads as "you never spoke" and throws the
      // whole take away. Ask for it to run before trusting a single sample.
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      if (audioCtx.state !== 'running') throw new Error('Audio meter unavailable');
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 1024;
      samples = new Float32Array(analyser.fftSize);
      audioCtx.createMediaStreamSource(stream).connect(analyser);
    } catch {
      // Without a meter we cannot distinguish silence from a recording.
      closeAudio(); releaseMicrophone(); setState('idle');
      note('warn', 'Audio meter unavailable', 'Try opening the microphone again.');
      return;
    }

    if (!wantRecording || disposed) { releaseMicrophone(); setState('idle'); return; }
    startedAt = Date.now();
    setState('recording');
    beginPhrase();
    if (!recorder) return;            // beginPhrase already reported why
    note('', '', '');
    clock.textContent = '0:00';
    ticker = setInterval(() => { clock.textContent = formatTake(Date.now() - startedAt); }, 250);
    if (analyser) watchLevel();
    capTimer = setTimeout(() => {
      if (state !== 'recording') return;
      stop();
      note('warn', 'Recording limit reached', `The microphone closed after ${formatTake(maxTakeMs)}. Your confirmed words are kept.`);
    }, maxTakeMs);
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
    // Stop uses the same audio gate as an automatic phrase boundary.
    if (last) cutPhrase({ final: true });
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
  const beforeUnload = (event) => {
    if (state === 'recording' || state === 'opening' || state === 'working' || failedPhrases.size) {
      event.preventDefault(); event.returnValue = '';
    }
  };

  talkButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (state === 'recording' || state === 'opening' || wantRecording) stop();
    else start();
  });

  // A tab that goes away mid-take should not leave the microphone live behind it.
  window.addEventListener('blur', release);

  if (!voiceSupported()) {
    talkButton.disabled = true;
    note('warn', 'No microphone here', 'This browser cannot record audio, so voice is off. The coach still reads what you type.');
  }

  return {
    root,
    status,
    preview,
    start,
    isRecording: () => state === 'recording' || state === 'opening',
    isBusy: () => state !== 'idle',
    hasTranscriptionError: () => takeError,
    currentMode: () => mode,
    stop,
    flush,
    retry,
    discardFailed,
    dispose({ finish = false } = {}) {
      if (finish && state !== 'idle') {
        finishing = true;
        stop();
        // stop() releases tracks immediately; settle clears this once outstanding
        // transcription promises have emitted in order.
        if (state === 'idle') { finishing = false; disposed = true; }
      } else {
        disposed = true;
      }
      clearPreview();
      wantRecording = false;
      if (!finish) { try { recorder?.stop(); } catch { /* noop */ } }
      recorder = null;
      releaseMicrophone();
      settleFlushes();
      window.removeEventListener('blur', release);
      // Keep the navigation guard until a finishing disposal has drained all
      // outstanding transcription promises. `settle()` removes it at idle.
      if (!finish || state === 'idle') window.removeEventListener('beforeunload', beforeUnload);
    },
  };
}
