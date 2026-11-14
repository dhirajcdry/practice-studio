// Draggable splits on the problem screen.
//
// Three of them: statement | editor, editor | coach, and editor / results. Each one
// remembers where you put it, because a layout you have to re-drag every morning is worse
// than one that never moved.
//
// With the statement and the coach both closed the editor is alone, and it sits as a centred
// column instead of stretching across the window. Its two edges are one control: dragging
// either moves both, so the column stays in the middle.
//
// The panes are grid columns, so the handles are absolutely positioned over the gaps
// rather than being grid children — that keeps the column count fixed whether or not the
// coach is open, and means nothing here has to restructure the DOM it sits in.

const STORE_KEY = 'studio.layout.v1';

// Below these a pane stops being usable rather than merely small: a statement you cannot
// read a line of, an editor narrower than a signature, a coach column of broken words.
const MIN = { statement: 280, editor: 420, coach: 300 };
const MIN_EDITOR_HEIGHT = 150;
// The results can shrink to their tab row. Dragging past that hides them entirely;
// Run, the rail button or the shortcut bring them back at the height they had.
const MIN_RESULTS_HEIGHT = 40;
const COLLAPSE_BELOW = 24;
// Enough to read a couple of cases and their printed output without dragging first.
const DEFAULT_RESULTS_HEIGHT = 260;

// The editor is the reason the screen exists, so it is the widest column by default.
const DEFAULTS = { statement: 0.7, editor: 1.6, coach: 0.85, results: DEFAULT_RESULTS_HEIGHT, solo: 1060 };
// Dragged to within this of the full width, the lone editor simply fills the window (stored as 0).
const SOLO_SNAP = 24;

function loadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      statement: Number(raw.statement) > 0 ? Number(raw.statement) : DEFAULTS.statement,
      editor: Number(raw.editor) > 0 ? Number(raw.editor) : DEFAULTS.editor,
      coach: Number(raw.coach) > 0 ? Number(raw.coach) : DEFAULTS.coach,
      results: Number(raw.results) >= MIN_RESULTS_HEIGHT ? Number(raw.results) : DEFAULTS.results,
      solo: raw.solo === 0 ? 0 : Number(raw.solo) >= MIN.editor ? Number(raw.solo) : DEFAULTS.solo,
    };
  } catch {
    return { ...DEFAULTS }; // private browsing: the app works, it just forgets
  }
}

function saveLayout(layout) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(layout));
  } catch { /* not worth interrupting anyone over */ }
}

let layout = loadLayout();
let teardown = null;

/** Stacked layout — the splits do not exist below this width. */
function isStacked() {
  return window.matchMedia('(max-width: 1080px)').matches;
}

function coachOpen() {
  return document.body.classList.contains('coach-open');
}

function problemHidden() {
  return document.body.classList.contains('hide-problem');
}

function resultsHidden() {
  return document.body.classList.contains('hide-results');
}

/** The editor is the only pane showing. */
function isSolo() {
  return !isStacked() && problemHidden() && !coachOpen();
}

function applyColumns(pbody) {
  pbody.style.removeProperty('justify-content');
  if (isStacked()) {
    pbody.style.removeProperty('grid-template-columns');
    return;
  }
  const { statement, editor, coach } = layout;
  if (problemHidden()) {
    if (coachOpen()) pbody.style.gridTemplateColumns = `minmax(${MIN.editor}px, ${editor}fr) minmax(${MIN.coach}px, ${coach}fr)`;
    else {
      // A track that grows to the chosen width and no further, centred in what is left.
      pbody.style.gridTemplateColumns = layout.solo ? `minmax(0, ${layout.solo}px)` : 'minmax(0,1fr)';
      pbody.style.justifyContent = 'center';
    }
    return;
  }
  pbody.style.gridTemplateColumns = coachOpen()
    ? `minmax(${MIN.statement}px, ${statement}fr) minmax(${MIN.editor}px, ${editor}fr) minmax(${MIN.coach}px, ${coach}fr)`
    : `minmax(${MIN.statement}px, ${statement}fr) minmax(${MIN.editor}px, ${editor}fr)`;
}

function applyResultsHeight(results) {
  if (!results) return;
  // A collapsed panel has no height to remember. Writing one back would make ⌘J look
  // like it did nothing.
  if (layout.results && !isStacked() && !resultsHidden()) {
    results.style.flex = '0 0 auto';
    results.style.height = `${layout.results}px`;
    results.style.maxHeight = 'none';
  } else {
    results.style.removeProperty('flex');
    results.style.removeProperty('height');
    results.style.removeProperty('max-height');
  }
}

/**
 * A drag handle laid over the gap between two panes.
 *
 * Keyboard-operable on purpose: a split you can only reach with a pointer is one the
 * keyboard-first half of this app cannot touch.
 */
function makeHandle(kind, label) {
  const handle = document.createElement('div');
  handle.className = `split split-${kind}`;
  handle.setAttribute('role', 'separator');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-label', `${label} — drag to resize, double-click to reset`);
  handle.setAttribute('aria-orientation', kind === 'row' ? 'horizontal' : 'vertical');
  return handle;
}

export function installResizers() {
  if (teardown) teardown();

  const pbody = document.querySelector('.pbody.with-workspace');
  if (!pbody) { teardown = null; return; }

  const statementEl = pbody.querySelector(':scope > .pcol');
  const wsEl = pbody.querySelector(':scope > .ws');
  const coachEl = pbody.querySelector(':scope > .coach');
  if (!statementEl || !wsEl) { teardown = null; return; }

  const hostEl = wsEl.querySelector('.ws-host');
  const resultsEl = wsEl.querySelector('.ws-results');

  const previous = getComputedStyle(pbody).position;
  if (previous === 'static') pbody.style.position = 'relative';

  const handles = [];
  const cleanups = [];

  // A handle only exists where two panes actually share an edge — `position()` hides the
  // ones whose pane is collapsed, because a divider you can drag that moves nothing is
  // worse than no divider.
  {
    const colHandle = makeHandle('col', 'Statement and editor');
    pbody.append(colHandle);
    handles.push({ el: colHandle, between: [statementEl, wsEl], keys: ['statement', 'editor'] });

    if (coachEl) {
      const coachHandle = makeHandle('col', 'Editor and coach');
      pbody.append(coachHandle);
      handles.push({ el: coachHandle, between: [wsEl, coachEl], keys: ['editor', 'coach'] });
    }
  }

  // The lone editor's two edges. Either one resizes both sides.
  const soloHandles = [-1, 1].map(side => {
    const el = makeHandle('col', 'Editor width');
    el.classList.add('split-solo');
    pbody.append(el);
    return { el, side };
  });

  let rowHandle = null;
  if (hostEl && resultsEl) {
    rowHandle = makeHandle('row', 'Editor and results');
    wsEl.style.position = wsEl.style.position || 'relative';
    wsEl.append(rowHandle);
  }

  function position() {
    const stacked = isStacked();
    const problemIsHidden = problemHidden();
    const box = pbody.getBoundingClientRect();

    for (const h of handles) {
      const [left, right] = h.between;
      const hidden = stacked || (problemIsHidden && h.keys[1] !== 'coach') || (h.keys[1] === 'coach' && !coachOpen()) || right.offsetParent === null;
      h.el.hidden = hidden;
      if (hidden) continue;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      h.el.style.left = `${(a.right + b.left) / 2 - box.left}px`;
      h.el.style.top = `${a.top - box.top}px`;
      h.el.style.height = `${Math.max(a.height, b.height)}px`;
    }

    const solo = isSolo();
    const wsBox = solo ? wsEl.getBoundingClientRect() : null;
    for (const h of soloHandles) {
      h.el.hidden = !solo;
      if (!solo) continue;
      h.el.style.left = `${(h.side < 0 ? wsBox.left : wsBox.right) - box.left}px`;
      h.el.style.top = `${wsBox.top - box.top}px`;
      h.el.style.height = `${wsBox.height}px`;
    }

    if (rowHandle && resultsEl) {
      const hide = stacked || resultsEl.offsetParent === null;
      rowHandle.hidden = hide;
      if (!hide) {
        const wsBox = wsEl.getBoundingClientRect();
        const rBox = resultsEl.getBoundingClientRect();
        rowHandle.style.top = `${rBox.top - wsBox.top}px`;
      }
    }
  }

  function dragColumn(handle, event) {
    const [leftEl, rightEl] = handle.between;
    const [leftKey, rightKey] = handle.keys;
    const startX = event.clientX;
    const leftStart = leftEl.getBoundingClientRect().width;
    const rightStart = rightEl.getBoundingClientRect().width;
    const totalFr = layout[leftKey] + layout[rightKey];
    const totalPx = leftStart + rightStart;

    const minLeft = leftKey === 'statement' ? MIN.statement : MIN.editor;
    const minRight = MIN[rightKey];

    document.body.classList.add('is-splitting');
    handle.el.setPointerCapture?.(event.pointerId);

    const move = (e) => {
      const delta = e.clientX - startX;
      const nextLeft = Math.min(Math.max(leftStart + delta, minLeft), totalPx - minRight);
      const ratio = nextLeft / totalPx;
      layout[leftKey] = totalFr * ratio;
      layout[rightKey] = totalFr * (1 - ratio);
      applyColumns(pbody);
      position();
    };
    const up = () => {
      document.body.classList.remove('is-splitting');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveLayout(layout);
      window.dispatchEvent(new Event('resize')); // Monaco relays out on this
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** The width the lone editor may take: the pane area inside its padding. */
  function soloRoom() {
    const style = getComputedStyle(pbody);
    return pbody.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  }

  function setSolo(width) {
    const room = soloRoom();
    const next = Math.max(MIN.editor, Math.round(width));
    layout.solo = next >= room - SOLO_SNAP ? 0 : next;
    applyColumns(pbody);
    position();
  }

  function dragSolo(handle, event) {
    const startX = event.clientX;
    const startWidth = wsEl.getBoundingClientRect().width;
    document.body.classList.add('is-splitting');
    handle.el.setPointerCapture?.(event.pointerId);
    // The far edge mirrors this one, so the column grows by twice the pointer's travel.
    const move = (e) => setSolo(startWidth + 2 * handle.side * (e.clientX - startX));
    const up = () => {
      document.body.classList.remove('is-splitting');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  for (const h of soloHandles) {
    const settle = () => { saveLayout(layout); window.dispatchEvent(new Event('resize')); };
    const onDown = (e) => { if (e.button === 0) { e.preventDefault(); dragSolo(h, e); } };
    const onReset = () => { layout.solo = DEFAULTS.solo; applyColumns(pbody); position(); settle(); };
    const onKey = (e) => {
      const step = e.shiftKey ? 120 : 40;
      // Each handle's outward arrow widens the column, its inward arrow narrows it.
      const outward = h.side < 0 ? 'ArrowLeft' : 'ArrowRight', inward = h.side < 0 ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === 'Enter' || e.key === ' ') { onReset(); e.preventDefault(); return; }
      if (e.key !== outward && e.key !== inward) return;
      e.preventDefault();
      e.stopPropagation();
      setSolo(wsEl.getBoundingClientRect().width + (e.key === outward ? step : -step));
      settle();
    };
    h.el.addEventListener('pointerdown', onDown);
    h.el.addEventListener('dblclick', onReset);
    h.el.addEventListener('keydown', onKey);
    cleanups.push(() => {
      h.el.removeEventListener('pointerdown', onDown);
      h.el.removeEventListener('dblclick', onReset);
      h.el.removeEventListener('keydown', onKey);
      h.el.remove();
    });
  }

  function dragRow(event) {
    const startY = event.clientY;
    const startHeight = resultsEl.getBoundingClientRect().height;
    const available = wsEl.getBoundingClientRect().height;

    document.body.classList.add('is-splitting');
    rowHandle.setPointerCapture?.(event.pointerId);

    let collapse = false;
    const move = (e) => {
      const next = startHeight - (e.clientY - startY);
      collapse = next < COLLAPSE_BELOW;
      layout.results = Math.min(
        Math.max(next, MIN_RESULTS_HEIGHT),
        available - MIN_EDITOR_HEIGHT,
      );
      applyResultsHeight(resultsEl);
      position();
    };
    const up = () => {
      document.body.classList.remove('is-splitting');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (collapse) {
        // Reopen at the height it had before this drag, not as a sliver.
        layout.results = Math.max(startHeight, DEFAULT_RESULTS_HEIGHT);
        applyResultsHeight(resultsEl);
        window.dispatchEvent(new CustomEvent('studio:toggle-results'));
      }
      saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  for (const h of handles) {
    const onDown = (e) => { if (e.button === 0) { e.preventDefault(); dragColumn(h, e); } };
    const onReset = () => {
      const [a, b] = h.keys;
      layout[a] = DEFAULTS[a];
      layout[b] = DEFAULTS[b];
      applyColumns(pbody); position(); saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    const onKey = (e) => {
      const step = e.shiftKey ? 0.12 : 0.04;
      const [a, b] = h.keys;
      if (e.key === 'ArrowLeft') { layout[a] = Math.max(0.2, layout[a] - step); layout[b] += step; }
      else if (e.key === 'ArrowRight') { layout[a] += step; layout[b] = Math.max(0.2, layout[b] - step); }
      else if (e.key === 'Enter' || e.key === ' ') { onReset(); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
      applyColumns(pbody); position(); saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    h.el.addEventListener('pointerdown', onDown);
    h.el.addEventListener('dblclick', onReset);
    h.el.addEventListener('keydown', onKey);
    cleanups.push(() => {
      h.el.removeEventListener('pointerdown', onDown);
      h.el.removeEventListener('dblclick', onReset);
      h.el.removeEventListener('keydown', onKey);
      h.el.remove();
    });
  }

  if (rowHandle) {
    const onDown = (e) => { if (e.button === 0) { e.preventDefault(); dragRow(e); } };
    const onReset = () => {
      layout.results = null;
      applyResultsHeight(resultsEl); position(); saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    const onKey = (e) => {
      const current = resultsEl.getBoundingClientRect().height;
      const step = e.shiftKey ? 60 : 20;
      if (e.key === 'ArrowUp') layout.results = current + step;
      else if (e.key === 'ArrowDown') layout.results = Math.max(MIN_RESULTS_HEIGHT, current - step);
      else if (e.key === 'Enter' || e.key === ' ') { onReset(); e.preventDefault(); return; }
      else return;
      e.preventDefault();
      e.stopPropagation();
      applyResultsHeight(resultsEl); position(); saveLayout(layout);
      window.dispatchEvent(new Event('resize'));
    };
    rowHandle.addEventListener('pointerdown', onDown);
    rowHandle.addEventListener('dblclick', onReset);
    rowHandle.addEventListener('keydown', onKey);
    cleanups.push(() => {
      rowHandle.removeEventListener('pointerdown', onDown);
      rowHandle.removeEventListener('dblclick', onReset);
      rowHandle.removeEventListener('keydown', onKey);
      rowHandle.remove();
    });
  }

  applyColumns(pbody);
  applyResultsHeight(resultsEl);
  requestAnimationFrame(position);

  let layoutFrame = 0, positionFrame = 0;
  const onWindowResize = () => { cancelAnimationFrame(layoutFrame); layoutFrame = requestAnimationFrame(() => { applyColumns(pbody); applyResultsHeight(resultsEl); position(); }); };
  const schedulePosition = () => { cancelAnimationFrame(positionFrame); positionFrame = requestAnimationFrame(position); };
  window.addEventListener('resize', onWindowResize);

  // The coach column and focus mode both appear and vanish via a body class, and the
  // handles have to follow them.
  const observer = new MutationObserver(() => {
    applyColumns(pbody);
    applyResultsHeight(resultsEl);
    requestAnimationFrame(position);
  });
  observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

  // The results panel grows when a run finishes; the handle sits on its edge.
  const ro = new ResizeObserver(schedulePosition);
  if (resultsEl) ro.observe(resultsEl);
  ro.observe(pbody);

  teardown = () => {
    cancelAnimationFrame(layoutFrame); cancelAnimationFrame(positionFrame); window.removeEventListener('resize', onWindowResize);
    observer.disconnect();
    ro.disconnect();
    for (const fn of cleanups) fn();
    teardown = null;
  };
}

export default installResizers;
