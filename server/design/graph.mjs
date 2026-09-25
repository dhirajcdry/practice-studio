// An Excalidraw scene, read as a system design rather than as a picture.
//
// The interviewer never sees the canvas. It sees this:
//
//   Client → API Gateway → Kafka  "writes"
//   Redis                          ← nothing reads or writes it
//
// which is both cheaper and sharper than a screenshot. A model given an image has to
// infer that a line touching two boxes means a dependency; the scene JSON already says
// so, in `startBinding` / `endBinding`. Reading the JSON is not a shortcut around vision,
// it is the more precise source.
//
// Two rules hold this file together.
//
// DERIVED, NEVER AUTHORITATIVE. The scene on disk is the record. Everything here is
// recomputed from it, so a bug in this file costs a re-render and never a drawing.
//
// MEANING, NOT PIXELS. Nudging a box three pixels rewrites a lot of JSON and changes
// nothing about the design. `diffGraphs` is defined on labels and connections alone, so
// only a real change — a component appearing, an arrow drawn, a label edited — can wake
// the interviewer. This is the same judgement as the 120-second audio cut in the attempt
// recorder: a boundary the tool imposed is not a thing the candidate did.

/** Shapes that stand for a component. Everything else is annotation or connection. */
const NODE_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'frame']);
const EDGE_TYPES = new Set(['arrow']);

/** How far an unbound arrow endpoint may sit from a shape and still count as touching it.
 *  Excalidraw only writes a binding when the arrow is drawn onto the shape; drawn merely
 *  *at* it leaves `startBinding: null`, and a dependency the candidate clearly intended
 *  would vanish. Generous enough to catch intent, tight enough not to invent one. */
const SNAP_PX = 24;

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/** Two labels are the same component if they differ only in case or spacing. */
export function labelKey(label) {
  return clean(label).toLowerCase();
}

function live(elements) {
  return (Array.isArray(elements) ? elements : []).filter(
    (e) => e && typeof e === 'object' && e.isDeleted !== true && typeof e.id === 'string',
  );
}

/** The text Excalidraw bound *inside* a shape or onto an arrow. */
function boundLabel(element, textByContainer) {
  const own = clean(element.label?.text);
  if (own) return own;
  return clean(textByContainer.get(element.id));
}

function box(e) {
  const w = Number(e.width) || 0;
  const h = Number(e.height) || 0;
  const x = Number(e.x) || 0;
  const y = Number(e.y) || 0;
  // Excalidraw allows negative width/height for shapes dragged up or left.
  return {
    x1: Math.min(x, x + w), y1: Math.min(y, y + h),
    x2: Math.max(x, x + w), y2: Math.max(y, y + h),
  };
}

/** Absolute endpoints of an arrow. `points` are relative to the element's own x/y. */
function endpoints(arrow) {
  const pts = Array.isArray(arrow.points) && arrow.points.length >= 2 ? arrow.points : null;
  const x = Number(arrow.x) || 0;
  const y = Number(arrow.y) || 0;
  if (!pts) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!Array.isArray(first) || !Array.isArray(last)) return null;
  return {
    from: { x: x + (Number(first[0]) || 0), y: y + (Number(first[1]) || 0) },
    to: { x: x + (Number(last[0]) || 0), y: y + (Number(last[1]) || 0) },
  };
}

function distanceToBox(point, b) {
  const dx = Math.max(b.x1 - point.x, 0, point.x - b.x2);
  const dy = Math.max(b.y1 - point.y, 0, point.y - b.y2);
  return Math.hypot(dx, dy);
}

/** The shape an unbound arrow endpoint is pointing at, or null if it is pointing at
 *  nothing. Nearest wins, and only inside SNAP_PX — an arrow into empty space stays
 *  unattached, because "this arrow goes nowhere" is itself worth asking about. */
function nearestNode(point, nodeElements) {
  let best = null;
  let bestDistance = SNAP_PX;
  for (const node of nodeElements) {
    const d = distanceToBox(point, box(node));
    if (d <= bestDistance) {
      // A frame contains everything drawn in it, so it would win every containment test
      // and swallow the real target. Only consider it when nothing else is close.
      if (best && node.type === 'frame') continue;
      best = node;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Turn a scene into components and connections.
 *
 * @param {object[]} elements Excalidraw's element array, as stored
 * @returns {{nodes: object[], edges: object[], notes: string[], orphans: object[], unattached: number}}
 */
export function sceneToGraph(elements) {
  const all = live(elements);

  // Text bound to a container is that container's label, not a note of its own.
  const textByContainer = new Map();
  for (const e of all) {
    if (e.type === 'text' && typeof e.containerId === 'string' && e.containerId) {
      const existing = textByContainer.get(e.containerId);
      textByContainer.set(e.containerId, existing ? `${existing} ${clean(e.text)}` : clean(e.text));
    }
  }

  const nodeElements = all.filter((e) => NODE_TYPES.has(e.type));
  const byId = new Map(nodeElements.map((e) => [e.id, e]));

  const nodes = [];
  for (const e of nodeElements) {
    const label = boundLabel(e, textByContainer);
    // An unlabelled box is a box, not a component. Saying "Rectangle" would be inventing
    // a name the candidate never gave; an empty label is reported honestly instead.
    nodes.push({
      id: e.id,
      label,
      shape: e.type,
      unlabelled: label === '',
      at: { x: Math.round(Number(e.x) || 0), y: Math.round(Number(e.y) || 0) },
    });
  }

  const edges = [];
  let unattached = 0;
  for (const e of all) {
    if (!EDGE_TYPES.has(e.type)) continue;
    const ends = endpoints(e);
    let fromId = e.startBinding?.elementId ?? null;
    let toId = e.endBinding?.elementId ?? null;
    if ((!fromId || !byId.has(fromId)) && ends) fromId = nearestNode(ends.from, nodeElements)?.id ?? null;
    if ((!toId || !byId.has(toId)) && ends) toId = nearestNode(ends.to, nodeElements)?.id ?? null;
    if (!byId.has(fromId) || !byId.has(toId) || fromId === toId) {
      unattached += 1;
      continue;
    }
    edges.push({ id: e.id, from: fromId, to: toId, label: boundLabel(e, textByContainer) });
  }

  // Free-standing text: the candidate's own annotations. Requirements, numbers, a note
  // to themselves. Worth showing the interviewer verbatim.
  const notes = all
    .filter((e) => e.type === 'text' && !e.containerId)
    .map((e) => clean(e.text))
    .filter(Boolean);

  // The prompt asks the interviewer to challenge any component nothing reads from. This
  // hands it the list rather than making it re-derive one from prose.
  const touched = new Set();
  for (const edge of edges) { touched.add(edge.from); touched.add(edge.to); }
  const orphans = nodes.filter((n) => !touched.has(n.id) && !n.unlabelled && n.shape !== 'frame');

  return { nodes, edges, notes, orphans, unattached };
}

/** Reading order: down the page, then across. A design is usually drawn left-to-right
 *  along the request path, so this renders close to how it is meant to be read. */
function readingOrder(a, b) {
  const rowA = Math.round(a.at.y / 80);
  const rowB = Math.round(b.at.y / 80);
  if (rowA !== rowB) return rowA - rowB;
  if (a.at.x !== b.at.x) return a.at.x - b.at.x;
  return a.label.localeCompare(b.label);
}

/**
 * The graph as the interviewer sees it.
 *
 * Deliberately terse. This block is re-sent whenever the design changes, so every wasted
 * line is paid for on every turn of the interview.
 */
export function renderGraph(graph) {
  if (!graph || (graph.nodes.length === 0 && graph.notes.length === 0)) {
    return 'The canvas is empty.';
  }
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const name = (id) => {
    const node = byId.get(id);
    if (!node) return '?';
    return node.unlabelled ? `(unlabelled ${node.shape})` : node.label;
  };

  const out = [];
  const drawn = [...graph.nodes].sort(readingOrder);

  if (drawn.length) {
    out.push('COMPONENTS');
    for (const n of drawn) {
      out.push(`  ${n.unlabelled ? `(unlabelled ${n.shape})` : n.label}`);
    }
  }

  if (graph.edges.length) {
    out.push('', 'CONNECTIONS');
    const order = new Map(drawn.map((n, i) => [n.id, i]));
    const sorted = [...graph.edges].sort((a, b) =>
      (order.get(a.from) ?? 0) - (order.get(b.from) ?? 0)
      || (order.get(a.to) ?? 0) - (order.get(b.to) ?? 0)
      || a.label.localeCompare(b.label));
    for (const e of sorted) {
      out.push(`  ${name(e.from)} -> ${name(e.to)}${e.label ? `   "${e.label}"` : ''}`);
    }
  }

  // Stated plainly because the interviewer is told to ask who reads from a component.
  if (graph.orphans.length) {
    out.push('', 'DRAWN BUT UNCONNECTED  (nothing reads from or writes to these)');
    for (const n of graph.orphans) out.push(`  ${n.label}`);
  }

  if (graph.unattached > 0) {
    out.push('', `${graph.unattached} arrow(s) are drawn but do not join two components.`);
  }

  if (graph.notes.length) {
    out.push('', 'WRITTEN ON THE CANVAS');
    for (const note of graph.notes) out.push(`  ${note}`);
  }

  return out.join('\n');
}

/** The comparable identity of a graph: what it says, never where it sits. */
function signature(graph) {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const key = (id) => {
    const n = byId.get(id);
    if (!n) return '?';
    return n.unlabelled ? `#${n.id}` : labelKey(n.label);
  };
  return {
    nodes: new Map(graph.nodes.map((n) => [n.unlabelled ? `#${n.id}` : labelKey(n.label), n])),
    edges: new Map(graph.edges.map((e) => [`${key(e.from)}>${key(e.to)}|${labelKey(e.label)}`, e])),
    notes: new Set(graph.notes.map(labelKey)),
  };
}

/**
 * What changed, in the candidate's terms.
 *
 * Returns `{ changed, added, removed, relabelled, connected, disconnected, noted }`.
 * `changed` is false for anything that is only a move, a resize, a recolour or a
 * selection — which is the overwhelming majority of scene updates, and every one of them
 * would otherwise be an interruption.
 */
export function diffGraphs(before, after) {
  const a = signature(before ?? { nodes: [], edges: [], notes: [] });
  const b = signature(after ?? { nodes: [], edges: [], notes: [] });

  const added = [...b.nodes.keys()].filter((k) => !a.nodes.has(k));
  const removed = [...a.nodes.keys()].filter((k) => !b.nodes.has(k));
  const connected = [...b.edges.keys()].filter((k) => !a.edges.has(k));
  const disconnected = [...a.edges.keys()].filter((k) => !b.edges.has(k));
  const noted = [...b.notes].filter((n) => !a.notes.has(n));

  // A box that gained its first label reads as a new component, not as an edit, because
  // until it was named there was nothing there to talk about.
  const relabelled = [];
  for (const [key, node] of b.nodes) {
    if (!key.startsWith('#')) continue;
    if (a.nodes.has(key) && !a.nodes.get(key).unlabelled && node.unlabelled) relabelled.push(key);
  }

  const changed = added.length > 0 || removed.length > 0 || connected.length > 0
    || disconnected.length > 0 || noted.length > 0 || relabelled.length > 0;

  return { changed, added, removed, connected, disconnected, noted, relabelled };
}

/** The change as one line for the interviewer's context, or null when nothing happened. */
export function describeDiff(diff, after) {
  if (!diff?.changed) return null;
  const byKey = new Map((after?.nodes ?? []).map((n) => [labelKey(n.label), n.label]));
  const pretty = (k) => byKey.get(k) ?? k;
  const parts = [];
  if (diff.added.length) parts.push(`drew ${diff.added.map(pretty).join(', ')}`);
  if (diff.connected.length) {
    parts.push(`connected ${diff.connected.map((k) => {
      const [pair, label] = k.split('|');
      const [from, to] = pair.split('>');
      return `${pretty(from)} -> ${pretty(to)}${label ? ` "${label}"` : ''}`;
    }).join(', ')}`);
  }
  if (diff.removed.length) parts.push(`deleted ${diff.removed.map(pretty).join(', ')}`);
  if (diff.disconnected.length) parts.push(`removed ${diff.disconnected.length} connection(s)`);
  if (diff.noted.length) parts.push(`wrote "${diff.noted.join('", "')}"`);
  return parts.join('; ');
}
