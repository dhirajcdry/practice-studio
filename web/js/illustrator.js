// The illustrator — fenced ```mermaid and ```svg blocks from the coach, rendered
// inline (ARCHITECTURE.md §8).
//
// This is MODEL OUTPUT DRAWN INTO OUR PAGE, so nothing here trusts its input.
//
//   ```svg      → allowlist-sanitised and rebuilt in the SVG namespace, exactly the
//                 strategy sanitize.js uses for LeetCode's HTML: parse inert, copy
//                 only known-safe tags and attributes, nothing by default.
//   ```mermaid  → parsed by the small flowchart reader below and drawn as an SVG we
//                 build ourselves from numbers. There is no mermaid library offline
//                 and adding a CDN is not on the table, so the supported subset is
//                 deliberately narrow and everything outside it falls back to a
//                 labelled code block rather than to a wrong picture.
//
// The fallback is the rule, not the exception: a diagram that cannot be drawn
// honestly is shown as its source. Never a blank pane, never a silent failure.

import { el } from './dom.js';
import { codeBlock } from './markdown.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ==========================================================================
   1. Splitting a coach message into prose and diagrams
   ========================================================================== */

const FENCE_OPEN = /^(\s*)(`{3,}|~{3,})\s*([A-Za-z0-9+#_-]*)\s*$/;

/**
 * Split markdown into an ordered list of segments so prose and diagrams can be
 * interleaved in the order the coach wrote them.
 *
 *   { type:'markdown', text }
 *   { type:'diagram', lang:'mermaid'|'svg', code, complete }
 *
 * `complete:false` means the closing fence has not streamed in yet — the caller
 * shows it as a pending block rather than trying to draw half a diagram.
 * Fences in any other language stay inside the markdown segment, where
 * renderMarkdown already handles them.
 *
 * @param {string} source
 * @returns {Array<object>}
 */
export function splitDiagramBlocks(source) {
  const segments = [];
  if (typeof source !== 'string' || source === '') return segments;

  const lines = source.split('\n');
  let prose = [];
  const flushProse = () => {
    if (!prose.length) return;
    const text = prose.join('\n');
    if (text.trim() !== '') segments.push({ type: 'markdown', text });
    prose = [];
  };

  let i = 0;
  while (i < lines.length) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) { prose.push(lines[i]); i++; continue; }

    const marker = open[2][0];
    const closeRe = new RegExp(`^\\s*${marker === '`' ? '`{3,}' : '~{3,}'}\\s*$`);
    const lang = open[3].toLowerCase();
    const isDiagram = lang === 'mermaid' || lang === 'svg';

    const body = [];
    let j = i + 1;
    let closed = false;
    while (j < lines.length) {
      if (closeRe.test(lines[j])) { closed = true; break; }
      body.push(lines[j]);
      j++;
    }

    if (isDiagram) {
      flushProse();
      segments.push({ type: 'diagram', lang, code: body.join('\n'), complete: closed });
    } else {
      // Someone else's fence: hand it back verbatim, closing fence included.
      prose.push(lines[i], ...body);
      if (closed) prose.push(lines[j]);
    }
    i = closed ? j + 1 : j;
  }

  flushProse();
  return segments;
}

/* ==========================================================================
   2. The SVG sanitizer
   ========================================================================== */

/** Elements dropped with their whole subtree — they carry behaviour or fetch bytes. */
const SVG_FORBIDDEN = new Set([
  'script', 'foreignobject', 'image', 'use', 'style', 'a', 'iframe', 'audio', 'video',
  'animate', 'animatemotion', 'animatetransform', 'set', 'handler', 'listener',
  'font-face', 'font-face-uri', 'filter', 'feimage', 'switch', 'symbol', 'pattern',
]);

/** Tags we are willing to draw, in their canonical (case-sensitive) SVG spelling. */
const SVG_ALLOWED = new Map([
  ['svg', 'svg'], ['g', 'g'], ['defs', 'defs'], ['marker', 'marker'],
  ['path', 'path'], ['rect', 'rect'], ['circle', 'circle'], ['ellipse', 'ellipse'],
  ['line', 'line'], ['polyline', 'polyline'], ['polygon', 'polygon'],
  ['text', 'text'], ['tspan', 'tspan'], ['title', 'title'], ['desc', 'desc'],
  ['lineargradient', 'linearGradient'], ['radialgradient', 'radialGradient'],
  ['stop', 'stop'], ['clippath', 'clipPath'],
]);

/** Attributes we are willing to carry over. Nothing is copied by default. */
const SVG_ATTRS = new Set([
  'viewbox', 'preserveaspectratio', 'width', 'height', 'x', 'y', 'dx', 'dy',
  'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'font-family', 'font-size', 'font-style', 'font-weight',
  'letter-spacing', 'text-anchor', 'dominant-baseline', 'alignment-baseline',
  'marker-start', 'marker-mid', 'marker-end', 'markerwidth', 'markerheight',
  'markerunits', 'refx', 'refy', 'orient', 'offset', 'stop-color', 'stop-opacity',
  'gradientunits', 'gradienttransform', 'clip-path', 'clip-rule', 'id', 'style',
  'shape-rendering', 'vector-effect', 'paint-order', 'text-rendering',
]);

/** Canonical spelling for the handful of allowed attributes that are camelCase. */
const ATTR_CASE = {
  viewbox: 'viewBox', preserveaspectratio: 'preserveAspectRatio',
  markerwidth: 'markerWidth', markerheight: 'markerHeight', markerunits: 'markerUnits',
  refx: 'refX', refy: 'refY', gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
};

/** Only a same-document `url(#id)` is a reference we are willing to keep. */
const LOCAL_URL = /^url\(\s*['"]?#[A-Za-z0-9_.:-]+['"]?\s*\)$/;

/**
 * True when a value is safe to hand to the renderer: no remote fetch, no script
 * URL, no reference we cannot see. `url(#local)` survives so arrowhead markers
 * and gradients keep working; every other `url(` is refused.
 */
export function isSafeSvgValue(raw) {
  if (typeof raw !== 'string') return false;
  // Characters a browser ignores when resolving a value are stripped first, so a
  // scheme cannot be smuggled past the tests below by splitting it with a tab.
  const value = raw.replace(/[\u0000-\u0020\u007f]/g, '');
  if (/url\s*\(/i.test(value) && !LOCAL_URL.test(value.trim())) return false;
  if (/(javascript|vbscript|data)\s*:/i.test(value)) return false;
  if (/expression\s*\(|@import|behaviou?r\s*:|-moz-binding/i.test(value)) return false;
  if (/<\s*\/?\s*[a-z]/i.test(value)) return false;
  return true;
}

const MAX_SVG_NODES = 4000;

function copySvg(source, target, budget) {
  for (const child of Array.from(source.childNodes)) {
    if (budget.left <= 0) return;
    if (child.nodeType === Node.TEXT_NODE) {
      target.append(document.createTextNode(child.nodeValue));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;

    const tag = child.tagName.toLowerCase();
    if (SVG_FORBIDDEN.has(tag)) continue;
    const canonical = SVG_ALLOWED.get(tag);
    if (!canonical) continue; // unknown element: drop it and its subtree, silently

    budget.left--;
    const clean = document.createElementNS(SVG_NS, canonical);
    for (const attr of Array.from(child.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) continue;                     // every handler, always
      if (name.includes(':')) continue;                        // xlink:href, xml:*, ns hacks
      if (name === 'href' || name === 'src') continue;         // no external references
      if (!SVG_ATTRS.has(name)) continue;
      if (!isSafeSvgValue(attr.value)) continue;
      clean.setAttribute(ATTR_CASE[name] || name, attr.value);
    }
    copySvg(child, clean, budget);
    target.append(clean);
  }
}

/**
 * Rebuild an untrusted `<svg>` document as nodes that are safe to insert.
 *
 * @param {string} source raw SVG text from the coach
 * @returns {{ok:boolean, node:SVGSVGElement|null, reason:string}}
 */
export function sanitizeSvg(source) {
  const fail = reason => ({ ok: false, node: null, reason });
  if (typeof source !== 'string' || source.trim() === '') return fail('The block was empty.');

  let doc;
  try {
    doc = new DOMParser().parseFromString(source.trim(), 'image/svg+xml');
  } catch {
    return fail('The SVG could not be parsed.');
  }
  if (doc.getElementsByTagName('parsererror').length) {
    return fail('The SVG is not well-formed XML, so it was not drawn.');
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    return fail('The block did not start with an <svg> element.');
  }

  const out = document.createElementNS(SVG_NS, 'svg');
  for (const attr of Array.from(root.attributes)) {
    const name = attr.name.toLowerCase();
    if (name.startsWith('on') || name.includes(':') || !SVG_ATTRS.has(name)) continue;
    if (!isSafeSvgValue(attr.value)) continue;
    out.setAttribute(ATTR_CASE[name] || name, attr.value);
  }

  const budget = { left: MAX_SVG_NODES };
  copySvg(root, out, budget);

  if (!out.childNodes.length) return fail('Nothing in the SVG survived sanitising.');

  // A drawing with no coordinate system cannot be scaled to the panel; borrow one
  // from width/height when the model forgot the viewBox.
  const width = parseFloat(out.getAttribute('width') || '');
  const height = parseFloat(out.getAttribute('height') || '');
  if (!out.getAttribute('viewBox') && width > 0 && height > 0) {
    out.setAttribute('viewBox', `0 0 ${width} ${height}`);
  }
  // Keep an intrinsic width and let CSS cap it at the panel: a viewBox on its own
  // stretches to fill whatever it is put in, which turns a small diagram into a
  // wall of 40px text on a narrow screen. Height follows from the aspect ratio.
  const box = (out.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const intrinsic = width > 0 ? width : (box.length === 4 && box[2] > 0 ? box[2] : 0);
  if (intrinsic > 0) out.setAttribute('width', String(Math.round(intrinsic)));
  else out.removeAttribute('width');
  out.removeAttribute('height');
  out.setAttribute('role', 'img');
  return { ok: true, node: out, reason: '' };
}

/* ==========================================================================
   3. The mermaid subset — flowchart / graph only
   ========================================================================== */

const SHAPES = [
  { open: '((', close: '))', shape: 'circle' },
  { open: '([', close: '])', shape: 'round' },
  { open: '[[', close: ']]', shape: 'rect' },
  { open: '[/', close: '/]', shape: 'rect' },
  { open: '[', close: ']', shape: 'rect' },
  { open: '(', close: ')', shape: 'round' },
  { open: '{', close: '}', shape: 'diamond' },
  { open: '>', close: ']', shape: 'rect' },
];

/** Lines that mean a feature this renderer does not draw. Better a code block. */
const UNSUPPORTED_LINE = /^\s*(subgraph\b|end\b|classDef\b|class\b|style\b|click\b|linkStyle\b|direction\b)/i;

const HEADER = /^\s*(flowchart|graph)\s+(TB|TD|BT|RL|LR)?\s*;?\s*$/i;

// One connector token: arrow forms first, so `-->` never matches as `--` plus a
// stray `>`. Dotted and thick links are recognised and drawn as dashed / plain.
const CONN = String.raw`(?:-\.->|-\.-|-{2,}>|-{2,}|={2,}>|={2,})`;
/** `A -->|label| B` */
const LINK_PIPE = new RegExp(String.raw`^(.+?)\s*(${CONN})\|([^|]*)\|\s*(.+)$`);
/** `A -- label --> B` */
const LINK_INLINE = new RegExp(String.raw`^(.+?)\s+(?:-{2}|={2}|-\.)\s+([^|]+?)\s+(${CONN})\s*(.+)$`);
/** `A --> B` */
const LINK_PLAIN = new RegExp(String.raw`^(.+?)\s*(${CONN})\s*(.+)$`);

/** Pull one edge out of a line, or null when the line is not a connection. */
export function parseLink(line) {
  const pipe = LINK_PIPE.exec(line);
  if (pipe) return { left: pipe[1], right: pipe[4], label: pipe[3].trim(), conn: pipe[2] };
  const inline = LINK_INLINE.exec(line);
  if (inline) return { left: inline[1], right: inline[4], label: inline[2].trim(), conn: inline[3] };
  const plain = LINK_PLAIN.exec(line);
  if (plain) return { left: plain[1], right: plain[3], label: '', conn: plain[2] };
  return null;
}

function parseNodeRef(rawText, nodes, order) {
  const raw = String(rawText).trim().replace(/;$/, '').trim();
  if (raw === '') return null;

  let id = raw;
  let label = null;
  let shape = 'rect';

  for (const candidate of SHAPES) {
    const at = raw.indexOf(candidate.open);
    if (at <= 0 || !raw.endsWith(candidate.close)) continue;
    id = raw.slice(0, at).trim();
    label = raw.slice(at + candidate.open.length, raw.length - candidate.close.length).trim();
    shape = candidate.shape;
    break;
  }
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) return null;

  if (label !== null) label = label.replace(/^["'`]|["'`]$/g, '').replace(/<br\s*\/?>/gi, '\n');

  const existing = nodes.get(id);
  if (existing) {
    if (label !== null) { existing.label = label; existing.shape = shape; }
    return existing;
  }
  const node = { id, label: label === null ? id : label, shape, order: order.n++ };
  nodes.set(id, node);
  return node;
}

/**
 * Read the mermaid subset this file can draw.
 *
 * @param {string} source
 * @returns {{ok:true, direction:string, nodes:Array, edges:Array} | {ok:false, reason:string}}
 */
export function parseMermaid(source) {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, reason: 'The block was empty.' };
  }
  const lines = source.split('\n')
    .map(line => line.replace(/%%.*$/, ''))          // mermaid comments
    .filter(line => line.trim() !== '');

  if (!lines.length) return { ok: false, reason: 'The block was empty.' };

  const header = HEADER.exec(lines[0]);
  if (!header) {
    const first = lines[0].trim().split(/\s+/)[0].replace(/[^A-Za-z]/g, '');
    return {
      ok: false,
      reason: `Only \`flowchart\` and \`graph\` diagrams are drawn here${first ? `, and this one is \`${first}\`` : ''}.`,
    };
  }

  const raw = (header[2] || 'TD').toUpperCase();
  const direction = raw === 'TB' ? 'TD' : raw;

  const nodes = new Map();
  const edges = [];
  const order = { n: 0 };

  for (const line of lines.slice(1)) {
    if (UNSUPPORTED_LINE.test(line)) {
      return { ok: false, reason: `This diagram uses \`${line.trim().split(/\s+/)[0]}\`, which this renderer does not draw.` };
    }
    const trimmed = line.trim().replace(/;$/, '');
    if (trimmed === '') continue;

    const link = parseLink(trimmed);
    if (link) {
      const from = parseNodeRef(link.left, nodes, order);
      const to = parseNodeRef(link.right, nodes, order);
      if (!from || !to) return { ok: false, reason: 'A connection in this diagram could not be read.' };
      edges.push({
        from: from.id,
        to: to.id,
        label: link.label.replace(/^["']|["']$/g, ''),
        dashed: link.conn.includes('.'),
        arrow: link.conn.endsWith('>'),
      });
      continue;
    }

    // A bare node declaration, e.g. `A[Start]`.
    if (!parseNodeRef(trimmed, nodes, order)) {
      return { ok: false, reason: 'A line in this diagram could not be read.' };
    }
  }

  if (!nodes.size) return { ok: false, reason: 'The diagram declared no nodes.' };
  if (nodes.size > 60) return { ok: false, reason: 'This diagram has more nodes than the built-in renderer lays out well.' };

  return { ok: true, direction, nodes: [...nodes.values()], edges };
}

/* ---------------------------- layout (pure maths) --------------------------- */

const CHAR_W = 7.1;        // measured against the mono stack at 12px
const PAD_X = 22;
const LINE_H = 16;
const MIN_W = 62;
const MAX_W = 210;
const GAP_MAIN = 62;       // between layers
const GAP_CROSS = 22;      // within a layer
const MARGIN = 14;

function wrapLabel(label) {
  const hard = String(label).split('\n');
  const out = [];
  for (const piece of hard) {
    const words = piece.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); continue; }
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (next.length * CHAR_W + PAD_X * 2 > MAX_W && line) { out.push(line); line = word; }
      else line = next;
    }
    out.push(line);
  }
  return out.slice(0, 4);
}

/**
 * Edges that close a loop, found by depth-first search. A recursion tree drawn
 * with `D --> A` at the bottom is a cycle, and layering it naively would push
 * every node down forever; the back edge is still drawn, it just does not get a
 * vote on which row anything sits in.
 */
export function findBackEdges(nodes, edges) {
  const out = new Map(nodes.map(n => [n.id, []]));
  for (const [index, edge] of edges.entries()) {
    if (out.has(edge.from) && out.has(edge.to)) out.get(edge.from).push({ index, to: edge.to });
  }
  const back = new Set();
  const state = new Map(nodes.map(n => [n.id, 0]));   // 0 unseen, 1 on stack, 2 done

  for (const start of nodes) {
    if (state.get(start.id) !== 0) continue;
    const stack = [{ id: start.id, next: 0 }];
    state.set(start.id, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const list = out.get(frame.id);
      if (frame.next >= list.length) { state.set(frame.id, 2); stack.pop(); continue; }
      const edge = list[frame.next++];
      const seen = state.get(edge.to);
      if (seen === 1) back.add(edge.index);            // points at an ancestor: a loop
      else if (seen === 0) { state.set(edge.to, 1); stack.push({ id: edge.to, next: 0 }); }
    }
  }
  return back;
}

/** Assign layers, sizes and coordinates. Pure maths, so it is covered by tests. */
export function layoutFlowchart(model) {
  const nodes = model.nodes.map(node => {
    const lines = wrapLabel(node.label);
    const widest = lines.reduce((m, l) => Math.max(m, l.length), 0);
    let w = Math.max(MIN_W, Math.min(MAX_W, Math.round(widest * CHAR_W + PAD_X * 2)));
    let h = Math.max(36, lines.length * LINE_H + 20);
    // A rhombus and an ellipse hold far less text than their bounding box suggests.
    // The box is grown here rather than at draw time, so the label always sits
    // inside the shape instead of poking out of its points.
    if (node.shape === 'diamond') { w = Math.round(w * 1.45); h += 22; }
    if (node.shape === 'circle') { w = Math.round(w * 1.2); h += 10; }
    return { ...node, lines, w, h, layer: 0, x: 0, y: 0 };
  });
  const byId = new Map(nodes.map(n => [n.id, n]));

  // Longest-path layering by relaxation over the acyclic part of the graph. Back
  // edges are excluded, so this always settles; the pass cap is belt and braces.
  const back = findBackEdges(nodes, model.edges);
  const passes = Math.min(nodes.length + 1, 60);
  for (let pass = 0; pass < passes; pass++) {
    let moved = false;
    for (const [index, edge] of model.edges.entries()) {
      if (back.has(index)) continue;
      const from = byId.get(edge.from);
      const to = byId.get(edge.to);
      if (!from || !to || from === to) continue;
      if (to.layer <= from.layer) { to.layer = from.layer + 1; moved = true; }
    }
    if (!moved) break;
  }

  const layers = [];
  for (const node of [...nodes].sort((a, b) => a.order - b.order)) {
    (layers[node.layer] ||= []).push(node);
  }

  const vertical = model.direction === 'TD' || model.direction === 'BT';
  let main = MARGIN;                    // along the flow axis
  let crossExtent = 0;
  const mainSizes = [];

  for (const layer of layers) {
    if (!layer) { mainSizes.push(0); continue; }
    const thickness = layer.reduce((m, n) => Math.max(m, vertical ? n.h : n.w), 0);
    let cross = 0;
    for (const node of layer) cross += (vertical ? node.w : node.h) + GAP_CROSS;
    cross -= GAP_CROSS;
    crossExtent = Math.max(crossExtent, cross);
    mainSizes.push(thickness);
  }

  for (const [index, layer] of layers.entries()) {
    if (!layer) { main += mainSizes[index] + GAP_MAIN; continue; }
    let cross = 0;
    for (const node of layer) cross += (vertical ? node.w : node.h) + GAP_CROSS;
    cross -= GAP_CROSS;
    let at = MARGIN + (crossExtent - cross) / 2;
    for (const node of layer) {
      if (vertical) { node.x = at; node.y = main + (mainSizes[index] - node.h) / 2; at += node.w + GAP_CROSS; }
      else { node.y = at; node.x = main + (mainSizes[index] - node.w) / 2; at += node.h + GAP_CROSS; }
    }
    main += mainSizes[index] + GAP_MAIN;
  }

  const mainExtent = main - GAP_MAIN + MARGIN;
  let width = vertical ? crossExtent + MARGIN * 2 : mainExtent;
  let height = vertical ? mainExtent : crossExtent + MARGIN * 2;

  // A loop is routed around the outside rather than back through the middle of the
  // diagram, so the lane it needs has to exist in the drawing's box.
  const edges = model.edges.map((edge, index) => ({ ...edge, back: back.has(index) }));
  const LOOP_LANE = 58;
  if (edges.some(edge => edge.back)) {
    if (vertical) width += LOOP_LANE; else height += LOOP_LANE;
  }

  // BT and RL are the same layout read backwards.
  if (model.direction === 'BT') for (const n of nodes) n.y = height - n.y - n.h;
  if (model.direction === 'RL') for (const n of nodes) n.x = width - n.x - n.w;

  return {
    nodes, byId, edges,
    width: Math.round(width), height: Math.round(height),
    vertical, direction: model.direction,
  };
}

/* ------------------------------- drawing (SVG) ------------------------------ */

function svg(tag, attrs = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    node.setAttribute(key, String(value));
  }
  if (text !== null) node.textContent = String(text);
  return node;
}

const INK = '#111111';
const HAIR = 'rgba(0,0,0,.28)';

function anchors(node, direction, side) {
  const forward = direction === 'BT' || direction === 'RL' ? -1 : 1;
  const vertical = direction === 'TD' || direction === 'BT';
  if (vertical) {
    const out = side === 'out' ? forward : -forward;
    return { x: node.x + node.w / 2, y: out > 0 ? node.y + node.h : node.y, dx: 0, dy: out };
  }
  const out = side === 'out' ? forward : -forward;
  return { x: out > 0 ? node.x + node.w : node.x, y: node.y + node.h / 2, dx: out, dy: 0 };
}

/** Draw a laid-out flowchart. Every number here is ours, so nothing is untrusted. */
export function drawFlowchart(layout, idPrefix = 'ill') {
  const root = svg('svg', {
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    // An intrinsic size, so CSS can shrink the drawing to fit a narrow panel
    // without ever blowing it up to fill a wide one.
    width: layout.width,
    role: 'img',
    'font-family': 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  });
  const markerId = `${idPrefix}-arrow`;
  const defs = svg('defs');
  const marker = svg('marker', {
    id: markerId, markerWidth: 9, markerHeight: 9, refX: 8, refY: 3,
    orient: 'auto', markerUnits: 'strokeWidth',
  });
  marker.append(svg('path', { d: 'M0,0 L8,3 L0,6 z', fill: HAIR }));
  defs.append(marker);
  root.append(defs);

  const edgeLayer = svg('g');
  const nodeLayer = svg('g');

  for (const edge of layout.edges) {
    const from = layout.byId.get(edge.from);
    const to = layout.byId.get(edge.to);
    if (!from || !to) continue;

    let a, b, c1, c2;

    if (edge.back) {
      // A loop leaves and re-enters on the outside edge and travels down its own
      // lane. Routed through the middle it would cross every node it passes.
      const lane = 44;
      if (layout.vertical) {
        a = { x: from.x + from.w, y: from.y + from.h / 2 };
        b = { x: to.x + to.w, y: to.y + to.h / 2 };
        c1 = { x: Math.max(a.x, b.x) + lane, y: a.y };
        c2 = { x: Math.max(a.x, b.x) + lane, y: b.y };
      } else {
        a = { x: from.x + from.w / 2, y: from.y + from.h };
        b = { x: to.x + to.w / 2, y: to.y + to.h };
        c1 = { x: a.x, y: Math.max(a.y, b.y) + lane };
        c2 = { x: b.x, y: Math.max(a.y, b.y) + lane };
      }
    } else {
      a = anchors(from, layout.direction, 'out');
      b = anchors(to, layout.direction, 'in');
      const span = layout.vertical ? Math.abs(b.y - a.y) : Math.abs(b.x - a.x);
      const reach = Math.min(46, Math.max(18, span * 0.42));
      c1 = { x: a.x + a.dx * reach, y: a.y + a.dy * reach };
      c2 = { x: b.x - b.dx * reach, y: b.y - b.dy * reach };
    }

    edgeLayer.append(svg('path', {
      d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
      fill: 'none', stroke: HAIR, 'stroke-width': 1.2,
      'stroke-dasharray': edge.dashed ? '4 4' : null,
      'marker-end': edge.arrow ? `url(#${markerId})` : null,
    }));

    if (edge.label) {
      // The middle of the curve, not the middle of the straight line between its
      // ends — on a bent edge those are different places, and only one of them
      // has the line under it.
      const mid = t => (a[t] + 3 * c1[t] + 3 * c2[t] + b[t]) / 8;
      const mx = mid('x');
      const my = mid('y');
      const w = edge.label.length * 6.2 + 12;
      edgeLayer.append(svg('rect', {
        x: mx - w / 2, y: my - 9, width: w, height: 18, rx: 3,
        fill: '#FFFFFF', stroke: 'rgba(0,0,0,.10)',
      }));
      edgeLayer.append(svg('text', {
        x: mx, y: my + 4, 'text-anchor': 'middle', 'font-size': 10,
        'letter-spacing': '.06em', fill: 'rgba(0,0,0,.5)',
      }, edge.label));
    }
  }

  for (const node of layout.nodes) {
    const group = svg('g');
    const cx = node.x + node.w / 2;
    const cy = node.y + node.h / 2;

    if (node.shape === 'diamond') {
      group.append(svg('polygon', {
        points: `${cx},${node.y} ${node.x + node.w},${cy} ${cx},${node.y + node.h} ${node.x},${cy}`,
        fill: '#FFFFFF', stroke: 'rgba(0,0,0,.34)', 'stroke-width': 1,
      }));
    } else if (node.shape === 'circle') {
      group.append(svg('ellipse', {
        cx, cy, rx: node.w / 2, ry: node.h / 2,
        fill: '#FFFFFF', stroke: 'rgba(0,0,0,.34)', 'stroke-width': 1,
      }));
    } else {
      group.append(svg('rect', {
        x: node.x, y: node.y, width: node.w, height: node.h,
        rx: node.shape === 'round' ? node.h / 2 : 6,
        fill: '#FFFFFF', stroke: 'rgba(0,0,0,.34)', 'stroke-width': 1,
      }));
    }

    const top = cy - ((node.lines.length - 1) * LINE_H) / 2 + 4;
    for (const [index, line] of node.lines.entries()) {
      group.append(svg('text', {
        x: cx, y: top + index * LINE_H, 'text-anchor': 'middle',
        'font-size': 11.5, fill: INK,
      }, line));
    }
    nodeLayer.append(group);
  }

  root.append(edgeLayer, nodeLayer);
  return root;
}

/* ==========================================================================
   4. The public renderer
   ========================================================================== */

let diagramSeq = 0;

function figure(children, { caption = '', note = '' } = {}) {
  return el('figure', { class: 'ill' }, [
    caption ? el('figcaption', { class: 'mono dim', text: caption }) : null,
    ...[].concat(children),
    note ? el('div', { class: 'ill-note', text: note }) : null,
  ]);
}

/** The honest fallback: the source, labelled, with the reason it was not drawn. */
export function diagramFallback(lang, code, reason) {
  const pre = codeBlock(code, lang === 'svg' ? 'svg' : 'mermaid');
  pre.classList.add('ill-source');
  return figure(pre, {
    caption: lang === 'svg' ? 'SVG — shown as source' : 'Mermaid — shown as source',
    note: reason,
  });
}

/**
 * Render one fenced diagram block.
 *
 * @param {string} lang 'mermaid' | 'svg'
 * @param {string} code the block's contents
 * @param {{complete?:boolean}} [options]
 * @returns {HTMLElement} always an element — the code block when drawing fails
 */
export function renderDiagram(lang, code, options = {}) {
  if (options.complete === false) {
    return figure(el('div', { class: 'ill-pending mono dim', text: 'Drawing…' }), {
      caption: lang === 'svg' ? 'SVG' : 'Mermaid',
    });
  }

  if (lang === 'svg') {
    const result = sanitizeSvg(code);
    if (!result.ok) return diagramFallback('svg', code, result.reason);
    const holder = el('div', { class: 'ill-canvas' });
    holder.append(result.node);
    return figure(holder, { caption: 'Diagram' });
  }

  const model = parseMermaid(code);
  if (!model.ok) return diagramFallback('mermaid', code, model.reason);

  try {
    const drawing = drawFlowchart(layoutFlowchart(model), `ill${++diagramSeq}`);
    const holder = el('div', { class: 'ill-canvas' });
    holder.append(drawing);
    return figure(holder, { caption: 'Diagram' });
  } catch {
    return diagramFallback('mermaid', code, 'The diagram could not be laid out, so here is what the coach wrote.');
  }
}
