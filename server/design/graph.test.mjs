// Reading a drawing as a design.
//
// The thing under test is judgement, not parsing. Excalidraw will happily tell you that
// 41 properties changed; almost none of them mean anything. What these hold down is the
// line between a change the candidate made and a change the tool made.

import test from 'node:test';
import assert from 'node:assert/strict';

import { sceneToGraph, renderGraph, diffGraphs, describeDiff } from './graph.mjs';

let seq = 0;
const id = (name) => `${name}-${++seq}`;

function boxEl(label, x, y, { type = 'rectangle', w = 120, h = 60 } = {}) {
  const elementId = id('box');
  const textId = id('txt');
  return [
    { id: elementId, type, x, y, width: w, height: h, boundElements: [{ id: textId, type: 'text' }] },
    { id: textId, type: 'text', x: x + 8, y: y + 20, width: w - 16, height: 20, text: label, containerId: elementId },
  ];
}

function arrowEl(from, to, label = null, { bind = true } = {}) {
  const elementId = id('arrow');
  const out = [{
    id: elementId,
    type: 'arrow',
    x: from.x + from.width, y: from.y + from.height / 2,
    width: 60, height: 0,
    points: [[0, 0], [to.x - (from.x + from.width), (to.y + to.height / 2) - (from.y + from.height / 2)]],
    startBinding: bind ? { elementId: from.id, focus: 0, gap: 4 } : null,
    endBinding: bind ? { elementId: to.id, focus: 0, gap: 4 } : null,
  }];
  if (label) {
    const textId = id('atxt');
    out[0].boundElements = [{ id: textId, type: 'text' }];
    out.push({ id: textId, type: 'text', x: 0, y: 0, width: 40, height: 20, text: label, containerId: elementId });
  }
  return out;
}

/** Client → API → Postgres, with a Redis nobody talks to. */
function scene() {
  const client = boxEl('Client', 0, 0);
  const api = boxEl('API Gateway', 200, 0);
  const pg = boxEl('Postgres', 400, 0);
  const redis = boxEl('Redis', 400, 200);
  return {
    // A box is two elements — the shape and the text bound inside it. Both have to be
    // in the scene or the shape has no name, which is a different test entirely.
    elements: [
      ...client, ...api, ...pg, ...redis,
      { id: id('t'), type: 'text', x: 0, y: 300, width: 300, height: 20, text: '200M DAU, 10:1 read/write' },
      ...arrowEl(client[0], api[0]),
      ...arrowEl(api[0], pg[0], 'writes'),
    ],
    client: client[0], api: api[0], pg: pg[0], redis: redis[0],
    redisText: redis[1], pgText: pg[1],
  };
}

test('boxes become components and bound text becomes their names', () => {
  const { elements } = scene();
  const g = sceneToGraph(elements);
  assert.deepEqual(g.nodes.map((n) => n.label).sort(),
    ['API Gateway', 'Client', 'Postgres', 'Redis']);
});

test('arrows become connections, with the label the candidate wrote on them', () => {
  const { elements } = scene();
  const g = sceneToGraph(elements);
  const byLabel = new Map(g.nodes.map((n) => [n.id, n.label]));
  const edges = g.edges.map((e) => `${byLabel.get(e.from)}>${byLabel.get(e.to)}${e.label ? `:${e.label}` : ''}`);
  assert.deepEqual(edges.sort(), ['API Gateway>Postgres:writes', 'Client>API Gateway']);
});

test('a component nothing reads from is surfaced, because the interviewer must ask why', () => {
  const { elements } = scene();
  const g = sceneToGraph(elements);
  assert.deepEqual(g.orphans.map((n) => n.label), ['Redis']);
  assert.match(renderGraph(g), /DRAWN BUT UNCONNECTED[\s\S]*Redis/);
});

test('deleted elements are gone, not ghosts', () => {
  const { elements, redis, redisText } = scene();
  const withDelete = elements.map((e) =>
    (e.id === redis.id || e.id === redisText.id ? { ...e, isDeleted: true } : e));
  const g = sceneToGraph(withDelete);
  assert.ok(!g.nodes.some((n) => n.label === 'Redis'), 'a deleted box is still on the graph');
});

test('an arrow drawn near a box, not onto it, still counts as a connection', () => {
  // Excalidraw writes no binding unless you drop the arrow on the shape. The candidate
  // plainly meant a dependency, and losing it would have the interviewer ask about a
  // connection that is visibly on the screen.
  const a = boxEl('Producer', 0, 0);
  const b = boxEl('Kafka', 200, 0);
  const g = sceneToGraph([...a, ...b, ...arrowEl(a[0], b[0], null, { bind: false })]);
  assert.equal(g.edges.length, 1, 'an unbound but touching arrow was dropped');
  assert.equal(g.unattached, 0);
});

test('an arrow into empty space is reported, not invented into a connection', () => {
  const a = boxEl('Producer', 0, 0)[0];
  const arrow = {
    id: id('arrow'), type: 'arrow', x: 130, y: 30, width: 400, height: 0,
    points: [[0, 0], [400, 0]], startBinding: null, endBinding: null,
  };
  const g = sceneToGraph([a, arrow]);
  assert.equal(g.edges.length, 0);
  assert.equal(g.unattached, 1);
  assert.match(renderGraph(g), /1 arrow\(s\) are drawn but do not join/);
});

test('an unlabelled box is reported as unlabelled, never given a name', () => {
  const g = sceneToGraph([{ id: 'b1', type: 'rectangle', x: 0, y: 0, width: 100, height: 50 }]);
  assert.equal(g.nodes[0].unlabelled, true);
  assert.equal(g.nodes[0].label, '');
  assert.match(renderGraph(g), /\(unlabelled rectangle\)/);
});

test('free text is the candidate\'s own writing and is quoted, not parsed', () => {
  const { elements } = scene();
  assert.match(renderGraph(sceneToGraph(elements)), /WRITTEN ON THE CANVAS[\s\S]*200M DAU, 10:1 read\/write/);
});

/* ---- the part that decides whether this is usable ---- */

test('moving a box is not a change', () => {
  const { elements } = scene();
  const before = sceneToGraph(elements);
  const moved = elements.map((e) => ({ ...e, x: (Number(e.x) || 0) + 37, y: (Number(e.y) || 0) - 12 }));
  const diff = diffGraphs(before, sceneToGraph(moved));
  assert.equal(diff.changed, false, 'a drag would have interrupted the candidate');
});

test('resizing, recolouring and reselecting are not changes either', () => {
  const { elements } = scene();
  const before = sceneToGraph(elements);
  const fiddled = elements.map((e) => ({
    ...e, width: (Number(e.width) || 0) * 1.4, strokeColor: '#ff0000',
    backgroundColor: '#eee', seed: 999, version: (e.version ?? 0) + 50, versionNonce: 12345,
  }));
  assert.equal(diffGraphs(before, sceneToGraph(fiddled)).changed, false);
});

test('drawing a cache IS a change, and it is described in the candidate\'s words', () => {
  const { elements, api } = scene();
  const before = sceneToGraph(elements);
  const cache = boxEl('Redis cache', 200, 150);
  const after = sceneToGraph([...elements, ...cache, ...arrowEl(api, cache[0], 'read-through')]);
  const diff = diffGraphs(before, after);
  assert.equal(diff.changed, true);
  const said = describeDiff(diff, after);
  assert.match(said, /drew Redis cache/);
  assert.match(said, /connected API Gateway -> Redis cache "read-through"/);
});

test('deleting a component is a change', () => {
  const { elements, pg, pgText } = scene();
  const before = sceneToGraph(elements);
  const after = sceneToGraph(elements.filter((e) => e.id !== pg.id && e.id !== pgText.id));
  const diff = diffGraphs(before, after);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.removed, ['postgres']);
});

test('renaming a component reads as one gone and one arrived, which is what it is', () => {
  const { elements } = scene();
  const before = sceneToGraph(elements);
  const renamed = elements.map((e) => (e.text === 'Postgres' ? { ...e, text: 'DynamoDB' } : e));
  const diff = diffGraphs(before, sceneToGraph(renamed));
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.added, ['dynamodb']);
  assert.deepEqual(diff.removed, ['postgres']);
});

test('nothing changed means nothing changed', () => {
  const { elements } = scene();
  const g = sceneToGraph(elements);
  assert.equal(diffGraphs(g, sceneToGraph(elements)).changed, false);
  assert.equal(describeDiff(diffGraphs(g, g), g), null);
});

test('the render is derived: same scene in, same bytes out', () => {
  const { elements } = scene();
  assert.equal(renderGraph(sceneToGraph(elements)), renderGraph(sceneToGraph(elements)));
});

test('an empty canvas says so rather than pretending to a design', () => {
  assert.equal(renderGraph(sceneToGraph([])), 'The canvas is empty.');
});
