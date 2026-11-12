import { paintReceipt, receiptOutput, receiptFailed } from './ui/receipt.js';
// Shared visible actions for practice and mocks. Every edit stays in the native undo
// history and is acknowledged only after the workspace's normal save path completes.
import { el, replace } from './dom.js';
import { registerActionHandlers, applyAction, actionStatus, receiptSummary, canUndo, undoAction, createMonacoTutor, createTextareaTutor } from './coach-actions.js';

export function showWorkspaceAction(host, action, { replay = false } = {}) {
  if (!action?.id) return;
  let row = [...host.querySelectorAll('[data-action-id]')].find(n => n.dataset.actionId === action.id);
  if (!row) { row = el('div', { 'data-action-id': action.id }); host.append(row); }
  const status = replay && action.status === 'pending' ? 'failed' : actionStatus(action);

  const undo = !replay && canUndo(action) ? el('button', { class: 'btn btn--quiet', text: 'Undo', onclick: async event => {
    const button = event.currentTarget; button.disabled = true;
    let result;
    try { result = await undoAction(action); } catch (error) { result = { ok: false, message: error.message || 'Undo could not be saved.' }; }
    row.append(el('p', { class: 'dim', text: result.message }));
    if (!result.ok) button.disabled = false;
  } }) : null;
  paintReceipt(row, { tool: action.tool, status, output: receiptOutput(action), failed: receiptFailed(action), content: [
    el('span', { class: 'cr-text', text: receiptSummary(action) }),
    status === 'pending' ? el('span', { class: 'cr-state', text: 'Applying…' }) : null,
    status === 'failed' ? el('span', { class: 'cr-state', text: action.message || 'Not confirmed' }) : null, undo,
  ] });
  if (!replay) void applyAction(action);
}

export function bindPythonTools({ target, editor, save, changed = () => {}, readOnly = () => false }) {
  let tutor, gone = false;
  editor.ready.then(() => {
    if (gone) return;
    tutor = editor.kind === 'monaco' ? createMonacoTutor(editor.raw.instance, editor.raw.monaco)
      : createTextareaTutor(editor.raw.area, { onEdit: changed });
  });
  const guard = () => gone || readOnly() ? { ok: false, message: 'This document is read-only. Open a practice copy to edit it.' }
    : !tutor ? { ok: false, message: 'The editor is still opening. Try again.' } : null;
  const unregister = registerActionHandlers(target, {
    markLines: args => guard() || tutor.markLines(args), clearMarks: () => guard() || tutor.clearMarks(),
    async editCode(args, action) {
      const denied = guard(); if (denied) return denied;
      const result = tutor.editCode(args, { actionId: action.id });
      if (result.ok) {
        try { await save(); }
        catch (error) { return { ok: false, message: `The editor changed, but saving failed: ${error.message}. The draft is visible; use editor Undo to revert.` }; }
      }
      return result;
    },
    async undoEdit(id) { const denied = guard(); if (denied) return denied; const result = tutor.undoEdit(id); if (result.ok) await save(); return result; },
  });
  return () => { gone = true; unregister(); tutor?.dispose(); };
}

async function revision(elements) {
  const bytes = new TextEncoder().encode(JSON.stringify(elements));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function bindBoardTools({ target, getApi, getElements, setElements, save, readOnly = () => false }) {
  const edits = new Map(); let gone = false;
  const guard = () => gone || readOnly() || !getApi() ? { ok: false, message: 'The editable board is not open.' } : null;
  const apply = async elements => {
    setElements(elements);
    // Excalidraw's immediate capture joins its native Undo history.
    getApi().updateScene({ elements, captureUpdate: 'IMMEDIATELY' });
    const applied = JSON.stringify(getApi().getSceneElements());
    await save();
    return applied;
  };
  const unregister = registerActionHandlers(target, {
    async editBoard(args, action) {
      const denied = guard(); if (denied) return denied;
      if (!Array.isArray(args.elements) || args.elements.length > 2000 || JSON.stringify(args.elements).length > 1500000 || new Set(args.elements.map(e => e?.id)).size !== args.elements.length || args.elements.some(e => !e || typeof e.id !== 'string' || !['rectangle','diamond','ellipse','arrow','line','freedraw','text','image','frame','embeddable','magicframe'].includes(e.type) || !['x','y','width','height'].every(key => Number.isFinite(e[key])))) return { ok: false, message: 'The proposed board has invalid elements. Read get_state and preserve the complete element structure.' };
      const before = structuredClone(getElements());
      if (await revision(before) !== args.expected || JSON.stringify(getElements()) !== JSON.stringify(before)) return { ok: false, message: 'The board changed. Call get_state and try the edit against the latest board.' };
      // The digest awaited above; recheck route ownership before any mutation.
      if (guard()) return guard();
      const after = await apply(args.elements);
      edits.set(action.id, { before, after });
      return { ok: true, message: 'Updated and saved the board. Undo is available.' };
    },
    async undoEdit(id) {
      const denied = guard(); if (denied) return denied;
      const edit = edits.get(id);
      if (!edit || JSON.stringify(getElements()) !== edit.after) return { ok: false, message: 'The board changed since this edit. Use the board’s Undo history.' };
      await apply(edit.before); edits.delete(id); return { ok: true, message: 'Undone' };
    },
  });
  return () => { gone = true; unregister(); edits.clear(); };
}
