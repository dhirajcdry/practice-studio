// The keys Studio owns, in one list.
//
// Every pane toggle used to be a bare letter — `p`, `f`, `c`. A bare letter is only a
// shortcut while your hands are nowhere near a keyboard input: put the cursor in the
// editor or the composer, press `p`, and you have typed a `p`. So the toggles that
// matter are chords now, and they work identically whether you are typing Python,
// typing a question, or touching nothing at all.
//
// Chosen to be familiar and to be free:
//
//   ⌘B  the problem statement   — VS Code's sidebar toggle
//   ⌘J  the run panel           — VS Code's panel/terminal toggle
//   ⌘\  the coach               — VS Code's split; unbound in every browser
//
// None of these is claimed by Chrome or Safari on macOS (bookmarks is ⌘⇧B, downloads is
// ⌘⇧J, DevTools is ⌘⌥J). Firefox binds ⌘B to its bookmarks sidebar, which is the one
// known collision and the price of matching the editor everyone already knows.
//
// The action keys — ⌘↵ submit, ⌘' run, ⌘S save — live in editor.js, next to what they do.
//
// Matching is on `event.code`, the physical key, not `event.key`: a chord read through
// `key` breaks under a non-US layout and under any modifier that rewrites the character.

export const CHORDS = [
  { id: 'problem', code: 'KeyB', label: '⌘B', what: 'the problem statement' },
  { id: 'results', code: 'KeyJ', label: '⌘J', what: 'the run panel' },
  { id: 'coach', code: 'Backslash', label: '⌘\\', what: 'the coach' },
];

const handlers = new Map();

/**
 * Own one chord for as long as the screen using it is mounted.
 * @returns {() => void} hand it back
 */
export function onChord(id, fn) {
  handlers.set(id, fn);
  return () => { if (handlers.get(id) === fn) handlers.delete(id); };
}

/** The label to print on a button, or '' when nothing owns that id. */
export function chordLabel(id) {
  return CHORDS.find((c) => c.id === id)?.label ?? '';
}

// Capture, not bubble. The editor and the composer both stop keydown from reaching the
// document — correctly, so that the list shortcuts on the browse screen cannot fire while
// you type. Capture runs before either of them, which is what makes these work everywhere.
document.addEventListener('keydown', (event) => {
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.altKey || event.shiftKey) return;      // ⌘⇧B and ⌘⌥J belong to the browser
  const chord = CHORDS.find((c) => c.code === event.code);
  if (!chord) return;
  const fn = handlers.get(chord.id);
  if (!fn) return;
  event.preventDefault();
  event.stopPropagation();
  fn();
}, { capture: true });
