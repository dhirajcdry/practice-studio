// Continuous conversation intent is separate from a single microphone take.
// A reply, transcription drain, or mode switch must not consume that intent.
export function createVoiceLoop({ capture, speaker, canListen = () => true, onChange = () => {} }) {
  let enabled = false, disposed = false, opening = false, queued = false, intent = 0;
  async function reconcile() {
    queued = false;
    if (disposed) return;
    if (!enabled || !canListen() || speaker.speaking) { capture.stop(); return; }
    if (opening || capture.isBusy() || capture.hasTranscriptionError()) return;
    opening = true; const attempt = intent;
    try {
      await capture.start();
      // Permission/device errors need an explicit retry, never a hot retry loop.
      if (!capture.isBusy() && attempt === intent) enabled = false;
      if (disposed || !enabled || !canListen() || speaker.speaking) capture.stop();
    } finally { opening = false; if (!disposed) { onChange(); if(attempt !== intent)sync(); } }
  }
  function sync() {
    if (queued || disposed) return;
    queued = true; queueMicrotask(() => { void reconcile(); });
  }
  return {
    get enabled() { return enabled; },
    start() { if (disposed) return; enabled = true; intent++; void speaker.prepare?.(); onChange(); sync(); },
    pause() { enabled = false; intent++; capture.stop(); onChange(); },
    sync,
    dispose() { disposed = true; enabled = false; capture.stop(); },
  };
}
