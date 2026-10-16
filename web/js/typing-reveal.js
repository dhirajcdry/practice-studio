// Typed characters reveal themselves instead of popping in: each new character fades up
// from nothing, comes into focus from a slight blur and settles into place, over about a
// quarter of a second, with a faint glow in the theme's accent that dies as it lands.
//
// The hard part is that Monaco re-renders the whole line on every keystroke, recreating
// the spans, so a plain CSS animation on a decoration would restart from zero for every
// character still mid-reveal: fast typing would stutter. So each character's decoration
// carries its AGE, bucketed into 20 ms steps (`tr-0` … `tr-13`), and each bucket starts
// the same animation with a negative delay. Whenever the line re-renders, the decorations
// are re-issued with up-to-date buckets in the same pass, and every character resumes
// where it was rather than starting again. Decorations track their text, so edits
// elsewhere on the line carry them along.

export const REVEAL_MS = 260;
export const STEP_MS = 20;
export const BUCKETS = Math.ceil(REVEAL_MS / STEP_MS);   // 13 → classes tr-0 … tr-12

/** Which delay bucket a character `age` ms old belongs in, or -1 once it has landed. */
export function bucketFor(age) {
  if (!(age >= 0) || age >= REVEAL_MS) return -1;
  return Math.min(BUCKETS - 1, Math.floor(age / STEP_MS));
}

/** Plain typing only: a few characters, no newline. Pastes and restores appear at once. */
export function revealable(event) {
  if (!event || event.isFlush || event.isUndoing || event.isRedoing) return null;
  const changes = event.changes || [];
  if (changes.length !== 1) return null;            // multi-cursor edits stay instant
  const change = changes[0];
  const text = change.text || '';
  if (!text || text.length > 4 || /[\r\n]/.test(text) || !/\S/.test(text)) return null;
  return change;
}

// Settings arrive from the caller so the pure helpers above load anywhere, tests included.
export function attachTypingReveal(instance, monaco, { getSettings, onSettingsChange }) {
  const model = () => instance.getModel?.();
  if (!model() || typeof instance.deltaDecorations !== 'function') return () => {};

  const reduceQuery = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)'); } catch { return null; } })();
  const enabled = () => {
    const s = getSettings();
    return s.motion !== false && s.typingFx !== false && !reduceQuery?.matches;
  };

  let live = [];      // { id, born } in the order they were typed; ids are Monaco decoration ids
  let sweep = 0;
  const Stickiness = monaco?.editor?.TrackedRangeStickiness?.NeverGrowsWhenTypingAtEdges ?? 1;

  // Re-issue every live decoration with its current age bucket. Called right after the
  // keystroke that re-rendered the line, and once more when the last one lands.
  function render() {
    const m = model();
    if (!m) return;
    const now = performance.now();
    const keep = [];
    const decorations = [];
    for (const item of live) {
      const bucket = bucketFor(now - item.born);
      const range = bucket < 0 ? null : m.getDecorationRange(item.id);
      if (!range || range.isEmpty()) continue;
      keep.push(item);
      decorations.push({ range, options: { inlineClassName: `tr-reveal tr-${bucket}`, stickiness: Stickiness } });
    }
    // Replace every id we hold, landed and placeholder ones included, so nothing leaks.
    const ids = instance.deltaDecorations(live.map((item) => item.id), decorations);
    live = keep.map((item, i) => ({ id: ids[i], born: item.born }));
    clearTimeout(sweep);
    if (live.length) {
      // Clear when the youngest has landed; the re-render that causes is invisible because
      // the text is already fully shown.
      const youngest = live[live.length - 1].born;
      sweep = setTimeout(render, Math.max(16, REVEAL_MS - (performance.now() - youngest) + 10));
    }
  }

  function reset() {
    clearTimeout(sweep);
    instance.deltaDecorations(live.map((item) => item.id), []);
    live = [];
  }

  const subs = [];
  subs.push(instance.onDidChangeModelContent((event) => {
    if (!enabled()) { if (live.length) reset(); return; }
    if (!instance.hasTextFocus()) return;             // a restore or the coach, not his hands
    const change = revealable(event);
    if (!change) { if (live.length) render(); return; }
    const m = model();
    const start = m.getPositionAt(change.rangeOffset);
    const end = m.getPositionAt(change.rangeOffset + change.text.length);
    const range = new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column);
    // A placeholder decoration so the new characters have a tracked id; render() replaces
    // it in the same task, before the browser paints.
    const [id] = instance.deltaDecorations([], [{ range, options: { stickiness: Stickiness } }]);
    live.push({ id, born: performance.now() });
    render();
  }));

  subs.push({ dispose: onSettingsChange(() => { if (!enabled()) reset(); }) });
  const onReduce = () => { if (!enabled()) reset(); };
  reduceQuery?.addEventListener?.('change', onReduce);

  return () => {
    clearTimeout(sweep);
    for (const sub of subs) { try { sub?.dispose?.(); } catch { /* already gone */ } }
    reduceQuery?.removeEventListener?.('change', onReduce);
    try { instance.deltaDecorations(live.map((item) => item.id), []); } catch { /* editor already disposed */ }
  };
}
