// What the tutor does in Studio, applied on the page.
//
// The coach can call Studio tools (server/coach/tools.mjs). The server performs the case,
// run and note tools itself; the ones that touch what is on screen — marking lines,
// editing the buffer, opening a reference panel — arrive here over the coach run's SSE
// stream as `event: action` with `needsAck: true`, and this module applies them and
// answers POST /api/coach/actions/:id/result.
//
// Three rules shape it.
//
//   1. Exactly once. An action can reach this tab more than once — a dropped stream is
//      re-attached and the server replays what it already sent, a reload adopts the run
//      again — and an edit applied twice is a corrupted buffer. Every id is remembered
//      (for the life of the tab, across reloads) the moment it is first taken.
//   2. Only where the page is. Handlers are registered per problem by the editor while it
//      is mounted. An action for a problem that is not on screen is left alone; the server
//      times out and tells the model Studio is not open there, which is the truth.
//   3. Everything the tutor writes is plain text. A mark's note is set with textContent,
//      never as HTML or markdown.
//
// The pure helpers at the top are what tests.js covers.

import { reportCoachAction, undoCoachAction } from './api.js';

/* ============================== pure helpers ============================== */

/** The studio tools, by their bare names. MCP delivers them as `mcp__studio__<name>`. */
export const STUDIO_TOOLS = Object.freeze([
  'get_state', 'add_case', 'update_case', 'remove_case', 'run_code',
  'mark_lines', 'clear_marks', 'edit_code', 'open_panel', 'save_note',
]);

/** `mcp__studio__add_case` or `add_case` → `add_case`; anything else → null. */
export function studioToolName(name) {
  const bare = String(name ?? '').trim().replace(/^mcp__studio__/, '');
  return STUDIO_TOOLS.includes(bare) ? bare : null;
}

export const MAX_MARKS = 6;
export const MARK_TONES = Object.freeze(['hint', 'bug', 'good']);
const NOTE_LIMIT = 4000;

/** Case tools are undone by the server; code edits by the editor. Nothing else is undoable. */
export function undoKind(tool) {
  if (tool === 'add_case' || tool === 'update_case' || tool === 'remove_case') return 'server';
  if (tool === 'edit_code') return 'editor';
  return null;
}

const RESOLVED = new Set(['done', 'failed', 'undone']);

/**
 * Where an action has got to: 'pending' | 'done' | 'failed' | 'undone'.
 *
 * An explicit `status` wins. Otherwise `ok` decides, and an action with neither is pending
 * when the page still owes it an answer, and done when the server already applied it.
 */
export function actionStatus(action) {
  if (!action || typeof action !== 'object') return 'failed';
  if (RESOLVED.has(action.status) || action.status === 'pending') return action.status;
  if (action.ok === true) return 'done';
  if (action.ok === false) return 'failed';
  return action.needsAck ? 'pending' : 'done';
}

/** True once nothing more needs doing for this action on the page. */
export function isResolved(action) {
  return actionStatus(action) !== 'pending';
}

/**
 * One action, updated. Latest wins — except that a replay which says nothing about the
 * outcome must not turn a finished action back into a pending one.
 */
export function mergeAction(prev, next) {
  if (!prev) return { ...next };
  const merged = { ...prev, ...next };
  const nextSays = RESOLVED.has(next?.status) || typeof next?.ok === 'boolean';
  if (isResolved(prev) && !nextSays) {
    merged.status = prev.status;
    merged.ok = prev.ok;
    merged.message = prev.message;
  }
  return merged;
}

const GLYPHS = {
  add_case: '＋', update_case: '✎', remove_case: '−', run_code: '▶',
  mark_lines: '⚑', clear_marks: '⚑', edit_code: '✎', open_panel: '↗',
  save_note: '✎', get_state: '◎',
};

export function receiptGlyph(tool) {
  return GLYPHS[studioToolName(tool)] || '•';
}

function lineSpan(from, to) {
  const a = Number(from);
  const b = Number(to ?? from);
  if (!Number.isFinite(a)) return 'lines';
  return Number.isFinite(b) && b !== a ? `lines ${a}–${b}` : `line ${a}`;
}

/** The receipt's sentence. The server's summary when it sent one; otherwise said from the args. */
export function receiptSummary(action) {
  const given = String(action?.summary ?? '').trim();
  if (given) return given;
  const args = action?.args && typeof action.args === 'object' ? action.args : {};
  switch (studioToolName(action?.tool)) {
    case 'add_case': return args.why ? `Added a case — ${args.why}` : 'Added a case';
    case 'update_case': return `Changed Case ${args.case ?? '?'}`;
    case 'remove_case': return `Removed Case ${args.case ?? '?'}`;
    case 'run_code': return 'Ran your code';
    case 'mark_lines': return `Marked ${lineSpan(args.from, args.to)}`;
    case 'clear_marks': return 'Cleared its marks';
    case 'edit_code': return args.why ? `Edited your code: ${args.why}` : 'Edited your code';
    case 'open_panel': return `Opened the ${args.panel === 'article' ? 'article' : 'solution'}`;
    case 'save_note': return 'Saved a note';
    case 'get_state': return 'Looked at your cases and runs';
    default: return String(action?.tool || 'Did something');
  }
}

/**
 * Validate a mark against the file as it is now.
 * @returns {{ok:true, from:number, to:number, note:string, tone:string} | {ok:false, message:string}}
 */
export function normalizeMark(args, lineCount) {
  const source = args && typeof args === 'object' ? args : {};
  const from = Number(source.from);
  let to = source.to === undefined || source.to === null ? from : Number(source.to);
  if (!Number.isInteger(from)) return { ok: false, message: '`from` must be a line number.' };
  if (!Number.isInteger(to)) return { ok: false, message: '`to` must be a line number.' };
  let start = from;
  if (to < start) [start, to] = [to, start];
  const total = Math.max(1, Number(lineCount) || 1);
  const bad = start < 1 ? start : (to > total ? to : null);
  if (bad !== null) {
    return { ok: false, message: `Line ${bad} is outside the file, which has ${total} line${total === 1 ? '' : 's'}.` };
  }
  const note = String(source.note ?? '').trim().slice(0, NOTE_LIMIT);
  const tone = MARK_TONES.includes(source.tone) ? source.tone : 'hint';
  return { ok: true, from: start, to, note, tone };
}

/** Add a mark; the oldest go once there are more than `max`. Returns the kept and the dropped. */
export function pushMark(marks, mark, max = MAX_MARKS) {
  const next = [...marks, mark];
  const dropped = next.length > max ? next.slice(0, next.length - max) : [];
  return { marks: next.slice(dropped.length), dropped };
}

/** Do two inclusive line ranges touch? */
export function linesOverlap(a1, a2, b1, b2) {
  return a1 <= b2 && b1 <= a2;
}

/** Every start offset of `needle` in `hay`, overlapping ones included, stopping at `cap`. */
export function occurrences(hay, needle, cap = 50) {
  const out = [];
  if (!needle) return out;
  let at = hay.indexOf(needle);
  while (at !== -1 && out.length < cap) {
    out.push(at);
    at = hay.indexOf(needle, at + 1);
  }
  return out;
}

/** Lines added and removed between two buffers: whatever is left after the common head and tail. */
export function lineDelta(before, after) {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  return { added: b.length - head - tail, removed: a.length - head - tail };
}

/**
 * Work out one edit_code against the buffer as it is now, without applying it.
 *
 * Exactly one occurrence of `find`, or nothing. An empty `find` replaces the whole buffer,
 * but only while the buffer is empty or still the starter — never over his own code.
 *
 * @returns {{ok:true, start:number, end:number, text:string, after:string, added:number, removed:number}
 *         | {ok:false, message:string}}
 */
export function planEdit(buffer, args, { isStub = false } = {}) {
  const text = String(buffer ?? '');
  const find = args?.find;
  const replace = args?.replace;
  if (typeof find !== 'string' || typeof replace !== 'string') {
    return { ok: false, message: 'edit_code needs `find` and `replace` as text.' };
  }
  let start;
  let end;
  if (find === '') {
    if (text.trim() !== '' && !isStub) {
      return {
        ok: false,
        message: 'An empty `find` only works while the editor holds the starter code. Quote the exact text to replace.',
      };
    }
    start = 0;
    end = text.length;
  } else {
    const hits = occurrences(text, find);
    if (hits.length === 0) {
      const loose = find.trim() !== '' && find.trim() !== find && text.includes(find.trim());
      return {
        ok: false,
        message: loose
          ? 'The text to replace is in the editor only with different surrounding whitespace or indentation. Quote it exactly.'
          : 'The text to replace is not in the editor. It may have changed since you last read it; call get_state for the current code.',
      };
    }
    if (hits.length > 1) {
      const times = hits.length >= 50 ? '50 or more' : String(hits.length);
      return {
        ok: false,
        message: `The text to replace appears ${times} times. Include more of the surrounding lines so it matches exactly once.`,
      };
    }
    start = hits[0];
    end = start + find.length;
  }
  const after = text.slice(0, start) + replace + text.slice(end);
  const { added, removed } = lineDelta(text, after);
  return { ok: true, start, end, text: replace, after, added, removed };
}

/** "Applied: 3 lines changed". A pure whitespace-free no-op still says what happened. */
export function editMessage({ added, removed }) {
  const n = Math.max(added, removed);
  if (n === 0) return 'Applied: nothing changed (the replacement was identical).';
  return `Applied: ${n} line${n === 1 ? '' : 's'} changed (+${added} −${removed}).`;
}

/* ============================== the registry ============================== */

/** @type {Map<string, object>} slug → the mounted editor's handlers */
const handlers = new Map();

/** Undo records for code edits this tab applied: actionId → { slug } */
const editUndo = new Map();

const SEEN_KEY = 'studio.coach.actions.v1';
const SEEN_CAP = 400;
// The server waits 15 s for an answer. An action older than this was settled long ago —
// by this tab before a reload, or by nobody — and applying it now would be a surprise.
const STALE_MS = 30_000;

let session;
try { session = sessionStorage; } catch { /* storage blocked */ }

// id → the outcome this tab reported (or null when there was nothing to report). Kept so
// a reload that replays an action it already applied can still show how it went.
const seen = new Map((() => {
  try {
    const raw = JSON.parse(session?.getItem(SEEN_KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((e) => Array.isArray(e) && e.length === 2) : [];
  } catch { return []; }
})());

function remember(id, outcome = null) {
  seen.set(id, outcome);
  try {
    session?.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_CAP)));
  } catch { /* full or blocked: the in-memory map still holds for this page */ }
}

/**
 * The editor registers what it can do for its problem while it is mounted.
 * @returns {() => void} unregister — only removes this registration, never a newer one
 */
export function registerActionHandlers(slug, impl) {
  handlers.set(slug, impl);
  return () => { if (handlers.get(slug) === impl) handlers.delete(slug); };
}

export function hasHandlers(slug) {
  return handlers.has(slug);
}

async function perform(h, action) {
  const args = action.args && typeof action.args === 'object' ? action.args : {};
  switch (studioToolName(action.tool)) {
    case 'mark_lines': return h.markLines(args);
    case 'clear_marks': return h.clearMarks();
    case 'edit_code': {
      const result = await h.editCode(args, action);
      if (result?.ok) editUndo.set(action.id, { slug: action.slug });
      return result;
    }
    case 'open_panel': return h.openPanel(args.panel);
    default: return { ok: false, message: `Studio's page does not know how to apply ${action.tool}.` };
  }
}

/**
 * Take one action from the stream. Safe to call any number of times with the same action.
 *
 * @returns {Promise<{ok:boolean, message:string} | null>} the outcome when this call applied
 *   an action that needed an answer; null when there was nothing for this tab to do
 */
export async function applyAction(action) {
  if (!action || typeof action !== 'object' || !action.id) return null;
  const id = String(action.id);
  // Already taken. Never applied twice; if this tab answered it, say again how it went
  // (without posting again) so a reloaded receipt is not left waiting forever.
  if (seen.has(id)) {
    const before = seen.get(id);
    return before && action.needsAck && !isResolved(action) ? { ...before, replayed: true } : null;
  }

  const at = action.at ? Date.parse(action.at) : NaN;
  if (Number.isFinite(at) && Date.now() - at > STALE_MS) { remember(id); return null; }

  if (action.needsAck) {
    if (isResolved(action)) { remember(id); return null; }
    const h = handlers.get(action.slug);
    // Not open here. Leave it unseen so nothing is claimed; the server times out.
    if (!h) return null;
    remember(id, null);
    let outcome;
    try {
      outcome = await perform(h, action);
    } catch (error) {
      outcome = { ok: false, message: `The page failed while applying it: ${error?.message || error}` };
    }
    const result = { ok: outcome?.ok === true, message: String(outcome?.message || (outcome?.ok ? 'Done.' : 'Not done.')) };
    remember(id, result);
    reportCoachAction(id, result).catch(() => {});
    return result;
  }

  // Applied by the server already; the page only has to show it.
  if (action.refresh) {
    const h = handlers.get(action.slug);
    if (!h) return null;
    remember(id);
    try {
      if (action.refresh === 'cases') h.refreshCases?.(action.select ?? null);
      else if (action.refresh === 'run' && action.run) h.showTutorRun?.(action.run);
    } catch { /* showing it is a courtesy; the receipt still says what happened */ }
  }
  return null;
}

/** Can this tab still take this action back? */
export function canUndo(action) {
  if (actionStatus(action) !== 'done') return false;
  const kind = undoKind(studioToolName(action.tool));
  if (kind === 'server') return true;
  if (kind === 'editor') return editUndo.has(String(action.id));
  return false;
}

/**
 * Undo one action from its receipt.
 * @returns {Promise<{ok:boolean, message:string}>}
 */
export async function undoAction(action) {
  const id = String(action?.id || '');
  const kind = undoKind(studioToolName(action?.tool));
  if (kind === 'server') {
    const result = await undoCoachAction(id);
    if (!result.ok) return { ok: false, message: result.message || 'That could not be undone.' };
    handlers.get(action.slug)?.refreshCases?.(null);
    return { ok: true, message: 'Undone' };
  }
  if (kind === 'editor') {
    const record = editUndo.get(id);
    const h = record && handlers.get(record.slug);
    if (!h) return { ok: false, message: 'That edit was made on a page that is no longer open. Use ⌘Z in the editor.' };
    const result = h.undoEdit(id);
    if (result.ok) editUndo.delete(id);
    return result;
  }
  return { ok: false, message: 'This one cannot be undone.' };
}

/* ======================= the editor side: Monaco ======================= */

function reduceMotion() {
  if (document.body.classList.contains('motion-off')) return true;
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Tutor marks and edits for a Monaco editor.
 *
 * @param {object} instance the Monaco editor
 * @param {object} monaco the namespace
 * @param {{onMarksChange?: (count:number) => void}} opts
 */
export function createMonacoTutor(instance, monaco, { onMarksChange = () => {} } = {}) {
  let marks = [];                    // { decorations:string[], zoneId, from, to, note, tone }
  const edits = new Map();           // actionId → { decoration, original, inserted }
  let flashIds = [];
  let flashTimer = null;
  let changing = false;              // our own removals do not count as his edits

  const model = () => instance.getModel();

  function dropMark(mark) {
    instance.deltaDecorations(mark.decorations, []);
    if (mark.zoneId !== null) instance.changeViewZones((zones) => zones.removeZone(mark.zoneId));
  }

  function noteZone(mark) {
    if (!mark.note) return null;
    const node = document.createElement('div');
    node.className = `tutor-note tone-${mark.tone}`;
    const inner = document.createElement('div');
    inner.className = 'tutor-note-body';
    const who = document.createElement('span');
    who.className = 'tutor-note-who';
    who.textContent = 'Tutor';
    const text = document.createElement('span');
    text.className = 'tutor-note-text';
    text.textContent = mark.note;            // plain text, always
    inner.append(who, text);
    node.append(inner);
    const zone = { afterLineNumber: mark.to, heightInPx: 30, domNode: node, suppressMouseDown: true };
    let id = null;
    instance.changeViewZones((zones) => { id = zones.addZone(zone); });
    // The height depends on how the note wraps at this width; measure it once it is in.
    requestAnimationFrame(() => {
      const h = Math.ceil(inner.getBoundingClientRect().height) + 8;
      if (h > 8 && Math.abs(h - zone.heightInPx) > 1) {
        zone.heightInPx = h;
        instance.changeViewZones((zones) => zones.layoutZone(id));
      }
    });
    return id;
  }

  function markLines(args) {
    const m = model();
    if (!m) return { ok: false, message: 'The editor is not ready yet.' };
    const mark = normalizeMark(args, m.getLineCount());
    if (!mark.ok) return mark;
    const decorations = instance.deltaDecorations([], [{
      range: new monaco.Range(mark.from, 1, mark.to, m.getLineMaxColumn(mark.to)),
      options: {
        isWholeLine: true,
        className: `tutor-line tone-${mark.tone}`,
        linesDecorationsClassName: `tutor-bar tone-${mark.tone}`,
        stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    }]);
    const entry = { ...mark, decorations, zoneId: null };
    entry.zoneId = noteZone(entry);
    const { marks: kept, dropped } = pushMark(marks, entry);
    for (const old of dropped) dropMark(old);
    marks = kept;
    instance.revealLinesInCenterIfOutsideViewport(mark.from, mark.to);
    onMarksChange(marks.length);
    const span = mark.from === mark.to ? `line ${mark.from}` : `lines ${mark.from}–${mark.to}`;
    return {
      ok: true,
      message: `Marked ${span}${dropped.length ? ` (the oldest mark was removed; at most ${MAX_MARKS} show at once)` : ''}.`,
    };
  }

  function clearMarks() {
    const n = marks.length;
    changing = true;
    for (const mark of marks) dropMark(mark);
    changing = false;
    marks = [];
    onMarksChange(0);
    return { ok: true, message: n ? `Cleared ${n} mark${n === 1 ? '' : 's'}.` : 'There were no marks to clear.' };
  }

  // Typing inside a marked range means he is acting on it: the mark has done its job.
  const watcher = instance.onDidChangeModelContent((event) => {
    if (changing || !marks.length) return;
    const m = model();
    if (!m) return;
    const touched = [];
    for (const mark of marks) {
      const range = m.getDecorationRange(mark.decorations[0]);
      if (!range) { touched.push(mark); continue; }
      const hit = event.changes.some((c) => linesOverlap(
        c.range.startLineNumber, c.range.endLineNumber, range.startLineNumber, range.endLineNumber,
      ));
      if (hit) touched.push(mark);
    }
    if (!touched.length) return;
    for (const mark of touched) dropMark(mark);
    marks = marks.filter((mark) => !touched.includes(mark));
    onMarksChange(marks.length);
  });

  function flash(range) {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null; }
    const still = reduceMotion();
    flashIds = instance.deltaDecorations(flashIds, [{
      range,
      options: { className: still ? 'tutor-flash is-still' : 'tutor-flash', isWholeLine: range.isEmpty() },
    }]);
    flashTimer = setTimeout(() => {
      flashIds = instance.deltaDecorations(flashIds, []);
      flashTimer = null;
    }, still ? 1200 : 1600);
  }

  function editCode(args, { isStub = false, actionId = null } = {}) {
    const m = model();
    if (!m) return { ok: false, message: 'The editor is not ready yet.' };
    const plan = planEdit(m.getValue(), args, { isStub });
    if (!plan.ok) return plan;
    const start = m.getPositionAt(plan.start);
    const end = m.getPositionAt(plan.end);
    const original = m.getValueInRange(new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column));
    // One undo stop either side: ⌘Z takes back exactly the tutor's edit, nothing of his.
    instance.pushUndoStop();
    instance.executeEdits('tutor', [{
      range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
      text: plan.text,
      forceMoveMarkers: true,
    }]);
    instance.pushUndoStop();
    const a = m.getPositionAt(plan.start);
    const b = m.getPositionAt(plan.start + plan.text.length);
    const range = new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
    if (actionId) {
      const [decoration] = instance.deltaDecorations([], [{
        range,
        options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
      }]);
      edits.set(actionId, { decoration, original, inserted: plan.text });
    }
    flash(range);
    instance.revealLinesInCenterIfOutsideViewport(a.lineNumber, b.lineNumber);
    return { ok: true, message: editMessage(plan), added: plan.added, removed: plan.removed };
  }

  function undoEdit(actionId) {
    const record = edits.get(actionId);
    const m = model();
    if (!record || !m) return { ok: false, message: 'That edit can no longer be found. Use ⌘Z in the editor.' };
    const range = m.getDecorationRange(record.decoration);
    if (!range || m.getValueInRange(range) !== record.inserted) {
      return { ok: false, message: 'You have changed that code since, so it was left alone. Use ⌘Z in the editor to step back through it.' };
    }
    instance.pushUndoStop();
    instance.executeEdits('tutor-undo', [{ range, text: record.original, forceMoveMarkers: true }]);
    instance.pushUndoStop();
    instance.deltaDecorations([record.decoration], []);
    edits.delete(actionId);
    const a = range.getStartPosition();
    const b = m.getPositionAt(m.getOffsetAt(a) + record.original.length);
    flash(new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column));
    return { ok: true, message: 'Undone' };
  }

  return {
    kind: 'monaco',
    markLines,
    clearMarks,
    markCount: () => marks.length,
    editCode,
    undoEdit,
    dispose() {
      watcher.dispose();
      if (flashTimer) clearTimeout(flashTimer);
      marks = [];
    },
  };
}

/* ======================= the editor side: plain textarea ======================= */

/**
 * The fallback editor cannot draw marks; it can still take an edit.
 * `onEdit` is the editor's normal change path (the textarea fires no input event for a
 * programmatic change, so it has to be told).
 */
export function createTextareaTutor(area, { onEdit = () => {} } = {}) {
  const edits = new Map();   // actionId → { start, original, inserted }
  return {
    kind: 'textarea',
    markLines: () => ({ ok: false, message: 'The editor is in plain mode (Monaco did not load), so lines cannot be marked. Quote the lines in your reply instead.' }),
    clearMarks: () => ({ ok: true, message: 'There were no marks to clear.' }),
    markCount: () => 0,
    editCode(args, { isStub = false, actionId = null } = {}) {
      const plan = planEdit(area.value, args, { isStub });
      if (!plan.ok) return plan;
      const original = area.value.slice(plan.start, plan.end);
      area.value = plan.after;
      if (actionId) edits.set(actionId, { start: plan.start, original, inserted: plan.text });
      onEdit();
      return { ok: true, message: editMessage(plan), added: plan.added, removed: plan.removed };
    },
    undoEdit(actionId) {
      const record = edits.get(actionId);
      if (!record) return { ok: false, message: 'That edit can no longer be found.' };
      const here = area.value.slice(record.start, record.start + record.inserted.length);
      if (here !== record.inserted) {
        return { ok: false, message: 'You have changed that code since, so it was left alone.' };
      }
      area.value = area.value.slice(0, record.start) + record.original + area.value.slice(record.start + record.inserted.length);
      edits.delete(actionId);
      onEdit();
      return { ok: true, message: 'Undone' };
    },
    dispose() {},
  };
}
