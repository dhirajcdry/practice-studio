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
// The action keys — ⌘↵ submit, ⌘' run, ⌘S save — are registered by the shared Python
// editor (python-editor.js) for whichever screen mounted it. keyboard.js decides when any
// of them applies.
//
// Matching is on `event.code`, the physical key, not `event.key`: a chord read through
// `key` breaks under a non-US layout and under any modifier that rewrites the character.

import { registerShortcut } from './keyboard.js';

export const CHORDS = [
  { id: 'problem', code: 'KeyB', label: '⌘B', what: 'the problem statement' },
  { id: 'results', code: 'KeyJ', label: '⌘J', what: 'the run panel' },
  { id: 'coach', code: 'Backslash', label: '⌘\\', what: 'the coach' },
];

/**
 * Own one chord for as long as the screen using it is mounted.
 * @returns {() => void} hand it back
 */
export function onChord(id, fn) {
  const chord = CHORDS.find((c) => c.id === id);
  // These pane chords belong only to the coding workspace. A module-level registration
  // (coach) can outlive its screen; it must not consume board keys. keyboard.js claims
  // them in the capture phase, so they work in the editor, its Find box and the composer.
  // ⌘⇧B and ⌘⌥J belong to the browser: the chord takes neither Shift nor Option.
  return registerShortcut({
    id: `toggle-${id}`, label: chord.label, keys: [{ code: chord.code, mod: 'cmd' }],
    when: () => /^#\/p\//.test(location.hash), run: fn,
  });
}

/** The label to print on a button, or '' when nothing owns that id. */
export function chordLabel(id) {
  return CHORDS.find((c) => c.id === id)?.label ?? '';
}
