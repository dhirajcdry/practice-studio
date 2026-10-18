// Coach illustrations — fenced ```viz blocks, a small JSON vocabulary for the exact
// pictures an algorithm explanation keeps needing (a graph with weights, an array
// with two pointers, a DP grid, a tree, a linked list, a stack, a queue), drawn
// here from numbers and optionally stepped through frame by frame.
//
// This is MODEL OUTPUT DRAWN INTO OUR PAGE, so nothing here trusts its input:
//
//   - The JSON is parsed, then every field this file understands is validated and
//     rebuilt into a fresh object. Unknown keys are dropped, every string is cut to
//     a fixed length, every number we draw with comes from our own layout maths.
//   - Nothing the model wrote ever becomes markup. Labels reach the page through
//     textContent on <text> elements built with createElementNS; there is no
//     innerHTML anywhere in this file, so "<script>" in a label is just eight
//     characters of a label.
//   - Limits (node counts, grid size, frames, bytes) are enforced before any
//     layout runs, so a runaway block cannot stall the coach panel.
//
// The fallback is the rule, as in illustrator.js: a block this file cannot draw
// honestly is rejected with one plain sentence for the learner, and the caller
// shows the source instead. The one deliberate leniency is highlights: the contract
// says a highlight pointing at something that does not exist is ignored silently,
// because it changes the emphasis of a picture, never its content.
//
// Shape of the module: parsing and frame merging (pure), layout (pure — returns
// plain objects of numbers and strings, covered by tests), then a small painter
// that turns those objects into SVG nodes, then the stepper.

import { el, replace } from './dom.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ==========================================================================
   1. Vocabulary and limits (the contract, §1)
   ========================================================================== */

const MAX_BYTES = 40 * 1024;
const LIMITS = { nodes: 40, edges: 80, items: 40, rows: 6, grid: 20, level: 63, frames: 40, panels: 3 };

// Labels and values are cut to 40 characters, as the contract says. A title and a
// frame note are prose rather than labels, so they get more room; a step note cut
// at 40 characters would usually lose the verb.
const MAX_TEXT = 40;
const MAX_TITLE = 80;
const MAX_NOTE = 240;

const TYPES = ['graph', 'array', 'grid', 'tree', 'list', 'stack', 'queue', 'panels'];
const STATES = ['bad', 'active', 'done', 'dim'];   // precedence when an item has several

/** What a highlight item or a `labels` key refers to, per type. */
const KEY_KIND = {
  graph: 'id', array: 'index', list: 'index', stack: 'index', queue: 'index',
  grid: 'cell', tree: 'value',
};

class VizError extends Error {}
const reject = reason => { throw new VizError(reason); };
const SHOWN = 'so here is what the coach wrote.';

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Any JSON value as the single line of text we would draw for it. */
export function displayText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(displayText).join(', ')}]`;
  try { return JSON.stringify(value); } catch { return ''; }
}

/** displayText, cut to `max` characters with an ellipsis that says it was cut. */
export function clampText(value, max = MAX_TEXT) {
  const s = displayText(value);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toIndex(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\s*\d+\s*$/.test(v)) return Number(v);
  return null;
}

function toCell(v) {
  if (Array.isArray(v) && v.length === 2) {
    const r = toIndex(v[0]);
    const c = toIndex(v[1]);
    return r === null || c === null ? null : [r, c];
  }
  if (typeof v === 'string') {
    const m = /^\s*[([]?\s*(\d+)\s*,\s*(\d+)\s*[)\]]?\s*$/.exec(v);
    if (m) return [Number(m[1]), Number(m[2])];
  }
  return null;
}

/** One highlight item or labels key, as the string key the drawing looks up. */
function keyOf(kind, v) {
  if (kind === 'id' || kind === 'value') return clampText(v);
  if (kind === 'index') { const i = toIndex(v); return i === null ? null : String(i); }
  if (kind === 'cell') { const c = toCell(v); return c ? `${c[0]},${c[1]}` : null; }
  return null;
}

/* ==========================================================================
   2. Parsing — validate and rebuild every field we understand
   ========================================================================== */

function normaliseHighlights(kind, raw, out) {
  for (const state of STATES) {
    if (!(state in raw)) continue;
    const value = raw[state];
    // A lone [r, c] pair for a grid is one cell, not two highlights.
    const loneCell = kind === 'cell' && Array.isArray(value) && toCell(value) && !Array.isArray(value[0]);
    const items = loneCell ? [value] : Array.isArray(value) ? value : [value];
    out[state] = items.map(v => keyOf(kind, v)).filter(k => k !== null && k !== '');
  }
  if ('labels' in raw) {
    const labels = {};
    if (isObject(raw.labels)) {
      for (const [k, v] of Object.entries(raw.labels)) {
        const key = keyOf(kind, k);
        if (key !== null && key !== '') labels[key] = clampText(v);
      }
    }
    out.labels = labels;
  }
}

function normalisePointers(raw) {
  const out = [];
  if (!isObject(raw)) return out;
  for (const [name, at] of Object.entries(raw)) {
    // `{"l": 0, "r": 3}` is the contract; `{"l": [0, 2]}` is read as two arrows.
    for (const v of Array.isArray(at) ? at : [at]) {
      const index = toIndex(v);
      if (index !== null) out.push({ name: clampText(name), index });
    }
  }
  return out;
}

function valueList(raw, what) {
  if (!Array.isArray(raw)) reject(`The ${what} in the illustration should be a list, ${SHOWN}`);
  return raw.map(v => clampText(v));
}

function normaliseNode(n) {
  if (typeof n === 'string' || typeof n === 'number') {
    const id = clampText(n);
    if (id) return { id, label: id };
  }
  if (isObject(n) && (n.id !== undefined || n.label !== undefined)) {
    const id = clampText(n.id !== undefined ? n.id : n.label);
    if (id) return { id, label: n.label !== undefined ? clampText(n.label) : id };
  }
  return reject(`A node in the graph could not be read, ${SHOWN}`);
}

function normaliseEdge(e) {
  let from, to, label;
  if (Array.isArray(e) && e.length >= 2) [from, to, label] = e;
  else if (isObject(e)) {
    from = e.from; to = e.to;
    label = e.label !== undefined ? e.label : e.weight !== undefined ? e.weight : e.w;
  }
  const ok = v => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number';
  if (!ok(from) || !ok(to)) reject(`An edge in the graph could not be read, ${SHOWN}`);
  return { from: clampText(from), to: clampText(to), label: label === undefined || label === null ? '' : clampText(label) };
}

function normaliseRow(row, index) {
  if (Array.isArray(row)) row = { values: row };
  if (!isObject(row)) reject(`Row ${index + 1} of the array could not be read, ${SHOWN}`);
  const out = { name: clampText(row.name ?? ''), values: valueList(row.values ?? [], 'row values') };
  normaliseHighlights('index', row, out);
  if ('pointers' in row) out.pointers = normalisePointers(row.pointers);
  return out;
}

/**
 * Rebuild the fields of one spec (or one frame, which is a partial spec) that this
 * file knows about for `type`. Unknown keys are left behind on purpose.
 */
function normaliseFields(type, raw, { panelTypes = null } = {}) {
  const out = {};
  if ('title' in raw) out.title = clampText(raw.title, MAX_TITLE);
  if ('note' in raw) out.note = clampText(raw.note, MAX_NOTE);
  if (KEY_KIND[type]) normaliseHighlights(KEY_KIND[type], raw, out);

  switch (type) {
    case 'graph': {
      if ('nodes' in raw) {
        if (!Array.isArray(raw.nodes)) reject(`The graph's nodes should be a list, ${SHOWN}`);
        const seen = new Set();
        out.nodes = raw.nodes.map(normaliseNode).filter(n => !seen.has(n.id) && seen.add(n.id));
      }
      if ('edges' in raw) {
        if (!Array.isArray(raw.edges)) reject(`The graph's edges should be a list, ${SHOWN}`);
        out.edges = raw.edges.map(normaliseEdge);
      }
      if ('directed' in raw) out.directed = raw.directed !== false;
      if ('path' in raw) out.path = Array.isArray(raw.path) ? raw.path.map(v => clampText(v)) : [];
      break;
    }
    case 'array': {
      if ('values' in raw) out.values = valueList(raw.values, 'values');
      if ('rows' in raw) {
        if (!Array.isArray(raw.rows)) reject(`The array's rows should be a list, ${SHOWN}`);
        out.rows = raw.rows.map(normaliseRow);
      }
      if ('pointers' in raw) out.pointers = normalisePointers(raw.pointers);
      if ('window' in raw) {
        const lo = Array.isArray(raw.window) ? toIndex(raw.window[0]) : null;
        const hi = Array.isArray(raw.window) ? toIndex(raw.window[1]) : null;
        out.window = lo === null || hi === null ? null : [Math.min(lo, hi), Math.max(lo, hi)];
      }
      if ('showIndex' in raw) out.showIndex = raw.showIndex !== false;
      break;
    }
    case 'grid': {
      if ('cells' in raw) {
        if (!Array.isArray(raw.cells)) reject(`The grid's cells should be a list of rows, ${SHOWN}`);
        out.cells = raw.cells.map((row, r) => {
          if (!Array.isArray(row)) reject(`Row ${r + 1} of the grid is not a list, ${SHOWN}`);
          return row.map(v => (v === null ? null : clampText(v)));
        });
      }
      if ('rowLabels' in raw) out.rowLabels = Array.isArray(raw.rowLabels) ? raw.rowLabels.map(v => clampText(v)) : [];
      if ('colLabels' in raw) out.colLabels = Array.isArray(raw.colLabels) ? raw.colLabels.map(v => clampText(v)) : [];
      if ('arrows' in raw) {
        if (!Array.isArray(raw.arrows)) reject(`The grid's arrows should be a list, ${SHOWN}`);
        out.arrows = raw.arrows.map(a => {
          const from = Array.isArray(a) ? toCell(a[0]) : null;
          const to = Array.isArray(a) ? toCell(a[1]) : null;
          if (!from || !to) reject(`An arrow in the grid could not be read, ${SHOWN}`);
          return [from, to];
        });
      }
      if ('path' in raw) {
        if (!Array.isArray(raw.path)) reject(`The grid's path should be a list of [row, col] cells, ${SHOWN}`);
        out.path = raw.path.map(c => toCell(c) || reject(`A cell in the grid's path could not be read, ${SHOWN}`));
      }
      break;
    }
    case 'tree': {
      if ('level' in raw) {
        if (!Array.isArray(raw.level)) reject(`The tree's level order should be a list, ${SHOWN}`);
        // "null" in quotes is still LeetCode's null; no tree has a node called null.
        out.level = raw.level.map(v => (v === null || v === 'null' ? null : clampText(v)));
      }
      break;
    }
    case 'list': {
      if ('values' in raw) out.values = valueList(raw.values, 'list values');
      if ('pointers' in raw) out.pointers = normalisePointers(raw.pointers);
      if ('cycleTo' in raw) out.cycleTo = toIndex(raw.cycleTo);
      if ('showNull' in raw) out.showNull = raw.showNull !== false;
      break;
    }
    case 'stack':
    case 'queue': {
      if ('items' in raw) out.items = valueList(raw.items, `${type} items`);
      if ('label' in raw) out.label = clampText(raw.label);
      break;
    }
    case 'panels': {
      if (!('panels' in raw)) break;
      if (!Array.isArray(raw.panels)) reject(`The panels should be a list of illustrations, ${SHOWN}`);
      if (panelTypes) {
        // A frame's panels are partials, merged by index into the base panels.
        out.panels = raw.panels.slice(0, panelTypes.length).map((p, k) => {
          if (p === null || p === undefined) return null;
          if (!isObject(p)) reject(`A panel in one of the steps could not be read, ${SHOWN}`);
          return normaliseFields(panelTypes[k], p);
        });
      } else {
        if (raw.panels.length > LIMITS.panels) {
          reject(`The illustration had ${raw.panels.length} panels; the limit is ${LIMITS.panels}, ${SHOWN}`);
        }
        out.panels = raw.panels.map(p => {
          if (!isObject(p)) reject(`A panel in the illustration could not be read, ${SHOWN}`);
          const t = typeof p.type === 'string' ? p.type.trim().toLowerCase() : '';
          if (t === 'panels') reject(`Panels cannot contain more panels, ${SHOWN}`);
          if (!TYPES.includes(t)) reject(`A panel has no type this renderer draws (graph, array, grid, tree, list, stack or queue), ${SHOWN}`);
          return { type: t, ...normaliseFields(t, p) };
        });
      }
      break;
    }
    default: break;
  }
  return out;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function overLimit(where, count, what, limit) {
  if (count > limit) reject(`${where} had ${plural(count, what)}; the limit is ${limit}, ${SHOWN}`);
}

/** Check limits on a whole (merged) spec — the base, or the base with one frame. */
function checkSpec(spec, where) {
  switch (spec.type) {
    case 'graph': {
      const ids = new Set((spec.nodes || []).map(n => n.id));
      for (const e of spec.edges || []) { ids.add(e.from); ids.add(e.to); }
      overLimit(where, ids.size, 'node', LIMITS.nodes);
      overLimit(where, (spec.edges || []).length, 'edge', LIMITS.edges);
      break;
    }
    case 'array': {
      overLimit(where, (spec.rows || []).length, 'row', LIMITS.rows);
      for (const row of [{ values: spec.values || [] }, ...(spec.rows || [])]) {
        overLimit(where, row.values.length, 'item', LIMITS.items);
      }
      break;
    }
    case 'grid': {
      const cells = spec.cells || [];
      overLimit(where, cells.length, 'grid row', LIMITS.grid);
      overLimit(where, cells.reduce((m, r) => Math.max(m, r.length), 0), 'grid column', LIMITS.grid);
      break;
    }
    case 'tree': overLimit(where, (spec.level || []).length, 'level-order entry', LIMITS.level); break;
    case 'list': overLimit(where, (spec.values || []).length, 'item', LIMITS.items); break;
    case 'stack':
    case 'queue': overLimit(where, (spec.items || []).length, 'item', LIMITS.items); break;
    case 'panels': {
      const panels = spec.panels || [];
      if (!panels.length) reject(`${where} had no panels to draw, ${SHOWN}`);
      overLimit(where, panels.length, 'panel', LIMITS.panels);
      panels.forEach((p, k) => checkSpec(p, `Panel ${k + 1} of ${where.charAt(0).toLowerCase()}${where.slice(1)}`));
      break;
    }
    default: break;
  }
}

/**
 * Read one ```viz block.
 *
 * @param {string} code the block's contents
 * @returns {{ok:true, spec:object} | {ok:false, reason:string}}
 */
export function parseViz(code) {
  try {
    if (typeof code !== 'string' || code.trim() === '') reject('The illustration was empty, so there is nothing to draw.');
    const bytes = new TextEncoder().encode(code).length;
    if (bytes > MAX_BYTES) reject(`The illustration was ${Math.ceil(bytes / 1024)} KB; the limit is 40 KB, ${SHOWN}`);

    let raw;
    try { raw = JSON.parse(code); } catch { reject(`The illustration is not valid JSON, ${SHOWN}`); }
    if (!isObject(raw)) reject(`The illustration should be a JSON object with a "type", ${SHOWN}`);

    const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    if (!type) reject(`The illustration did not say which "type" to draw, ${SHOWN}`);
    if (!TYPES.includes(type)) {
      reject(`Illustrations of type "${clampText(raw.type, 24)}" are not drawn here (graph, array, grid, tree, list, stack, queue or panels), ${SHOWN}`);
    }

    const spec = { type, ...normaliseFields(type, raw) };
    delete spec.note;                                    // a note belongs to a frame
    if (type === 'panels' && !spec.panels) reject(`The illustration had no panels to draw, ${SHOWN}`);
    checkSpec(spec, 'The illustration');

    if (raw.frames !== undefined && raw.frames !== null) {
      if (!Array.isArray(raw.frames)) reject(`The steps ("frames") should be a list, ${SHOWN}`);
      overLimit('The illustration', raw.frames.length, 'step', LIMITS.frames);
      if (raw.frames.length) {
        const panelTypes = type === 'panels' ? spec.panels.map(p => p.type) : null;
        spec.frames = raw.frames.map((frame, i) => {
          if (!isObject(frame)) reject(`Step ${i + 1} of the illustration could not be read, ${SHOWN}`);
          return normaliseFields(type, frame, { panelTypes });
        });
        // Each step is drawn on its own, so each one has to fit the limits.
        spec.frames.forEach((_, i) => checkSpec(resolveFrame(spec, i), `Step ${i + 1} of the illustration`));
      }
    }
    return { ok: true, spec };
  } catch (err) {
    if (err instanceof VizError) return { ok: false, reason: err.message };
    return { ok: false, reason: `The illustration could not be read, ${SHOWN}` };
  }
}

/**
 * The spec as it looks at frame `index`: the base with that frame's fields laid
 * over it (a shallow override — a frame key replaces the base key). For panels,
 * a frame's `panels` merge by index, each partial a shallow override of its panel.
 * Frames are independent of each other, never cumulative. Pure.
 *
 * @param {object} spec a spec from parseViz
 * @param {number} index
 * @returns {object} a spec without `frames`, carrying that frame's `note`
 */
export function resolveFrame(spec, index) {
  const { frames, ...base } = spec;
  delete base.note;
  if (!Array.isArray(frames) || !frames.length) return base;
  const i = Math.max(0, Math.min(frames.length - 1, Math.trunc(Number(index)) || 0));
  // `type` and nested `frames` in a frame are ignored: a step cannot turn a graph
  // into a grid.
  const { panels, type: _type, frames: _frames, ...frame } = frames[i] || {};
  const out = { ...base, ...frame, type: base.type };
  if (base.type === 'panels' && Array.isArray(base.panels)) {
    out.panels = base.panels.map((p, k) => (Array.isArray(panels) && isObject(panels[k])
      ? { ...p, ...panels[k], type: p.type }
      : p));
  }
  return out;
}

/* ==========================================================================
   3. Layout primitives — plain objects, so layout stays pure and testable
   ========================================================================== */

const FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const CHAR_W = 7.1;                       // mono stack at 12px, as in illustrator.js
const textW = (s, size = 12) => String(s).length * CHAR_W * (size / 12);
const maxTextW = (list, size) => list.reduce((m, s) => Math.max(m, textW(s, size)), 0);

// Ink on paper in every theme: the canvas is --diagram-paper even in dark themes,
// so these are fixed colours rather than theme variables.
const INK = '#111111';
const MUTED = '#555555';
const PAPER = '#FAFAF7';
const EDGE = 'rgba(0,0,0,.5)';
const LOOK = {
  plain: { stroke: 'rgba(0,0,0,.55)', fill: '#FFFFFF', text: INK, sw: 1.1, note: MUTED },
  active: { stroke: '#E8590C', fill: '#FFE8D9', text: INK, sw: 2, note: '#C2410C' },
  done: { stroke: '#2F9E44', fill: '#E3F5E6', text: INK, sw: 2, note: '#2B8A3E' },
  bad: { stroke: '#C92A2A', fill: '#FDE2E2', text: INK, sw: 2, note: '#C92A2A' },
  dim: { stroke: '#BDBDBD', fill: '#F2F2F2', text: '#9E9E9E', sw: 1, note: '#9E9E9E' },
};

/** Arrowheads, one marker per colour. L is the head's length, W its width. */
const MARKERS = {
  edge: { color: EDGE, L: 9, W: 8 },
  active: { color: '#E8590C', L: 10, W: 9 },
  done: { color: '#2F9E44', L: 9, W: 8 },
  bad: { color: '#C92A2A', L: 9, W: 8 },
  dim: { color: '#BDBDBD', L: 8, W: 7 },
  ink: { color: INK, L: 8, W: 7 },
  muted: { color: MUTED, L: 8, W: 7 },
  ptr: { color: INK, L: 6, W: 6 },
};
// The line stops this far short of where the tip should land and the marker makes
// up the difference, so a thick line's square end never pokes out past the point.
const TRIM = 3;

const r1 = v => Math.round(v * 10) / 10;
const P = ([x, y]) => `${r1(x)},${r1(y)}`;

const rect = (x, y, w, h, o = {}) => ({ kind: 'rect', x, y, w, h, ...o });
const text = (x, y, s, o = {}) => ({ kind: 'text', x, y, text: String(s), size: 12, anchor: 'middle', fill: INK, ...o });
const group = (dx, dy, items) => ({ kind: 'g', dx, dy, items });
const path = (d, pts, o = {}) => ({ kind: 'path', d, pts, ...o });

/** Pull a point back toward `toward` by `by` px — leaves room for an arrowhead. */
function pullBack(end, toward, by) {
  const dx = toward[0] - end[0];
  const dy = toward[1] - end[1];
  const len = Math.hypot(dx, dy) || 1;
  return [end[0] + (dx / len) * by, end[1] + (dy / len) * by];
}

/** A straight line; with `arrow`, its tip lands exactly on `b`. */
function arrowLine(a, b, o = {}) {
  const end = o.arrow ? pullBack(b, a, TRIM) : b;
  return path(`M${P(a)} L${P(end)}`, [a, b], o);
}

/** A quadratic curve through control `q`; with `arrow`, its tip lands exactly on `b`. */
function arrowQuad(a, q, b, o = {}) {
  const end = o.arrow ? pullBack(b, q, TRIM) : b;
  return path(`M${P(a)} Q${P(q)} ${P(end)}`, [a, quadAt(a, q, b, 0.5), b], o);
}

function arrowCubic(a, c1, c2, b, o = {}) {
  const end = o.arrow ? pullBack(b, c2, TRIM) : b;
  // The curve's highest point, not its control points, bounds the drawing.
  const mid = [(a[0] + 3 * c1[0] + 3 * c2[0] + b[0]) / 8, (a[1] + 3 * c1[1] + 3 * c2[1] + b[1]) / 8];
  return path(`M${P(a)} C${P(c1)} ${P(c2)} ${P(end)}`, [a, mid, b], o);
}

function quadAt(a, q, b, t) {
  return [
    (1 - t) ** 2 * a[0] + 2 * (1 - t) * t * q[0] + t * t * b[0],
    (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * q[1] + t * t * b[1],
  ];
}

/** Bounding box of a list of primitives. Text is measured with CHAR_W, not the DOM. */
export function boundsOf(items, dx = 0, dy = 0) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x, y) => {
    box[0] = Math.min(box[0], x + dx); box[1] = Math.min(box[1], y + dy);
    box[2] = Math.max(box[2], x + dx); box[3] = Math.max(box[3], y + dy);
  };
  for (const it of items) {
    if (it.kind === 'g') {
      const inner = boundsOf(it.items, dx + it.dx, dy + it.dy);
      if (inner[0] !== Infinity) { add(inner[0] - dx, inner[1] - dy); add(inner[2] - dx, inner[3] - dy); }
    } else if (it.kind === 'rect') {
      const s = (it.sw || 1) / 2;
      add(it.x - s, it.y - s); add(it.x + it.w + s, it.y + it.h + s);
    } else if (it.kind === 'circle') {
      add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r);
    } else if (it.kind === 'path') {
      for (const [x, y] of it.pts) { add(x - 3, y - 3); add(x + 3, y + 3); }
    } else if (it.kind === 'text') {
      const w = textW(it.text, it.size) * (it.spread || 1);
      const x0 = it.anchor === 'start' ? it.x : it.anchor === 'end' ? it.x - w : it.x - w / 2;
      add(x0, it.y - it.size * 0.65); add(x0 + w, it.y + it.size * 0.65);
    }
  }
  return box;
}

/** Normalise a drawing so its top-left is at (pad, pad) and report its size. */
function finish(items, pad = 2) {
  const [x0, y0, x1, y1] = boundsOf(items);
  if (x0 === Infinity) return { width: 0, height: 0, items: [] };
  return {
    width: Math.ceil(x1 - x0 + pad * 2),
    height: Math.ceil(y1 - y0 + pad * 2),
    items: [group(pad - x0, pad - y0, items)],
  };
}

/** The quiet placeholder an empty structure draws instead of nothing at all. */
function emptyMark(x, y, w = 88, h = 34, label = 'empty') {
  return [
    rect(x, y, w, h, { rx: 6, fill: 'none', stroke: '#BDBDBD', sw: 1, dash: '4 3' }),
    text(x + w / 2, y + h / 2, label, { size: 11, fill: '#9E9E9E' }),
  ];
}

function marksOf(spec) {
  const m = { labels: new Map(Object.entries(spec.labels || {})) };
  for (const s of STATES) m[s] = new Set(spec[s] || []);
  return m;
}

function mergeMarks(a, b, withLabels) {
  const m = { labels: new Map([...(withLabels ? a.labels : []), ...b.labels]) };
  for (const s of STATES) m[s] = new Set([...a[s], ...b[s]]);
  return m;
}

function stateOf(marks, key) {
  for (const s of STATES) if (marks[s].has(key)) return s;
  return 'plain';
}

/** A cell, box or node outline in its highlight state. */
function shape(x, y, w, h, state, rx = 4) {
  const look = LOOK[state];
  return rect(x, y, w, h, { rx, fill: look.fill, stroke: look.stroke, sw: look.sw });
}

/** A small annotation with a paper backing, so it stays legible over a line. */
function note(x, y, s, state, anchor = 'middle', size = 10.5) {
  const w = textW(s, size) + 6;
  const x0 = anchor === 'start' ? x - 3 : anchor === 'end' ? x - w + 3 : x - w / 2;
  return [
    rect(x0, y - 7.5, w, 15, { rx: 3, fill: PAPER, stroke: 'none', sw: 0 }),
    text(x, y, s, { size, fill: LOOK[state].note, anchor, weight: 600 }),
  ];
}

/** Named arrows under cells: `l` and `r` sharing a cell read "l, r", or stack. */
function pointerBlock(pointers, count, cxOf, y, slotW) {
  const at = new Map();
  for (const p of pointers || []) {
    if (p.index >= count) continue;                    // pointing past the end: ignored
    if (!at.has(p.index)) at.set(p.index, []);
    if (!at.get(p.index).includes(p.name)) at.get(p.index).push(p.name);
  }
  if (!at.size) return { items: [], height: 0 };
  const items = [];
  let lines = 1;
  for (const [index, names] of at) {
    const cx = cxOf(index);
    items.push(arrowLine([cx, y + 15], [cx, y + 2], { stroke: INK, sw: 1.2, arrow: 'ptr' }));
    const joined = names.join(', ');
    const rows = names.length > 1 && textW(joined, 11) > slotW - 4 ? names : [joined];
    rows.forEach((s, k) => items.push(text(cx, y + 23 + k * 13, s, { size: 11, weight: 600 })));
    lines = Math.max(lines, rows.length);
  }
  return { items, height: 17 + lines * 13 };
}

/* ==========================================================================
   4. Layout per type
   ========================================================================== */

/* -------------------------------- graph ---------------------------------- */

/** True when a pill (a circle when w === h) centred at 0,0 contains (x, y). */
function insidePill(node, x, y) {
  const r = node.h / 2;
  const core = node.w / 2 - r;
  const dx = Math.max(0, Math.abs(x) - core);
  return dx * dx + y * y <= r * r;
}

/** Where a ray from the node's centre in direction (ux, uy) leaves its outline. */
function boundaryPoint(node, ux, uy) {
  const len = Math.hypot(ux, uy) || 1;
  const dx = ux / len;
  const dy = uy / len;
  let lo = 0;
  let hi = Math.max(node.w, node.h);
  for (let i = 0; i < 22; i++) {
    const mid = (lo + hi) / 2;
    if (insidePill(node, dx * mid, dy * mid)) lo = mid; else hi = mid;
  }
  return [node.x + dx * lo, node.y + dy * lo];
}

/** DFS in declaration order; only edges to the active ancestry close a cycle. */
function backEdgesOf(nodes, edges) {
  const out = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) out.get(e.from).push(e);
  const active = new Set();
  const seen = new Set();
  const back = new Set();
  const visit = id => {
    seen.add(id);
    active.add(id);
    for (const e of out.get(id)) {
      if (active.has(e.to)) back.add(e);
      else if (!seen.has(e.to)) visit(e.to);
    }
    active.delete(id);
  };
  for (const n of nodes) if (!seen.has(n.id)) visit(n.id);
  return back;
}

/**
 * Left-to-right layers for a DAG: longest-path layering, then barycentric
 * ordering within each layer (forward, backward, forward) to untangle crossings.
 * Sets x, y (centres) on each node.
 */
export function placeLayered(nodes, edges, { gapX = 64, rowStep = 62 } = {}) {
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const succ = new Map(nodes.map(n => [n.id, []]));
  const pred = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) {
    succ.get(e.from).push(e.to);
    pred.get(e.to).push(e.from);
    indeg.set(e.to, indeg.get(e.to) + 1);
  }
  const layerOf = new Map(nodes.map(n => [n.id, 0]));
  const queue = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  while (queue.length) {
    const id = queue.shift();
    for (const to of succ.get(id)) {
      layerOf.set(to, Math.max(layerOf.get(to), layerOf.get(id) + 1));
      indeg.set(to, indeg.get(to) - 1);
      if (indeg.get(to) === 0) queue.push(to);
    }
  }

  const layers = [];
  for (const n of nodes) (layers[layerOf.get(n.id)] ||= []).push(n);
  for (let i = 0; i < layers.length; i++) layers[i] ||= [];

  // Positions are centred within a layer, so a layer of 1 and a layer of 3 line up
  // on their middles rather than on their tops.
  const pos = new Map();
  const index = L => L.forEach((n, i) => pos.set(n.id, i - (L.length - 1) / 2));
  layers.forEach(index);
  const sweep = (L, neighbours) => {
    const bary = new Map(L.map(n => {
      const ns = neighbours.get(n.id);
      return [n.id, ns.length ? ns.reduce((s, id) => s + pos.get(id), 0) / ns.length : pos.get(n.id)];
    }));
    L.sort((a, b) => bary.get(a.id) - bary.get(b.id));
    index(L);
  };
  for (let round = 0; round < 2; round++) {
    for (let i = 1; i < layers.length; i++) sweep(layers[i], pred);
    for (let i = layers.length - 2; i >= 0; i--) sweep(layers[i], succ);
  }
  for (let i = 1; i < layers.length; i++) sweep(layers[i], pred);

  let x = 0;
  for (const L of layers) {
    const colW = L.reduce((m, n) => Math.max(m, n.w, n.noteW || 0), 0);
    for (const n of L) {
      n.x = x + colW / 2;
      n.y = pos.get(n.id) * rowStep;
      n.noteDir = [0, 1];
    }
    x += colW + gapX;
  }
  return layers.length;
}

/** Nodes on an ellipse, wider than tall, in the order given, starting at the left. */
export function placeRing(nodes, { spread = 34 } = {}) {
  const n = nodes.length;
  if (n === 1) { Object.assign(nodes[0], { x: 0, y: 0, noteDir: [0, 1] }); return; }
  const around = nodes.reduce((s, node) => s + Math.max(node.w, node.noteW || 0) + spread, 0);
  const R = Math.max(80, around / (2 * Math.PI));
  const rx = R * 1.3;
  const ry = R * 0.85;
  nodes.forEach((node, i) => {
    const theta = Math.PI + (i * 2 * Math.PI) / n;
    const cx = Math.cos(theta);
    const cy = n === 2 ? 0 : Math.sin(theta);
    node.x = rx * cx;
    node.y = ry * cy;
    // Notes go outward, away from the middle where the edges run.
    const len = Math.hypot(cx, cy) || 1;
    node.noteDir = [cx / len, cy / len];
  });
}

function boxesOverlap(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

function nodeBox(n, grow = 0) {
  return [n.x - n.w / 2 - grow, n.y - n.h / 2 - grow, n.x + n.w / 2 + grow, n.y + n.h / 2 + grow];
}

/**
 * How far to bow an edge so it misses every other node. Straight when it can be;
 * a long edge in a layered DAG would otherwise run straight through a node in
 * the layer it skips.
 */
function bendFor(a, b, nodes) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const others = nodes.filter(n => n !== a && n !== b).map(n => nodeBox(n, 4));
  if (!others.length) return 0;
  for (const bend of [0, 30, -30, 54, -54, 80, -80]) {
    const q = [(a.x + b.x) / 2 + nx * bend * 2, (a.y + b.y) / 2 + ny * bend * 2];
    let clear = true;
    for (let t = 0.08; t <= 0.92 && clear; t += 0.04) {
      const [x, y] = quadAt([a.x, a.y], q, [b.x, b.y], t);
      if (others.some(box => x > box[0] && x < box[2] && y > box[1] && y < box[3])) clear = false;
    }
    if (clear) return bend;
  }
  return 0;
}

/** Keep graph annotations to two balanced lines, breaking only at spaces. */
function graphNoteLines(value) {
  const s = clampText(value, 40);
  if (s.length <= 18) return [s];
  const breaks = [...s.matchAll(/ /g)].map(m => m.index);
  if (!breaks.length) return [s]; // A single word stays intact; its full width is reserved.
  const at = breaks.reduce((best, i) =>
    Math.max(i, s.length - i - 1) < Math.max(best, s.length - best - 1) ? i : best);
  return [s.slice(0, at), s.slice(at + 1)];
}

export function layoutGraph(spec) {
  const marks = marksOf(spec);
  const nodes = [];
  const byId = new Map();
  const add = (id, label) => {
    if (byId.has(id)) return;
    const node = { id, label: label ?? id };
    byId.set(id, node);
    nodes.push(node);
  };
  for (const n of spec.nodes || []) add(n.id, n.label);
  const edges = spec.edges || [];
  for (const e of edges) { add(e.from); add(e.to); }   // an edge to an undeclared node still draws it
  if (!nodes.length) return finish(emptyMark(0, 0, 110, 36, 'empty graph'));

  for (const n of nodes) {
    n.h = 36;
    // A circle while the label fits one; a pill (rounded rect) once it does not.
    n.w = Math.max(36, Math.ceil(textW(n.label, 12) + 20));
    n.noteLines = marks.labels.has(n.id) ? graphNoteLines(marks.labels.get(n.id)) : [];
    n.noteW = n.noteLines.length ? maxTextW(n.noteLines, 10.5) + 6 : 0;
  }
  const directed = spec.directed !== false;
  const hasNotes = nodes.some(n => marks.labels.has(n.id));
  const labelW = edges.reduce((m, e) => Math.max(m, textW(e.label, 11)), 0);

  const backEdges = directed ? backEdgesOf(nodes, edges) : new Set();
  let layered = directed;
  if (directed) {
    const layers = placeLayered(nodes, edges.filter(e => !backEdges.has(e)), {
      gapX: Math.max(58, Math.ceil(labelW + 40)),
      rowStep: 36 + 28 + Math.max(...nodes.map(n => n.noteLines.length * 16)),
    });
    layered = !(nodes.length <= 8 && layers > 6);
  }
  if (!layered) {
    placeRing(nodes, { spread: 40 + (hasNotes ? 16 : 0) + (labelW ? 12 : 0) });
  }

  // The path: its nodes are active unless the coach said otherwise, and so are
  // the edges between consecutive entries.
  const pathList = (spec.path || []).filter(id => byId.has(id));
  const onPath = new Set();
  for (let i = 1; i < pathList.length; i++) {
    onPath.add(`${pathList[i - 1]}\u0001${pathList[i]}`);
    if (!directed) onPath.add(`${pathList[i]}\u0001${pathList[i - 1]}`);
  }
  const pathNodes = new Set(pathList);
  const stateOfNode = id => {
    const s = stateOf(marks, id);
    return s === 'plain' && pathNodes.has(id) ? 'active' : s;
  };

  const pairs = new Set(edges.map(e => `${e.from}\u0001${e.to}`));
  const drawn = new Set();
  const edgeItems = [];
  const labelItems = [];
  const taken = nodes.map(n => nodeBox(n, 2));
  const noteItems = [];
  for (const n of nodes) {
    if (!n.noteLines.length) continue;
    const [ux, uy] = n.noteDir;
    const [bx, by] = boundaryPoint(n, ux, uy);
    const anchor = ux > 0.45 ? 'start' : ux < -0.45 ? 'end' : 'middle';
    // Stack upward above the ring, downward below it, centred at its sides.
    const lineOffset = uy < -0.45 ? -(n.noteLines.length - 1) * 16
      : uy > 0.45 ? 0 : -(n.noteLines.length - 1) * 8;
    let distance = 0;
    let items, box;
    do {
      items = n.noteLines.flatMap((line, i) => note(
        bx + ux * (7 + distance), by + uy * (12 + distance) + lineOffset + i * 16,
        line, stateOfNode(n.id), anchor,
      ));
      box = boundsOf(items);
      distance += 8;
    } while (taken.some(b => boxesOverlap(b, [box[0] - 2, box[1] - 2, box[2] + 2, box[3] + 2])));
    // Reserve the exact painted block for both subsequent notes and edge labels.
    taken.push(box);
    noteItems.push(...items);
  }

  // Label slots along an edge, middle first; the first that collides with nothing
  // already placed wins, so two weights that meet at a crossing do not overprint.
  const placeLabel = (label, at, state) => {
    const w = textW(label, 11) + 8;
    let chosen = null;
    const slots = [0.5];
    for (let i = 1; i <= 15; i++) slots.push(0.5 - i / 100, 0.5 + i / 100);
    for (const t of slots) {
      const [x, y] = at(t);
      const box = [x - w / 2, y - 8, x + w / 2, y + 8];
      if (!taken.some(b => boxesOverlap(b, [box[0] - 1, box[1] - 1, box[2] + 1, box[3] + 1]))) { chosen = [x, y, box]; break; }
    }
    if (!chosen) return false; // The caller gives this edge an outside lane and retries.
    const [x, y, box] = chosen;
    taken.push(box);
    labelItems.push(rect(box[0], box[1], w, 16, { rx: 3, fill: PAPER, stroke: 'rgba(0,0,0,.14)', sw: 0.8 }));
    labelItems.push(text(x, y, label, {
      size: 11,
      fill: state === 'active' ? '#C2410C' : state === 'dim' ? '#9E9E9E' : MUTED,
      weight: state === 'active' ? 700 : 500,
    }));
    return true;
  };

  for (const e of edges) {
    const key = `${e.from}\u0001${e.to}`;
    if (drawn.has(key)) continue;                       // a repeated edge is drawn once
    drawn.add(key);
    if (!directed) drawn.add(`${e.to}\u0001${e.from}`);
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const lit = onPath.has(key);
    const dimmed = !lit && (marks.dim.has(e.from) || marks.dim.has(e.to));
    const state = lit ? 'active' : dimmed ? 'dim' : 'plain';
    const style = {
      stroke: lit ? LOOK.active.stroke : dimmed ? LOOK.dim.stroke : EDGE,
      sw: lit ? 2.6 : dimmed ? 1 : 1.3,
      arrow: directed ? (lit ? 'active' : dimmed ? 'dim' : 'edge') : null,
    };

    // Reserve outside lanes above all node/label boxes. Forward skip edges
    // normally bow below the layers; return arcs leave and enter from above.
    const outside = () => {
      const ceiling = Math.min(...taken.map(box => box[1]), ...edgeItems.flatMap(it => it.pts.map(p => p[1]))) - 28;
      const start = boundaryPoint(a, a === b ? -0.5 : 0, -1);
      const end = boundaryPoint(b, a === b ? 0.5 : 0, -1);
      // Set the midpoint explicitly above the occupied drawing, even when the
      // endpoints have different heights. Control points also bound the curve.
      const lift = (8 * ceiling - start[1] - end[1]) / 6;
      const c1 = [start[0] - (a === b ? 30 : 0), lift];
      const c2 = [end[0] + (a === b ? 30 : 0), lift];
      const at = t => [0, 1].map(k => (1 - t) ** 3 * start[k]
        + 3 * (1 - t) ** 2 * t * c1[k] + 3 * (1 - t) * t * t * c2[k] + t ** 3 * end[k]);
      const item = arrowCubic(start, c1, c2, end, style);
      item.pts = [start, c1, c2, end];
      return { item, at };
    };

    let route;
    if (layered && backEdges.has(e)) {
      route = outside();
    } else if (a === b) {
      const top = a.y - a.h / 2;
      const start = boundaryPoint(a, -0.5, -1);
      const end = boundaryPoint(a, 0.5, -1);
      route = {
        item: arrowCubic(start, [a.x - 30, top - 38], [a.x + 30, top - 38], end, style),
        at: t => [a.x + (t - 0.5) * 60, top - 40],
      };
    } else {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bend = !layered && directed && pairs.has(`${e.to}\u0001${e.from}`) ? 16 : bendFor(a, b, nodes);
      const q = [(a.x + b.x) / 2 - (dy / len) * bend * 2, (a.y + b.y) / 2 + (dx / len) * bend * 2];
      const start = boundaryPoint(a, q[0] - a.x, q[1] - a.y);
      const end = boundaryPoint(b, q[0] - b.x, q[1] - b.y);
      route = {
        item: bend ? arrowQuad(start, q, end, style) : arrowLine(start, end, style),
        at: t => quadAt(start, q, end, t),
      };
    }
    if (e.label && !placeLabel(e.label, route.at, state)) {
      route = outside();
      placeLabel(e.label, route.at, state); // Its midpoint is above every occupied box.
    }
    edgeItems.push(route.item);
  }

  const nodeItems = [];
  for (const n of nodes) {
    const state = stateOfNode(n.id);
    nodeItems.push(shape(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, state, n.h / 2));
    nodeItems.push(text(n.x, n.y, n.label, {
      fill: LOOK[state].text, weight: state === 'plain' || state === 'dim' ? 400 : 600,
    }));

  }
  return finish([...edgeItems, ...labelItems, ...nodeItems, ...noteItems]);
}

/* -------------------------------- array ---------------------------------- */

export function layoutArray(spec) {
  const top = marksOf(spec);
  const synthetic = !(Array.isArray(spec.rows) && spec.rows.length);
  const rows = synthetic ? [{ name: '', values: spec.values || [] }] : spec.rows;
  const count = rows.reduce((m, r) => Math.max(m, r.values.length), 0);
  if (!count && rows.length === 1) return finish(emptyMark(0, 0, 88, 34, 'empty'));

  const cw = Math.max(34, Math.ceil(rows.reduce((m, r) => Math.max(m, maxTextW(r.values, 13)), 0) + 14));
  const ch = 34;
  const nameW = rows.some(r => r.name) ? Math.ceil(maxTextW(rows.map(r => r.name), 12)) + 12 : 0;
  const cx = i => nameW + i * cw + cw / 2;

  // Highlighted cells are drawn after plain ones, so their stroke is not half
  // covered by a plain neighbour's.
  const under = [];
  const over = [];
  let y = 0;
  let firstTop = null;
  let lastBottom = 0;

  rows.forEach((row, r) => {
    // Highlights at the top level apply to every row; top-level labels are written
    // once, over the first row, rather than repeated over each.
    const marks = synthetic ? top : mergeMarks(top, marksOf(row), r === 0);
    const isLast = r === rows.length - 1;
    if ([...marks.labels.keys()].some(k => Number(k) < row.values.length)) y += 17;
    const rowTop = y;
    firstTop ??= rowTop;
    if (row.name) over.push(text(nameW - 10, rowTop + ch / 2, row.name, { anchor: 'end', fill: MUTED }));

    if (!row.values.length) over.push(...emptyMark(nameW, rowTop, Math.max(cw * 2, 70), ch));
    row.values.forEach((v, i) => {
      const state = stateOf(marks, String(i));
      (state === 'plain' ? under : over).push(shape(nameW + i * cw, rowTop, cw, ch, state, 0));
      over.push(text(cx(i), rowTop + ch / 2, v, { size: 13, fill: LOOK[state].text }));
      if (marks.labels.has(String(i))) over.push(...note(cx(i), rowTop - 9, marks.labels.get(String(i)), state));
    });
    y = rowTop + ch;
    lastBottom = y;

    if (isLast && spec.showIndex !== false) {
      for (let i = 0; i < count; i++) over.push(text(cx(i), y + 9, String(i), { size: 10, fill: '#8A8A8A' }));
      y += 17;
    }
    const pointers = [...(row.pointers || []), ...(isLast ? spec.pointers || [] : [])];
    const block = pointerBlock(pointers, isLast ? count : row.values.length, cx, y, cw);
    over.push(...block.items);
    y += block.height + (isLast ? 0 : 10);
  });

  if (spec.window && count) {
    const lo = Math.min(spec.window[0], count - 1);
    const hi = Math.min(spec.window[1], count - 1);
    over.push(rect(nameW + lo * cw - 4, firstTop - 4, (hi - lo + 1) * cw + 8, lastBottom - firstTop + 8, {
      rx: 7, fill: 'none', stroke: LOOK.active.stroke, sw: 2,
    }));
  }
  return finish([...under, ...over]);
}

/* --------------------------------- grid ---------------------------------- */

export function layoutGrid(spec) {
  const cells = spec.cells || [];
  const R = cells.length;
  const C = cells.reduce((m, row) => Math.max(m, row.length), 0);
  if (!R || !C) return finish(emptyMark(0, 0, 88, 34, 'empty grid'));
  const marks = marksOf(spec);

  const values = cells.flat().filter(v => v !== null);
  // A cell with a note gets a taller box: the note on top, the value under it,
  // rather than a corner note printed over a two-digit value.
  const notes = [...marks.labels.values()];
  const cw = Math.max(30, Math.ceil(maxTextW(values, 12) + 12), Math.ceil(maxTextW(notes, 9) + 8));
  const ch = notes.length ? 40 : 30;
  const valueDy = notes.length ? 5 : 0;
  const rowLabels = spec.rowLabels || [];
  const colLabels = spec.colLabels || [];
  const left = rowLabels.length ? Math.ceil(maxTextW(rowLabels.slice(0, R), 11)) + 10 : 0;
  const head = colLabels.length ? 18 : 0;
  const centre = (r, c) => [left + c * cw + cw / 2, head + r * ch + ch / 2];
  const inGrid = ([r, c]) => r < R && c < C;

  const under = [];
  const over = [];
  const words = [];
  for (let c = 0; c < Math.min(C, colLabels.length); c++) {
    words.push(text(left + c * cw + cw / 2, 7, colLabels[c], { size: 11, fill: MUTED }));
  }
  for (let r = 0; r < R; r++) {
    if (r < rowLabels.length) {
      words.push(text(left - 8, head + r * ch + ch / 2, rowLabels[r], { size: 11, fill: MUTED, anchor: 'end' }));
    }
    for (let c = 0; c < C; c++) {
      const key = `${r},${c}`;
      const v = c < cells[r].length ? cells[r][c] : null;
      const state = stateOf(marks, key);
      (state === 'plain' ? under : over).push(shape(left + c * cw, head + r * ch, cw, ch, state, 0));
      const [x, y] = centre(r, c);
      if (v !== null && v !== '') words.push(text(x, y + valueDy, v, { fill: LOOK[state].text, backing: LOOK[state].fill }));
      if (marks.labels.has(key)) {
        words.push(text(x, head + r * ch + 9, marks.labels.get(key), { size: 9, fill: LOOK[state].note, weight: 600, backing: LOOK[state].fill }));
      }
    }
  }

  const lines = [];
  const walk = (spec.path || []).filter(inGrid).map(([r, c]) => centre(r, c));
  if (walk.length) {
    if (walk.length > 1) {
      lines.push(path(`M${walk.map(P).join(' L')}`, walk, {
        stroke: LOOK.active.stroke, sw: 10, opacity: 0.2, cap: 'round', join: 'round',
      }));
    }
    lines.push({ kind: 'circle', cx: walk[0][0], cy: walk[0][1], r: 5, fill: LOOK.active.stroke, opacity: 0.2 });
  }
  for (const [from, to] of spec.arrows || []) {
    if (!inGrid(from) || !inGrid(to)) continue;          // out of range: ignored, like a highlight
    const a = centre(...from);
    const b = centre(...to);
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (!len) continue;
    const ux = dx / len;
    const uy = dy / len;
    // Distance to the rectangular cell boundary along this ray, plus 3px.
    const inset = Math.min(ux ? cw / (2 * Math.abs(ux)) : Infinity,
      uy ? ch / (2 * Math.abs(uy)) : Infinity) + 3;
    const s = [a[0] + ux * inset, a[1] + uy * inset];
    const t = [b[0] - ux * inset, b[1] - uy * inset];
    const style = { stroke: MUTED, sw: 1.3, arrow: 'muted' };
    if (len <= 2 * inset) {
      // Neighbours share a border, so the shortened endpoints overlap. Offset
      // the ports along that border and use an S curve with forward tangents;
      // a straight segment here would point backwards and hide the arrowhead.
      const offset = Math.min(cw, ch) * 0.28;
      s[0] += uy * offset; s[1] -= ux * offset;
      t[0] -= uy * offset; t[1] += ux * offset;
      const c1 = [s[0] + ux * 10, s[1] + uy * 10];
      const c2 = [t[0] - ux * 10, t[1] - uy * 10];
      const line = arrowCubic(s, c1, c2, t, style);
      line.pts = [s, c1, c2, t];
      lines.push(line);
    } else {
      lines.push(arrowLine(s, t, style));
    }
  }
  return finish([...under, ...over, ...lines, ...words]);
}

/* --------------------------------- tree ---------------------------------- */

/** LeetCode level order: children of a null are not listed. */
export function buildTree(level) {
  if (!Array.isArray(level) || !level.length || level[0] === null) return null;
  const root = { val: level[0], left: null, right: null, depth: 0 };
  const queue = [root];
  let i = 1;
  while (queue.length && i < level.length) {
    const node = queue.shift();
    for (const side of ['left', 'right']) {
      if (i >= level.length) break;
      const v = level[i++];
      if (v === null) continue;
      node[side] = { val: v, left: null, right: null, depth: node.depth + 1 };
      queue.push(node[side]);
    }
  }
  return root;
}

export function layoutTree(spec) {
  const root = buildTree(spec.level || []);
  if (!root) return finish(emptyMark(0, 0, 100, 34, 'empty tree'));
  const marks = marksOf(spec);

  // In-order position gives x, depth gives y: the classic tidy layout, in which
  // no subtree can overlap its neighbour.
  const order = [];
  const stack = [];
  let node = root;
  while (node || stack.length) {
    while (node) { stack.push(node); node = node.left; }
    node = stack.pop();
    order.push(node);
    node = node.right;
  }
  for (const n of order) { n.h = 32; n.w = Math.max(32, Math.ceil(textW(n.val, 12) + 16)); }
  const step = Math.max(40, order.reduce((m, n) => Math.max(m, n.w), 0) + 10);
  order.forEach((n, i) => { n.x = i * step; n.y = n.depth * 60; });

  const edges = [];
  const shapes = [];
  const notes = [];
  for (const n of order) {
    for (const child of [n.left, n.right]) {
      if (!child) continue;
      const dim = marks.dim.has(child.val);
      edges.push(arrowLine(
        boundaryPoint(n, child.x - n.x, child.y - n.y),
        boundaryPoint(child, n.x - child.x, n.y - child.y),
        { stroke: dim ? LOOK.dim.stroke : EDGE, sw: 1.3 },
      ));
    }
    const state = stateOf(marks, n.val);
    shapes.push(shape(n.x - n.w / 2, n.y - n.h / 2, n.w, n.h, state, n.h / 2));
    shapes.push(text(n.x, n.y, n.val, { fill: LOOK[state].text, weight: state === 'plain' || state === 'dim' ? 400 : 600 }));
    if (marks.labels.has(n.val)) {
      notes.push(...note(n.x + n.w / 2 + 2, n.y - n.h / 2 - 3, marks.labels.get(n.val), state, 'start'));
    }
  }
  return finish([...edges, ...shapes, ...notes]);
}

/* --------------------------------- list ---------------------------------- */

export function layoutList(spec) {
  const values = spec.values || [];
  const marks = marksOf(spec);
  const n = values.length;
  if (!n) return finish(emptyMark(0, 0, 88, 34, 'empty list'));

  const bw = Math.max(40, Math.ceil(maxTextW(values, 13) + 18));
  const bh = 34;
  const gap = 34;
  const x = i => i * (bw + gap);
  const cycle = Number.isInteger(spec.cycleTo) && spec.cycleTo < n ? spec.cycleTo : null;
  const hasNotes = values.some((_, i) => marks.labels.has(String(i)));
  const top = (cycle !== null ? 34 : 0) + (hasNotes ? 17 : 0);
  const cy = top + bh / 2;

  const items = [];
  for (let i = 0; i + 1 < n; i++) {
    items.push(arrowLine([x(i) + bw, cy], [x(i + 1), cy], { stroke: INK, sw: 1.2, arrow: 'ink' }));
  }
  if (cycle === null && spec.showNull !== false) {
    const end = x(n - 1) + bw;
    items.push(arrowLine([end, cy], [end + gap - 8, cy], { stroke: INK, sw: 1.2, arrow: 'ink' }));
    items.push(text(end + gap, cy, '∅', { size: 14, fill: MUTED }));
  }
  if (cycle !== null) {
    // The tail's next pointer, drawn as an arc over the top back to its target.
    // Feet off-centre (tail on its left, target on its right), so a note centred
    // over either box is not crossed by the arc.
    const tail = x(n - 1) + bw * (cycle === n - 1 ? 0.5 : 0.25);
    const target = x(cycle) + bw * 0.75;
    const lift = top - 40;
    const look = { stroke: MUTED, sw: 1.3, arrow: 'muted' };
    if (cycle === n - 1) items.push(arrowCubic([tail + 8, top], [tail + 34, lift], [tail - 34, lift], [tail - 8, top], look));
    else items.push(arrowCubic([tail, top], [tail, lift], [target, lift], [target, top], look));
  }
  values.forEach((v, i) => {
    const state = stateOf(marks, String(i));
    items.push(shape(x(i), top, bw, bh, state, 5));
    items.push(text(x(i) + bw / 2, cy, v, { size: 13, fill: LOOK[state].text }));
    if (marks.labels.has(String(i))) {
      const words = marks.labels.get(String(i));
      if (cycle !== null && cycle !== n - 1 && i === cycle) items.push(...note(x(i) + bw * 0.75 - 7, top - 9, words, state, 'end'));
      else if (cycle !== null && cycle !== n - 1 && i === n - 1) items.push(...note(x(i) + bw * 0.25 + 7, top - 9, words, state, 'start'));
      else items.push(...note(x(i) + bw / 2, top - 9, words, state));
    }
  });
  items.push(...pointerBlock(spec.pointers, n, i => x(i) + bw / 2, top + bh, bw + gap).items);
  return finish(items);
}

/* ------------------------------ stack, queue ----------------------------- */

export function layoutStack(spec) {
  const values = spec.items || [];
  const marks = marksOf(spec);
  const n = values.length;
  const w = Math.max(64, Math.ceil(maxTextW(values, 13) + 24));
  const h = 30;
  const items = [];
  let top = 0;
  if (spec.label) { items.push(text(0, 6, spec.label, { size: 11, fill: MUTED, anchor: 'start' })); top = 22; }
  const lip = top + 8;                                   // the open mouth above the top item
  const bottom = lip + Math.max(n, 1) * h + 4;
  const cy = i => bottom - 2 - (i + 1) * h + h / 2;
  items.push(path(`M${P([0, lip])} L${P([0, bottom])} L${P([w + 8, bottom])} L${P([w + 8, lip])}`,
    [[0, lip], [w + 8, bottom]], { stroke: INK, sw: 1.4, join: 'round' }));
  if (!n) items.push(text((w + 8) / 2, lip + h / 2 + 2, 'empty', { size: 11, fill: '#9E9E9E' }));
  values.forEach((v, i) => {
    const state = stateOf(marks, String(i));
    items.push(shape(4, cy(i) - h / 2 + 1, w, h - 2, state, 4));
    items.push(text(4 + w / 2, cy(i), v, { size: 13, fill: LOOK[state].text }));
    if (marks.labels.has(String(i))) items.push(...note(-8, cy(i), marks.labels.get(String(i)), state, 'end'));
  });
  if (n) {
    const y = cy(n - 1);
    items.push(arrowLine([w + 36, y], [w + 13, y], { stroke: INK, sw: 1.2, arrow: 'ptr' }));
    items.push(text(w + 40, y, 'top', { size: 11, weight: 600, anchor: 'start' }));
  }
  return finish(items);
}

export function layoutQueue(spec) {
  const values = spec.items || [];
  const marks = marksOf(spec);
  const n = values.length;
  const w = Math.max(40, Math.ceil(maxTextW(values, 13) + 16));
  const h = 32;
  const items = [];
  let top = 0;
  if (spec.label) { items.push(text(-8, 6, spec.label, { size: 11, fill: MUTED, anchor: 'start' })); top = 22; }
  if (values.some((_, i) => marks.labels.has(String(i)))) top += 17;

  // A tube open at both ends: things leave at the front and join at the back.
  const length = n ? n * w : 96;
  const tubeTop = top;
  const tubeBottom = top + h + 8;
  items.push(arrowLine([-8, tubeTop], [length + 8, tubeTop], { stroke: INK, sw: 1.4 }));
  items.push(arrowLine([-8, tubeBottom], [length + 8, tubeBottom], { stroke: INK, sw: 1.4 }));
  if (!n) items.push(text(length / 2, (tubeTop + tubeBottom) / 2, 'empty', { size: 11, fill: '#9E9E9E' }));
  values.forEach((v, i) => {
    const state = stateOf(marks, String(i));
    items.push(shape(i * w + 2, tubeTop + 4, w - 4, h, state, 4));
    items.push(text(i * w + w / 2, tubeTop + 4 + h / 2, v, { size: 13, fill: LOOK[state].text }));
    if (marks.labels.has(String(i))) items.push(...note(i * w + w / 2, tubeTop - 9, marks.labels.get(String(i)), state));
  });
  if (n) {
    const y = tubeBottom + 10;
    if (n === 1) items.push(text(w / 2, y, 'front · back', { size: 10.5, fill: MUTED }));
    else {
      items.push(text(w / 2, y, 'front', { size: 10.5, fill: MUTED }));
      items.push(text((n - 1) * w + w / 2, y, 'back', { size: 10.5, fill: MUTED }));
    }
  }
  return finish(items);
}

const LAYOUTS = {
  graph: layoutGraph, array: layoutArray, grid: layoutGrid, tree: layoutTree,
  list: layoutList, stack: layoutStack, queue: layoutQueue,
};

/** Lay out one non-panels spec. */
export function layoutSpec(spec) {
  const fn = LAYOUTS[spec.type];
  if (!fn) throw new Error(`no layout for ${spec.type}`);
  return fn(spec);
}

/* ------------------------------ frames, panels ---------------------------- */

const MARGIN = 12;
const PANEL_GAP = 36;
const PANEL_TITLE_H = 22;
const SIDE_BY_SIDE_MAX = 720;

/**
 * Lay out every frame of an illustration at once, sized to the largest of them,
 * so stepping through never makes the drawing jump or the coach column reflow.
 * A stack is pinned to the bottom of its slot, the way a stack grows.
 *
 * Panels sit side by side when they fit in SIDE_BY_SIDE_MAX, otherwise stacked;
 * `arrange` forces one or the other (drawViz uses it to restack in a narrow column).
 *
 * @param {Array<object>} specs resolved frames (or just the one spec)
 * @param {{arrange?:'auto'|'side'|'stack'}} [options]
 * @returns {Array<{width:number, height:number, items:Array, side?:boolean}>}
 */
export function layoutFrames(specs, { arrange = 'auto' } = {}) {
  const type = specs[0].type;
  const range = n => Array.from({ length: n }, (_, k) => k);
  if (type !== 'panels') {
    const boxes = specs.map(layoutSpec);
    const W = Math.max(...boxes.map(b => b.width));
    const H = Math.max(...boxes.map(b => b.height));
    return boxes.map(b => ({
      width: W + MARGIN * 2,
      height: H + MARGIN * 2,
      items: [group(MARGIN, MARGIN + (type === 'stack' ? H - b.height : 0), b.items)],
    }));
  }

  const count = specs[0].panels.length;
  const boxes = specs.map(s => s.panels.map(layoutSpec));
  const titles = specs.map(s => s.panels.map(p => (p.title ? p.title.toUpperCase() : '')));
  const titleH = titles.some(row => row.some(Boolean)) ? PANEL_TITLE_H : 0;
  const titleW = s => textW(s, 10) * 1.1;                // letter-spacing widens it
  const slotW = range(count).map(k => Math.max(...boxes.map(f => f[k].width), ...titles.map(f => titleW(f[k]))));
  const slotH = range(count).map(k => Math.max(...boxes.map(f => f[k].height)));
  const side = arrange === 'auto'
    ? slotW.reduce((s, w) => s + w, 0) + PANEL_GAP * (count - 1) <= SIDE_BY_SIDE_MAX
    : arrange === 'side';

  const at = [];
  let cursor = 0;
  for (const k of range(count)) {
    at.push(side ? [cursor, 0] : [0, cursor]);
    cursor += (side ? slotW[k] : titleH + slotH[k]) + PANEL_GAP;
  }
  const W = side ? cursor - PANEL_GAP : Math.max(...slotW);
  const H = side ? titleH + Math.max(...slotH) : cursor - PANEL_GAP;

  return specs.map((s, f) => {
    const items = [];
    for (const k of range(count)) {
      const [x, y] = at[k];
      if (titles[f][k]) {
        items.push(text(x, y + 7, titles[f][k], {
          size: 10, fill: MUTED, anchor: 'start', weight: 600, spread: 1.1, ls: '.08em',
        }));
      }
      const box = boxes[f][k];
      const sink = s.panels[k].type === 'stack' ? slotH[k] - box.height : 0;
      items.push(group(x, y + titleH + sink, box.items));
    }
    return { width: W + MARGIN * 2, height: H + MARGIN * 2, items: [group(MARGIN, MARGIN, items)], side };
  });
}

/* ==========================================================================
   5. The painter — layout objects to SVG nodes. Every number is ours.
   ========================================================================== */

function svg(tag, attrs = {}, content = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  if (content !== null) node.textContent = String(content);   // text, never markup
  return node;
}

function paint(items, parent, markerId) {
  for (const it of items) {
    if (it.kind === 'g') {
      const g = svg('g', { transform: `translate(${r1(it.dx)},${r1(it.dy)})` });
      paint(it.items, g, markerId);
      parent.append(g);
    } else if (it.kind === 'rect') {
      parent.append(svg('rect', {
        x: r1(it.x), y: r1(it.y), width: r1(it.w), height: r1(it.h), rx: it.rx ? r1(it.rx) : null,
        fill: it.fill || 'none', stroke: it.stroke || 'none', 'stroke-width': it.sw ?? 1,
        'stroke-dasharray': it.dash || null,
      }));
    } else if (it.kind === 'circle') {
      parent.append(svg('circle', { cx: r1(it.cx), cy: r1(it.cy), r: it.r, fill: it.fill, opacity: it.opacity ?? null }));
    } else if (it.kind === 'path') {
      parent.append(svg('path', {
        d: it.d, fill: 'none', stroke: it.stroke || INK, 'stroke-width': it.sw ?? 1,
        opacity: it.opacity ?? null, 'stroke-linecap': it.cap || null, 'stroke-linejoin': it.join || null,
        'marker-end': it.arrow ? `url(#${markerId(it.arrow)})` : null,
      }));
    } else if (it.kind === 'text') {
      parent.append(svg('text', {
        x: r1(it.x), y: r1(it.y), 'text-anchor': it.anchor, 'dominant-baseline': 'central',
        'font-size': it.size, 'font-weight': it.weight ?? null, fill: it.fill, 'letter-spacing': it.ls || null,
        // Grid values remain readable even when a long dependency passes a cell.
        stroke: it.backing || null, 'stroke-width': it.backing ? 3 : null,
        'stroke-linejoin': it.backing ? 'round' : null, 'paint-order': it.backing ? 'stroke fill' : null,
      }, it.text));
    }
  }
}

/** One frame's drawing as a standalone <svg>. Marker ids are unique per idPrefix. */
export function paintScene(scene, { idPrefix = 'viz', title = '' } = {}) {
  const root = svg('svg', {
    viewBox: `0 0 ${scene.width} ${scene.height}`,
    // An intrinsic size, so CSS can shrink the drawing to fit a narrow column
    // without ever blowing it up to fill a wide one.
    width: scene.width,
    height: scene.height,
    role: 'img',
    'font-family': FONT,
    class: 'viz-svg',
  });
  root.append(svg('title', {}, title || 'Illustration'));
  const used = new Map();
  const markerId = name => {
    const id = `${idPrefix}-arrow-${name}`;
    used.set(name, id);
    return id;
  };
  const body = svg('g');
  paint(scene.items, body, markerId);

  if (used.size) {
    const defs = svg('defs');
    for (const [name, id] of used) {
      const m = MARKERS[name] || MARKERS.edge;
      // userSpaceOnUse: the head stays the same size on a 1px and a 2.6px line.
      // refX sits TRIM short of the tip because the line was shortened by TRIM.
      const marker = svg('marker', {
        id, viewBox: `0 0 ${m.L} ${m.W}`, markerWidth: m.L, markerHeight: m.W,
        refX: m.L - TRIM, refY: m.W / 2, orient: 'auto', markerUnits: 'userSpaceOnUse',
      });
      marker.append(svg('path', { d: `M0,0 L${m.L},${m.W / 2} L0,${m.W} z`, fill: m.color }));
      defs.append(marker);
    }
    root.append(defs);
  }
  root.append(body);
  return root;
}

/* ==========================================================================
   6. The public renderer and the stepper
   ========================================================================== */

let vizSeq = 0;
const PLAY_MS = 1600;

/**
 * Draw a spec from parseViz. With frames, a stepper sits under the drawing and
 * it starts on the first frame (never the bare base).
 *
 * @param {object} spec
 * @param {{idPrefix?:string}} [options]
 * @returns {HTMLElement} div.viz
 */
export function drawViz(spec, { idPrefix } = {}) {
  const prefix = String(idPrefix || '').replace(/[^A-Za-z0-9_-]/g, '') || `viz${++vizSeq}`;
  const hasFrames = Array.isArray(spec.frames) && spec.frames.length > 0;
  const frames = hasFrames ? spec.frames.map((_, i) => resolveFrame(spec, i)) : [resolveFrame(spec, 0)];
  let scenes = layoutFrames(frames);
  const title = spec.title || `${spec.type} illustration`;
  const draw = i => paintScene(scenes[i], { idPrefix: prefix, title });

  const canvas = el('div', { class: 'ill-canvas viz-canvas' }, draw(0));
  const root = el('div', { class: 'viz', dataset: { type: spec.type } }, canvas);
  let index = 0;

  // Side-by-side panels in the narrow coach column would be scaled down until the
  // text is unreadable, so when the canvas cannot show them at near full size they
  // restack — and go back side by side when the column widens again.
  if (spec.type === 'panels' && frames[0].panels.length > 1 && typeof ResizeObserver === 'function') {
    const autoSide = scenes[0].side;
    const side = layoutFrames(frames, { arrange: 'side' });
    const stacked = layoutFrames(frames, { arrange: 'stack' });
    const observer = new ResizeObserver(() => {
      if (!root.isConnected) { observer.disconnect(); return; }
      const room = canvas.clientWidth - 24;               // .ill-canvas padding
      if (room <= 0) return;
      const want = autoSide && side[0].width * 0.8 <= room ? side : stacked;
      if (want !== scenes && want[0].side !== scenes[0].side) {
        scenes = want;
        replace(canvas, draw(index));
      }
    });
    observer.observe(canvas);
  }
  if (!hasFrames) return root;

  const total = frames.length;
  let timer = null;

  const prev = el('button', { type: 'button', class: 'viz-btn viz-prev', 'aria-label': 'Previous step', text: '‹' });
  const play = el('button', { type: 'button', class: 'viz-btn viz-play', 'aria-label': 'Play steps', 'aria-pressed': 'false' });
  const next = el('button', { type: 'button', class: 'viz-btn viz-next', 'aria-label': 'Next step', text: '›' });
  const counter = el('span', { class: 'viz-count', 'aria-live': 'polite' });
  const noteLine = el('div', { class: 'viz-note' });
  const bar = el('div', {
    class: 'viz-stepper', tabindex: '0', role: 'group',
    'aria-label': 'Illustration steps. Left and right arrow keys step through.',
  }, [el('div', { class: 'viz-controls' }, [prev, play, next, counter]), noteLine]);

  const sync = () => {
    counter.textContent = `Step ${index + 1} of ${total}`;
    const words = frames[index].note || '';
    noteLine.textContent = words;                          // the model's words, as text only
    noteLine.hidden = !words;
    // A focused button that becomes disabled drops focus to <body>; hand it to the
    // stepper instead, so the arrow keys keep working.
    const focused = document.activeElement;
    prev.disabled = index === 0;
    next.disabled = index === total - 1;
    if ((focused === prev && prev.disabled) || (focused === next && next.disabled)) bar.focus();
    play.textContent = timer ? '❚❚ Pause' : '▶ Play';
    play.setAttribute('aria-label', timer ? 'Pause' : 'Play steps');
    play.setAttribute('aria-pressed', timer ? 'true' : 'false');
    play.disabled = total < 2;
    root.dataset.frame = String(index);
  };
  const show = i => {
    const at = Math.max(0, Math.min(total - 1, i));
    if (at !== index) {
      index = at;
      replace(canvas, draw(index));      // one mutation: no blank frame between steps
    }
    sync();
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; sync(); };
  const tick = () => {
    // Detached (the coach re-rendered, the learner navigated away): stop quietly.
    if (!root.isConnected || index >= total - 1) { stop(); return; }
    show(index + 1);
    if (index >= total - 1) stop();
  };
  const start = () => {
    if (index >= total - 1) show(0);
    timer = setInterval(tick, PLAY_MS);
    sync();
  };

  prev.addEventListener('click', () => { stop(); show(index - 1); });
  next.addEventListener('click', () => { stop(); show(index + 1); });
  play.addEventListener('click', () => (timer ? stop() : start()));
  bar.addEventListener('keydown', event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;   // ⌘← belongs to the app
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    event.stopPropagation();                   // the app's own arrow-key map must not act too
    stop();
    show(index + (event.key === 'ArrowLeft' ? -1 : 1));
  });

  root.append(bar);
  sync();
  return root;
}
