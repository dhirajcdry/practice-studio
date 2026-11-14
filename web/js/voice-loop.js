// The one rule for when a microphone may be live, shared by every voice surface:
// the page is visible AND its window has focus. Another app in front, another tab,
// a minimised window or a page being unloaded all mean "away". The capture in
// voice.js enforces it for every surface; each surface adds only its own
// "on screen and live" condition (canListen, or its openMic gate) on top.
/** The voice status while a wanted take waits for you to come back. */
export const AWAY_HEAD = 'Mic off while you’re away';

export function presenceOf(doc = globalThis.document) {
  if (!doc) return { present: true, reason: '' };
  if (doc.visibilityState === 'hidden' || doc.hidden) return { present: false, reason: 'hidden' };
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return { present: false, reason: 'blurred' };
  return { present: true, reason: '' };
}

/**
 * Call `onChange(present)` whenever presence flips. `blur` is checked at once (the
 * microphone must go off the moment you leave) and again a tick later, because focus
 * moving into a frame of this same page also fires blur but leaves the page focused.
 */
export function watchPresence(onChange, { win = globalThis.window, doc = globalThis.document } = {}) {
  let unloading = false, timer = null;
  const now = () => !unloading && presenceOf(doc).present;
  let last = now();
  const check = () => { const next = now(); if (next !== last) { last = next; onChange(next); } };
  const later = () => { clearTimeout(timer); timer = setTimeout(check, 0); };
  const blur = () => { check(); later(); };
  const pagehide = () => { unloading = true; check(); };
  const pageshow = () => { unloading = false; check(); };
  const events = [[win, 'blur', blur], [win, 'focus', later], [doc, 'visibilitychange', check], [win, 'pagehide', pagehide], [win, 'pageshow', pageshow]];
  for (const [target, name, fn] of events) target?.addEventListener?.(name, fn);
  return {
    get present() { return last; },
    dispose() { clearTimeout(timer); for (const [target, name, fn] of events) target?.removeEventListener?.(name, fn); },
  };
}

// Continuous conversation intent is separate from a single microphone take.
// A reply, transcription drain, or mode switch must not consume that intent.
// Being away is not a failure either: capture defers the take and asks the loop to
// reconcile when you return (`onReturn` on the capture should call `sync`).
export function createVoiceLoop({ capture, speaker, canListen = () => true, onChange = () => {} }) {
  let enabled = false, disposed = false, opening = false, queued = false, intent = 0;
  const away = () => Boolean(capture.awaitingReturn?.());
  async function reconcile() {
    queued = false;
    if (disposed) return;
    if (!enabled || !canListen()) { capture.stop(); return; }
    if (opening || capture.isBusy() || capture.hasTranscriptionError()) return;
    opening = true; const attempt = intent;
    try {
      await capture.start();
      // Permission/device errors need an explicit retry, never a hot retry loop.
      // A take deferred because you are away is not an error: it resumes on return.
      if (!capture.isBusy() && !away() && attempt === intent) enabled = false;
      if (disposed || !enabled || !canListen()) capture.stop();
    } finally { opening = false; if (!disposed) { onChange(); if(attempt !== intent)sync(); } }
  }
  function sync() {
    if (queued || disposed) return;
    queued = true; queueMicrotask(() => { void reconcile(); });
  }
  return {
    get enabled() { return enabled; },
    /** Wanted on, but held off because the page is hidden or another window has focus. */
    get away() { return enabled && away(); },
    start() { if (disposed) return; enabled = true; intent++; void speaker.prepare?.(); onChange(); sync(); },
    pause() { enabled = false; intent++; capture.stop(); onChange(); },
    sync,
    dispose() { disposed = true; enabled = false; capture.stop(); },
  };
}
