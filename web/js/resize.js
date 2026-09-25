// Draggable splits on the problem screen.
//
// Three of them: statement | editor, editor | coach, and editor / results. Each one
// remembers where you put it, because a layout you have to re-drag every morning is worse
// than one that never moved.
//
// The panes are grid columns, so the handles are absolutely positioned over the gaps
// rather than being grid children — that keeps the column count fixed whether or not the
// coach is open, and means nothing here has to restructure the DOM it sits in.

const STORE_KEY = 'studio.layout.v1';

// Below these a pane stops being usable rather than merely small: a statement you cannot
// read a line of, an editor narrower than a signature, a coach column of broken words.
const MIN = { statement: 280, editor: 420, coach: 300 };
const MIN_EDITOR_HEIGHT = 150;
const MIN_RESULTS_HEIGHT = 90;
// Enough to read a couple of cases and their printed output without dragging first.
const DEFAULT_RESULTS_HEIGHT = 260;

// The editor is the reason the screen exists, so it is the widest column by default.
const DEFAULTS = { statement: 0.92, editor: 1.35, coach: 0.86, results: DEFAULT_RESULTS_HEIGHT };

function loadLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    return {
      statement: Number(raw.statement) > 0 ? Number(raw.statement) : DEFAULTS.statement,
      editor: Number(raw.editor) > 0 ? Number(raw.editor) : DEFAULTS.editor,
      coach: Number(raw.coach) > 0 ? Number(raw.coach) : DEFAULTS.coach,
      results: Number(raw.results) > 0 ? Number(raw.results) : DEFAULTS.results,
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

function applyColumns(pbody) {
  if (isStacked() || problemHidden()) {
    pbody.style.removeProperty('grid-template-columns');
    return;
  }
  const { statement, editor, coach } = layout;
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

  let rowHandle = null;
  if (hostEl && resultsEl) {
    rowHandle = makeHandle('row', 'Editor and results');
    wsEl.style.position = wsEl.style.position || 'relative';
    wsEl.append(rowHandle);
  }

  function position() {
    const stacked = isStacked() || problemHidden();
    const box = pbody.getBoundingClientRect();

    for (const h of handles) {
      const [left, right] = h.between;
      const hidden = stacked || (h.keys[1] === 'coach' && !coachOpen()) || right.offsetParent === null;
      h.el.hidden = hidden;
      if (hidden) continue;
      const a = left.getBoundingClientRect();
      const b = right.getBoundingClientRect();
      h.el.style.left = `${(a.right + b.left) / 2 - box.left}px`;
      h.el.style.top = `${a.top - box.top}px`;
      h.el.style.height = `${Math.max(a.height, b.height)}px`;
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
    const minRight = rightKey === 'coach' ? MIN.coach : MIN.editor;

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

  function dragRow(event) {
    const startY = event.clientY;
    const startHeight = resultsEl.getBoundingClientRect().height;
    const available = wsEl.getBoundingClientRect().height;

    document.body.classList.add('is-splitting');
    rowHandle.setPointerCapture?.(event.pointerId);

    const move = (e) => {
      const next = startHeight - (e.clientY - startY);
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

  const onWindowResize = () => { applyColumns(pbody); applyResultsHeight(resultsEl); position(); };
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
  const ro = new ResizeObserver(() => position());
  if (resultsEl) ro.observe(resultsEl);
  ro.observe(pbody);

  teardown = () => {
    window.removeEventListener('resize', onWindowResize);
    observer.disconnect();
    ro.disconnect();
    for (const fn of cleanups) fn();
    teardown = null;
  };
}

export default installResizers;
