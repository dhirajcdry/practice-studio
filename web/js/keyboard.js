// Background workspaces stay mounted under dialogs and floating menus. Focus can
// remain behind a non-native dialog, or fall back to body after a control is removed.
// `except` lets an overlay's own handler ask whether anything *else* is open.
export function hasOpenOverlay(except = null) {
  return [...document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden]), [role="menu"]:not([hidden])')]
    .some(node => node !== except && node.getClientRects().length > 0);
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
