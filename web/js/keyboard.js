// Every app shortcut is registered here, and this file alone decides whether one applies.
//
// The rule (docs/UI.md "Keyboard shortcuts"):
//
//   1. A modal dialog or an open menu holds the keyboard. Nothing behind it acts.
//   2. Command chords (⌘/Ctrl, ⌥) work wherever focus is: in the code, in Monaco's Find,
//      in a test-case field, in the composer, on a button, nowhere at all. They are
//      claimed in the capture phase on window, before Monaco or any panel sees them.
//      The only exceptions are fields that own that exact chord (a composer's ⌘↵ sends,
//      Monaco's replace box's ⌘↵ replaces all); each one is named in `owns` below.
//   3. Plain keys (letters, /, Escape, arrows) are offered last, in the bubble phase, and
//      only when nothing else used them: a text field types them, a focused control keeps
//      the keys it uses itself.
//
// Every input to that decision is read from the live DOM at the moment of the key press:
// no "an overlay is open" flag that can be left set, no listener that dies with an editor.
// That is the whole fix for "after I open X the shortcuts stop working": the old test for
// an open dialog counted Monaco's find widget, which is a `role="dialog"` that stays in
// the page after it closes, so one ⌘F disabled every shortcut until a reload.

// Editor widgets (find, suggest, hover, the context menu) are part of the editor. They
// never stand between the learner and the app's shortcuts, open or closed.
const EDITOR_WIDGETS = '.monaco-editor, .monaco-aria-container, .context-view';
const OVERLAYS = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [popover]';

function shown(node) {
  if (node.hidden) return false;
  if (node.matches('[popover]') && !node.matches(':popover-open')) return false;
  if (!node.getClientRects().length) return false;
  return node.checkVisibility ? node.checkVisibility({ visibilityProperty: true }) : true;
}

// Background workspaces stay mounted under dialogs and floating menus. Focus can
// remain behind a non-native dialog, or fall back to body after a control is removed.
// `except` lets an overlay's own handler ask whether anything *else* is open.
export function hasOpenOverlay(except = null) {
  return [...document.querySelectorAll(OVERLAYS)]
    .some(node => node !== except && !node.closest(EDITOR_WIDGETS) && shown(node));
}

export function isTextEntry(node) {
  return Boolean(node?.isContentEditable || node?.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
}

// Call only after matching a shortcut and its owning surface. Consume autorepeat
// too: merely ignoring it can activate a focused button through Enter's default.
export function claimActionKey(event) {
  if (event.defaultPrevented || event.isComposing) return false;
  event.preventDefault();
  event.stopPropagation();
  return !event.repeat;
}

/* --------------------------------------------------------------- ownership */

// Where a key press is typing rather than a command: any text field, or anywhere in the
// editor (its code, its find box, its widgets).
function typing(target) {
  return isTextEntry(target) || Boolean(target?.closest?.(EDITOR_WIDGETS));
}

// ⌘↵ is the one command chord that text fields use themselves. It is Submit only from
// the code and the fields that belong to it; everywhere else the field keeps it.
function ownsEnter(target, event) {
  if (!target?.closest) return false;
  if (target.closest('[data-command-keys="app"]')) return false;     // test-case fields
  const editor = target.closest(EDITOR_WIDGETS);
  if (editor) {
    const find = target.closest('.find-widget');
    if (find) {
      if (event.ctrlKey && !event.metaKey) return true;              // Monaco: newline in the search
      return Boolean(target.closest('.replace-part'));               // Monaco: Replace All
    }
    if (target.matches('textarea.inputarea')) return false;          // the code
    return isTextEntry(target);                                      // pickers: palette, rename
  }
  if (target.closest('.python-editor-frame')) return false;          // the plain-textarea editor
  return isTextEntry(target);                                        // composers, search, notes
}

// What a field owns, by policy name. A shortcut names its policy; nothing else decides.
const OWNS = {
  never: () => false,
  typing: target => typing(target),
  enter: (target, event) => ownsEnter(target, event),
};

// A focused control keeps the plain keys it uses itself: Enter/Space activate it,
// arrows move within it. Letters, / and Escape still belong to the app.
function controlUses(target, key) {
  if (!target?.closest) return false;
  if ((key === 'Enter' || key === ' ')
    && target.closest('button, a[href], summary, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="switch"], [role="checkbox"]')) return true;
  if (/^(Arrow|Home$|End$|Page)/.test(key)
    && target.closest('[role="separator"], [role="tab"], [role="tablist"], [role="menuitem"], [role="menuitemradio"], [role="option"], [role="listbox"], [role="slider"], [role="radio"], [role="log"]')) return true;
  return false;
}

/* ---------------------------------------------------------------- registry */

const registry = [];

/**
 * Own a shortcut for as long as the surface using it is mounted.
 *
 *   id       stable name, the row in scripts/check-shortcut-matrix.mjs
 *   label    what a button or the Settings page prints (⌘', J / K, Esc)
 *   keys     [{ key } | { code }] matched exactly; `mod`: 'cmd' (⌘ or Ctrl), 'meta' (⌘ only),
 *            'alt', or none; `shift: true` also accepts the shifted chord
 *   owns     'never' | 'typing' | 'enter': which focused fields keep this key for themselves
 *   when     () => boolean: the screen/state this shortcut belongs to, read live
 *   repeat   true to act on autorepeat (list movement); otherwise a held key acts once
 *   run      (event, key) => void
 * @returns {() => void} hand it back
 */
export function registerShortcut(spec) {
  const entry = { owns: 'never', when: () => true, repeat: false, ...spec };
  entry.plain = entry.keys.every(k => !k.mod);
  registry.push(entry);
  return () => { const at = registry.indexOf(entry); if (at >= 0) registry.splice(at, 1); };
}

/** What is registered right now: the checks read this to find shortcuts with no row. */
export function listShortcuts() {
  return registry.map(({ id, label, plain, owns }) => ({ id, label, plain, owns }));
}

function matches(k, event) {
  if (k.code ? event.code !== k.code : event.key !== k.key) return false;
  const cmd = event.metaKey || event.ctrlKey;
  if (k.mod === 'cmd') return cmd && !event.altKey && (k.shift || !event.shiftKey);
  if (k.mod === 'meta') return event.metaKey && !event.ctrlKey && !event.altKey && (k.shift || !event.shiftKey);
  if (k.mod === 'alt') return event.altKey && !cmd && (k.shift || !event.shiftKey);
  return !cmd && !event.altKey;
}

/** The one gate. Everything it reads is live: the DOM, focus, the route. */
function applies(entry, event) {
  if (event.isComposing || event.defaultPrevented) return false;
  if (hasOpenOverlay()) return false;
  const target = event.target;
  if (OWNS[entry.owns](target, event)) return false;
  if (entry.plain && (typing(target) || controlUses(target, event.key))) return false;
  return entry.when() !== false;
}

function dispatch(event, plain) {
  // Newest first: a screen mounted later owns the key over one left behind it.
  for (let i = registry.length - 1; i >= 0; i--) {
    const entry = registry[i];
    if (entry.plain !== plain) continue;
    const key = entry.keys.find(k => matches(k, event));
    if (!key || !applies(entry, event)) continue;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat || entry.repeat) entry.run(event, key);
    return;
  }
}

// Command chords first, before Monaco and every panel; plain keys last, after them.
// (Guarded only for the unit tests, which import modules against a partial DOM stub.)
globalThis.window?.addEventListener?.('keydown', event => dispatch(event, false), { capture: true });
globalThis.document?.addEventListener?.('keydown', event => dispatch(event, true));
