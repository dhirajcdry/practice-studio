// One input-mode preference, independent of streamed replies and their older snapshots.
// A failed save is retried only by an explicit action; queued changes never submit text.
export function createInterviewMode({ initial = 'typed', ready, save, onSelect = () => {}, onStatus = () => {} }) {
  let current = initial === 'voice' ? 'voice' : 'typed', wanted = null, writing = null, failure = null, disposed = false, chosenHere = false;
  const status = () => { if (!disposed) onStatus({ value: current, pending: wanted !== null, saving: Boolean(writing), error: failure }); };
  const api = {
    get value() { return current; }, get saving() { return Boolean(writing); }, get pending() { return wanted !== null; },
    select(next) {
      if (disposed || !['typed', 'voice'].includes(next) || next === current) return;
      current = wanted = next; chosenHere = true; failure = null; onSelect(next); status(); void api.flush();
    },
    sync(next) {
      if (!chosenHere && wanted === null && !writing && ['typed', 'voice'].includes(next)) current = next;
      return current;
    },
    async flush() {
      if (disposed || failure) return;
      if (writing) { await writing.catch(() => {}); return api.flush(); }
      if (wanted === null || !ready()) return;
      const next = wanted;
      // Mark synchronously before save can yield to a second selection or a turn.
      writing = Promise.resolve().then(() => save(next)); status();
      try { await writing; if (wanted === next) wanted = null; }
      catch (error) { failure = error?.message || 'Could not save answer mode.'; }
      finally { writing = null; status(); }
      if (!failure && wanted !== null && !disposed) return api.flush();
    },
    retry() { failure = null; status(); void api.flush(); },
    dispose() { disposed = true; },
  };
  return api;
}
