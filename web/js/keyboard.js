// Background workspaces stay mounted under dialogs and floating menus. Focus can
// remain behind a non-native dialog, or fall back to body after a control is removed.
export function hasOpenOverlay() {
  return [...document.querySelectorAll('dialog[open], [role="dialog"]:not([hidden]), [role="menu"]:not([hidden])')]
    .some(node => node.getClientRects().length > 0);
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
