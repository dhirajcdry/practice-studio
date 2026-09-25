// The attempt recorder.
//
// Start attempt / End attempt. Between those two presses is one simulated interview: the
// speech, the runs, the submissions and the verdicts all belong to it, and stopping asks
// the coach to grade the whole window. You never type "how did I do" — stopping said it.
//
// This is NOT the microphone in the coach composer. That one is dictation — talking
// instead of typing, and you read it before it sends. This one runs in the background
// while you work: you start it, you forget it, and every word ends up in
// problems/<slug>/transcripts/ where the coach can read it. The two must not be
// confused, which is why this one is a clock in the top bar with no text box near it.
//
// It segments as it goes. A twenty-minute take that fails at minute nineteen loses
// twenty minutes; two-minute segments lose two, and they give the coach natural
// timestamps to line speech up against what was happening in the editor.

import { el } from './dom.js';
import { transcribeAudio, logSessionEvent } from './api.js';

const SEGMENT_MS = 120_000;    // a lost segment costs two minutes, not a session
// The first one is short so you find out the microphone is working in seconds rather
// than in two minutes. After that, length is about crash safety, not feedback.
const FIRST_SEGMENT_MS = 15_000;
const MIN_SEGMENT_MS = 1_200;  // shorter than this is a slip, not speech

function pickMimeType() {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(type)) return type;
  }
  return '';
}

export function formatClock(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * @param {() => string|null} getSlug the problem being worked on, read at segment time so
 *        speech follows you when you switch problems mid-recording
 */
export function createRecorder({ getSlug, onAttemptStart = () => {}, onAttemptEnd = () => {} }) {
  let stream = null;
  let recorder = null;
  // One mode. There used to be a second ("debrief" — explain a finished solution back),
  // which forced a choice before you started and was never once used in practice.
  const mode = 'think_aloud';
  let attemptId = null;
  let attemptSlug = null;
  let startedAt = 0;
  let segmentStartedAt = 0;
  let ticker = null;
  let segmentTimer = null;
  let stopping = false;
  let savedMs = 0;
  let disposed = false;
  let rollResolve = null;
  const pending = new Set();

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function track(promise) {
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
    return promise;
  }

  const clock = el('span', { class: 'rec-clock tnum', text: '0:00' });
  const label = el('span', { class: 'rec-label mono' });
  const dot = el('span', { class: 'rec-dot' });

  /**
   * The button names the thing it does, and the thing it does is bracket an attempt.
   * "Think aloud" described the user's behaviour, which left the actual consequence —
   * a graded window opening and closing — completely unlabelled.
   */
  function refreshLabels() {
    const live = recorder !== null;
    label.textContent = live ? 'End attempt' : 'Start attempt';
    toggle.title = live
      ? 'Stop recording and have the coach review this attempt (⌥R)'
      : 'Start a recorded attempt — the coach reviews it when you stop (⌥R)';
  }

  const toggle = el('button', {
    class: 'rec-toggle', type: 'button',
    onclick: () => (recorder ? stop() : start()),
  }, [dot, label, clock]);


  const note = el('div', { class: 'rec-note', hidden: true });
  const root = el('div', { class: 'rec' }, [
    el('div', { class: 'rec-row' }, [toggle]),
    note,
  ]);
  refreshLabels();

  /** The last few words heard, as one line. Enough to recognise, never a wall. */
  function tail(text, limit = 64) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return 'heard nothing that time';
    return clean.length <= limit ? `“${clean}”` : `“…${clean.slice(-limit)}”`;
  }

  let fadeTimer = null;
  /**
   * The note floats over the page. While recording it is live status and stays; once the
   * attempt is over it has been read within a few seconds and must get out of the way,
   * rather than sitting on top of the coach's answer.
   */
  function say(text, tone = '', { sticky = true } = {}) {
    clearTimeout(fadeTimer);
    note.textContent = text;
    note.dataset.tone = tone;
    note.hidden = !text;
    note.classList.remove('fade');
    if (!sticky && text) {
      fadeTimer = setTimeout(() => {
        note.classList.add('fade');
        fadeTimer = setTimeout(() => { note.hidden = true; note.classList.remove('fade'); }, 600);
      }, 5_000);
    }
  }

  function tick() {
    clock.textContent = formatClock(Date.now() - startedAt);
  }

  /**
   * Transcribe one segment. Deliberately fire-and-forget: recording must never pause
   * waiting for the model, or the gap swallows whatever was said next.
   */
  async function handleSegment(blob, slug, spokeMs) {
    if (!slug || blob.size === 0 || spokeMs < MIN_SEGMENT_MS) return;
    try {
      const result = await transcribeAudio(slug, blob, {
        filename: `take-${Date.now()}.webm`,
        mode,
        attemptId,
      });
      if (result?.ok === false || result?.error) {
        // No speech in a segment is normal — you think in silence too. Say nothing.
        const kind = result.kind || result.error?.code || '';
        if (!/NO_AUDIO|EMPTY_TRANSCRIPT|no_audio|empty/i.test(String(kind))) {
          say('That segment could not be transcribed. Still recording.', 'warn');
        }
        return;
      }
      savedMs += spokeMs;
      // Show what it heard, not what it wants you to do. A running clock proves the
      // timer works; only your own words back prove the microphone does.
      say(`${formatClock(savedMs)} · ${tail(result?.text)}`, 'ok');
      // The filename is what lets the coach match this take to this sitting exactly,
      // instead of inferring it from timestamps that can disagree by milliseconds.
      logSessionEvent(slug, 'recorded_audio', {
        mode,
        attemptId,
        seconds: Math.round(spokeMs / 1000),
        characters: (result?.text || '').length,
        transcript: result?.transcript ?? null,
      }).catch(() => {});
    } catch {
      say('That segment could not be transcribed. Still recording.', 'warn');
    }
  }

  function armSegment(first = false) {
    clearTimeout(segmentTimer);
    segmentTimer = setTimeout(() => {
      // Cycle the recorder rather than slicing: every file is then independently
      // decodable, which a mid-stream MediaRecorder chunk is not.
      if (recorder && recorder.state === 'recording') recorder.stop();
    }, first ? FIRST_SEGMENT_MS : SEGMENT_MS);
  }

  function beginSegment() {
    if (!stream || disposed) return;
    const mimeType = pickMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    segmentStartedAt = Date.now();

    recorder.ondataavailable = (event) => {
      const spokeMs = Date.now() - segmentStartedAt;
      const slug = getSlug();
      if (event.data && event.data.size) track(handleSegment(event.data, slug, spokeMs));
      rollResolve?.();
      rollResolve = null;
    };

    recorder.onstop = () => {
      if (stopping || disposed) return; // stop() and dispose() own the teardown
      beginSegment(); // rolled over on the timer; keep going
    };

    recorder.start();
    armSegment(savedMs === 0 && pending.size === 0);
  }

  async function start() {
    if (recorder || disposed) return;
    say('');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const denied = /NotAllowed|Permission/i.test(err?.name || '');
      say(denied
        ? 'Microphone access was refused. Allow it in your browser settings to record.'
        : 'No microphone is available on this machine.', 'err');
      return;
    }
    stopping = false;
    savedMs = 0;
    startedAt = Date.now();

    // Pressing record is the start of an attempt, not just of a microphone. Everything
    // logged from here until stop — runs, submissions, speech, questions — belongs to it,
    // and the review at the end is scoped to exactly this window.
    attemptId = new Date(startedAt).toISOString();
    attemptSlug = getSlug();
    if (attemptSlug) {
      logSessionEvent(attemptSlug, 'attempt_started', { attemptId, mode }).catch(() => {});
    }
    onAttemptStart({ attemptId, slug: attemptSlug, mode });

    root.classList.add('is-live');
    toggle.setAttribute('aria-pressed', 'true');
    tick();
    ticker = setInterval(tick, 1000);
    beginSegment();
    refreshLabels();
    say('Listening…', 'ok');
  }

  /**
   * Get everything said so far onto disk, without stopping.
   *
   * Asking the coach right after talking used to lose the talking: up to two minutes of
   * speech sat inside a MediaRecorder that had not hit its segment boundary yet, so no
   * file existed and the coach answered as though you had said nothing. Rolling the
   * segment here means the question and the reasoning behind it arrive together.
   *
   * Bounded on purpose. A wedged transcriber must delay a question, never block it.
   */
  async function flush({ timeoutMs = 20_000 } = {}) {
    if (recorder && recorder.state === 'recording') {
      const rolled = new Promise((resolve) => { rollResolve = resolve; });
      clearTimeout(segmentTimer);
      recorder.stop(); // onstop starts the next segment; recording never actually pauses
      await Promise.race([rolled, delay(3_000)]);
    }
    if (!pending.size) return;
    await Promise.race([Promise.allSettled([...pending]), delay(timeoutMs)]);
  }

  /**
   * End the attempt: get the last words on disk, close the window, hand it to the coach.
   *
   * The order matters. The review is only worth reading if the final segment — usually the
   * wrap-up, "yep, all of this works" — made it into the transcript first.
   */
  async function stop() {
    if (!recorder || stopping) return;
    const id = attemptId;
    const slug = attemptSlug ?? getSlug();
    const elapsedMs = Date.now() - startedAt;

    stopping = true;
    clearTimeout(segmentTimer);
    say('Wrapping up — saving the last of what you said…', 'ok');

    try {
      if (recorder?.state === 'recording') {
        const rolled = new Promise((resolve) => { rollResolve = resolve; });
        recorder.stop();
        await Promise.race([rolled, delay(3_000)]);
      }
      if (pending.size) await Promise.race([Promise.allSettled([...pending]), delay(20_000)]);
    } catch { /* a failed segment must not strand the attempt open */ }

    teardown();

    if (slug && id) {
      await logSessionEvent(slug, 'attempt_ended', {
        attemptId: id,
        elapsedSeconds: Math.round(elapsedMs / 1000),
        spokenSeconds: Math.round(savedMs / 1000),
      }).catch(() => {});
    }
    attemptId = null;
    attemptSlug = null;
    // Read after the flush, never before. Capturing it up front reported "nothing spoken"
    // on an attempt that had just been transcribed during the wait — a false statement
    // about what he did, which is the one kind of wrong this app must not be.
    onAttemptEnd({ attemptId: id, slug, spokenMs: savedMs, elapsedMs });
  }

  function teardown() {
    clearInterval(ticker);
    clearTimeout(segmentTimer);
    ticker = null;
    recorder = null;
    // Release the device so the OS recording indicator actually goes out. A microphone
    // that stays warm after you pressed stop is a betrayal, not a bug.
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    root.classList.remove('is-live');
    toggle.setAttribute('aria-pressed', 'false');
    refreshLabels();
    clock.textContent = '0:00';
    // Say which of the two happened, and why the coach did or did not answer. A review
    // that silently does not arrive reads as a broken button.
    say(savedMs
      ? `Attempt ended · ${formatClock(savedMs)} spoken · sent to the coach`
      : 'Attempt ended · nothing was said, so there is nothing to review',
    savedMs ? 'ok' : '', { sticky: false });
  }

  function dispose() {
    disposed = true;
    stopping = true;
    try { if (recorder?.state === 'recording') recorder.stop(); } catch { /* already gone */ }
    // Navigating away mid-attempt still closes it. An attempt left open would swallow
    // every later event on this problem into a window that never ended.
    if (attemptId && attemptSlug) {
      logSessionEvent(attemptSlug, 'attempt_ended', {
        attemptId,
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1000),
        spokenSeconds: Math.round(savedMs / 1000),
        abandoned: true,
      }).catch(() => {});
    }
    attemptId = null;
    attemptSlug = null;
    teardown();
    root.remove();
  }

  return { root, start, stop, flush, dispose, isRecording: () => recorder !== null };
}

let active = null;

/**
 * Flush whatever is being said right now, for callers that are about to ask the coach
 * something. Safe to call when nothing is recording — it resolves immediately.
 */
export async function flushRecorder() {
  if (!active?.isRecording()) return;
  await active.flush();
}

export function installRecorder(getSlug, { onAttemptStart, onAttemptEnd } = {}) {
  if (active) active.dispose();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) return null;

  active = createRecorder({ getSlug, onAttemptStart, onAttemptEnd });
  // Top right, in the bar. It used to float bottom-left, where it sat on top of the
  // problem statement and fought the coach launcher for a corner.
  (document.getElementById('recmount') || document.body).append(active.root);

  // Alt-R, NOT Cmd/Ctrl-Shift-R. That one is hard reload in every browser, and taking
  // it meant the page could not be force-refreshed while a problem was open. A shortcut
  // this app invents must never sit on one the browser already owns.
  const onKey = (event) => {
    if (event.metaKey || event.ctrlKey || !event.altKey) return;
    if (event.code !== 'KeyR') return;              // code, not key: Alt-R types "®" on macOS
    const node = document.activeElement;
    if (node && (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName) || node.isContentEditable)) return;
    event.preventDefault();
    if (active.isRecording()) active.stop(); else active.start();
  };
  document.addEventListener('keydown', onKey);

  const previousDispose = active.dispose;
  active.dispose = () => { document.removeEventListener('keydown', onKey); previousDispose(); };
  return active;
}

export function removeRecorder() {
  if (active) { active.dispose(); active = null; }
}
