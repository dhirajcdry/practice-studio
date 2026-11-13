import { studioToolName, actionStatus, receiptSummary, canUndo } from '../coach-actions.js';
import { displayFor } from '../tool-display.js';
/** Adapt action evidence to cards; reads and private notes stay in activity. */
export function changeCards(actions, { ui = new Map(), onUndo = null, settled = false, liveMock = false } = {}) {
  return actions.flatMap(action => {
    const tool = studioToolName(action.tool) || action.tool;
    const display = action.display || displayFor(tool);
    if (!display || !['change', 'handoff'].includes(display.effect)) return [];
    const local = ui.get(String(action.id)) || {};
    let state = local.undone ? 'undone' : actionStatus(action);
    if (settled && state === 'pending') state = 'failed';
    const undoable = onUndo && !local.undone && canUndo(action);
    const controls = [];
    if (action.url && (/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\//.test(action.url)
      || tool === 'start_notes_session' && /^https:\/\/[a-z0-9.-]+\.ts\.net(?::\d+)?\//i.test(action.url))) {
      controls.push({ label: 'View', href: action.url });
    }
    if (tool === 'update_coaching_instructions') controls.push({ label: 'View rules', onClick: async () => (await import('../coaching-instructions.js')).openCoachingInstructions() });
    if (undoable) controls.push({ label: local.busy ? 'Undoing…' : 'Undo', disabled: !!local.busy, onClick: () => onUndo(action) });
    const summary = receiptSummary(action);
    return [{ id: action.id, tool, title: display.done, detail: summary === action.tool ? '' : summary,
      tag: liveMock && display.effect === 'change' ? 'Counts as help' : tool === 'update_coaching_instructions' ? 'From next turn' : undoable ? 'Undoable' : '',
      state, error: local.error || (state === 'failed' ? action.message || 'Studio did not apply this change.' : ''), actions: controls }];
  });
}

