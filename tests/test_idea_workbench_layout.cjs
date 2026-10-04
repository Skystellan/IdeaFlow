'use strict';

// Run with: node tests/test_idea_workbench_layout.cjs [optional-graph.json]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const graph = require('../idea_workbench/static/graph-layout.js');
const { NODE_WIDTH: W, NODE_HEIGHT: H, layout, routeEdge, bounds } = graph;
const node = (id, owner = 'a') => ({ id, idea_id: owner, kind: id === owner ? 'idea' : 'experiment' });
const edge = (source, target) => ({ source, target });

// A marquee can cross a wire without containing either endpoint.
const selection = { left: 10, right: 20, top: 10, bottom: 20 };
assert.equal(graph.segmentIntersectsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, selection), true);
assert.equal(graph.segmentIntersectsRect({ x: 15, y: 30 }, { x: 15, y: 0 }, selection), true);
assert.equal(graph.segmentIntersectsRect({ x: 0, y: 9 }, { x: 30, y: 9 }, selection), false);
assert.equal(graph.segmentIntersectsRect({ x: 0, y: 0 }, { x: 9, y: 9 }, selection), false);
assert.equal(graph.segmentIntersectsRect({ x: 15, y: 15 }, { x: 15, y: 15 }, selection), true);
assert.equal(graph.segmentIntersectsRect({ x: 0, y: 20 }, { x: 10, y: 10 }, selection), true);

// Sample the actual SVG geometry (including curves), not just its control points.
function samplePath(path) {
  assert.ok(path && !/NaN|Infinity|undefined/.test(path), `Invalid path: ${path}`);
  const tokens = path.match(/[MLCQ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  const points = [];
  let index = 0, current;
  const point = () => ({ x: Number(tokens[index++]), y: Number(tokens[index++]) });
  while (index < tokens.length) {
    const command = tokens[index++];
    assert.ok(['M', 'L', 'C', 'Q'].includes(command), `Unexpected command ${command}`);
    if (command === 'M') { current = point(); points.push(current); continue; }
    const controls = [current];
    for (let count = { L: 1, Q: 2, C: 3 }[command]; count > 0; count--) controls.push(point());
    for (let step = 1; step <= 100; step++) {
      const t = step / 100;
      let work = controls;
      while (work.length > 1) work = work.slice(1).map((p, i) => ({
        x: work[i].x * (1 - t) + p.x * t, y: work[i].y * (1 - t) + p.y * t,
      }));
      points.push(work[0]);
    }
    current = controls.at(-1);
  }
  assert.ok(points.every(p => Number.isFinite(p.x) && Number.isFinite(p.y)));
  return points;
}

function checkGeometry(nodes, edges) {
  const result = layout(nodes, edges), positions = result.positions;
  assert.equal(positions.size, nodes.length);
  const entries = [...positions];
  for (let i = 0; i < entries.length; i++) {
    const [id, a] = entries[i];
    assert.ok(a.x >= 0 && a.y >= 0 && a.x + W <= result.width && a.y + H <= result.height);
    for (const [other, b] of entries.slice(i + 1)) {
      assert.ok(a.x + W <= b.x || b.x + W <= a.x || a.y + H <= b.y || b.y + H <= a.y,
        `Overlapping cards: ${id}, ${other}`);
    }
  }
  for (const e of edges) {
    const from = positions.get(e.source), to = positions.get(e.target);
    if (!from || !to) { assert.equal(routeEdge(e, positions, edges), ''); continue; }
    assert.ok(to.rank > from.rank, `${e.source} -> ${e.target} must travel down`);
    const samples = samplePath(routeEdge(e, positions, edges));
    for (const [id, card] of positions) {
      // Check endpoint cards too: detours must not double back through a card.
      assert.ok(samples.every(p => p.x <= card.x + 1e-7 || p.x >= card.x + W - 1e-7
        || p.y <= card.y + 1e-7 || p.y >= card.y + H - 1e-7),
      `${e.source} -> ${e.target} intersects ${id}`);
    }
    assert.ok(samples.every(p => p.x >= 0 && p.x <= result.width && p.y >= 0 && p.y <= result.height));
  }
  return result;
}

// Same-owner siblings, a merge, a new idea fork, cross-branch edges, and long skips.
const nodes = ['a', 'a1', 'a2', 'a3', 'a4', 'a5'].map(id => node(id))
  .concat(['b', 'b1', 'b2'].map(id => node(id, 'b')), ['c', 'c1', 'c2'].map(id => node(id, 'c')));
const edges = [edge('a', 'a1'), edge('a1', 'a2'), edge('a1', 'a3'), edge('a2', 'a4'), edge('a3', 'a4'),
  edge('a4', 'a5'), edge('a1', 'b'), edge('b', 'b1'), edge('b1', 'b2'), edge('a', 'c'),
  edge('c', 'c1'), edge('c1', 'c2'), edge('c2', 'b2'), edge('a', 'a5'), edge('a', 'b2'), edge('b', 'b2')];
const before = JSON.stringify({ nodes, edges });
const result = checkGeometry(nodes, edges);
assert.equal(JSON.stringify({ nodes, edges }), before, 'Geometry must not rewrite nodes or edges');
assert.equal(result.cyclic, false);
assert.deepEqual(layout([...nodes].reverse(), [...edges].reverse()), result, 'Input ordering must not move branches');
for (const branch of [['a', 'a1', 'a4', 'a5'], ['b', 'b1', 'b2'], ['c', 'c1', 'c2']]) {
  assert.equal(new Set(branch.map(id => result.positions.get(id).x)).size, 1, 'Singleton ranks stay in the branch lane');
}
assert.notEqual(result.positions.get('a2').x, result.positions.get('a3').x);
assert.equal(result.positions.get('a2').rank, result.positions.get('a3').rank);

// Continuations do not each acquire a fresh column; endpoints split fan-in/out.
const chain = Array.from({ length: 18 }, (_, i) => node(`n${i}`));
const chainEdges = chain.slice(1).map((n, i) => edge(chain[i].id, n.id));
assert.ok(checkGeometry(chain, chainEdges).width <= W + 120);
const forkPaths = edges.filter(e => e.source === 'a1').map(e => samplePath(routeEdge(e, result.positions, edges))[0].x);
assert.equal(new Set(forkPaths).size, forkPaths.length);
const mergePaths = edges.filter(e => e.target === 'a4').map(e => samplePath(routeEdge(e, result.positions, edges)).at(-1).x);
assert.equal(new Set(mergePaths).size, mergePaths.length);

// Long edges can take either nearby gap, instead of sharing a far-right gutter.
const corridorNodes = ['a', 'a1', 'a2', 'b', 'b1', 'b2', 'c', 'c1', 'c2'].map(id => node(id, id[0]));
const corridorEdges = ['a', 'b', 'c'].flatMap(id => [edge(id, `${id}1`), edge(`${id}1`, `${id}2`)])
  .concat(edge('a', 'b2'), edge('c', 'b2'));
const corridors = checkGeometry(corridorNodes, corridorEdges);
const middle = corridors.positions.get('b1');
const fromLeft = samplePath(routeEdge(corridorEdges.at(-2), corridors.positions, corridorEdges));
const fromRight = samplePath(routeEdge(corridorEdges.at(-1), corridors.positions, corridorEdges));
const alongside = samples => samples.filter(p => p.y > middle.y && p.y < middle.y + H);
assert.ok(alongside(fromLeft).every(p => p.x < middle.x));
assert.ok(alongside(fromRight).every(p => p.x > middle.x + W));

// A card in the curve's bounding box, but away from its actual trajectory, must
// not force a long detour (the old rectangle-only check did exactly that).
const nearCurve = new Map([['source', { x: 0, y: 0 }], ['target', { x: 700, y: 600 }],
  ['nearby', { x: 550, y: 165 }]]);
const nearEdge = edge('source', 'target');
const clearCurve = routeEdge(nearEdge, new Map([...nearCurve].slice(0, 2)));
assert.equal(routeEdge(nearEdge, nearCurve), clearCurve, 'A nearby card that does not obstruct the curve must not change it');

// Bypasses leave and enter cards vertically, without a horizontal rail or abrupt
// turn. Unrelated distant branches do not affect the local routing decision.
const bypass = new Map([['source', { x: 48, y: 48 }], ['target', { x: 48, y: 684 }],
  ['blocker', { x: 48, y: 300 }]]);
const bypassSamples = samplePath(routeEdge(nearEdge, bypass));
assert.ok(bypassSamples.every(p => p.x <= 48 || p.x >= 48 + W || p.y <= 300 || p.y >= 300 + H));
assert.ok(bypassSamples.slice(1).every((p, i) => Math.hypot(p.x - bypassSamples[i].x, p.y - bypassSamples[i].y) < 1e-7
  || p.y > bypassSamples[i].y), 'A downward bypass must progress smoothly, without horizontal rail segments');
const oldBypass = routeEdge(nearEdge, bypass);
bypass.set('distant', { x: 10000, y: 10000 });
assert.equal(routeEdge(nearEdge, bypass), oldBypass);
const overlapping = new Map([['source', { x: 48, y: 48 }], ['target', { x: 130, y: 105 }],
  ['far-left', { x: -10000, y: -10000 }], ['far-right', { x: 10000, y: 10000 }]]);
assert.ok(samplePath(routeEdge(nearEdge, overlapping)).every(p => p.x >= 48 && p.x <= 130 + W),
  'Overlapping cards must not send their wire out to distant canvas boundaries');

// Skips returning to the same branch remain distinct along their shared span.
const skipNodes = Array.from({ length: 6 }, (_, i) => node(`skip${i}`));
const skipEdges = skipNodes.slice(1).map((n, i) => edge(skipNodes[i].id, n.id));
skipEdges.push(edge('skip0', 'skip5'), edge('skip1', 'skip5'));
const skips = checkGeometry(skipNodes, skipEdges), obstacle = skips.positions.get('skip3');
const lanes = skipEdges.slice(-2).map(e => samplePath(routeEdge(e, skips.positions, skipEdges))
  .filter(p => p.y > obstacle.y && p.y < obstacle.y + H));
assert.ok(lanes.every(points => points.length));
assert.ok(lanes[0].every(a => lanes[1].every(b => Math.abs(a.x - b.x) > 4)), 'Long edges must not share the same visible rail');

// A representative 45-card, seven-idea graph includes many skips and merges.
const researchNodes = [], researchEdges = [];
for (let branch = 0; branch < 7; branch++) {
  const owner = `idea${branch}`, count = branch < 3 ? 7 : 6;
  for (let i = 0; i < count; i++) {
    const id = i ? `${owner}-${i}` : owner;
    researchNodes.push(node(id, owner));
    if (i) researchEdges.push(edge(i === 1 ? owner : `${owner}-${i - 1}`, id));
  }
  researchEdges.push(edge(owner, `${owner}-${count - 1}`));
  if (branch) researchEdges.push(edge(`idea${branch - 1}-1`, `${owner}-3`));
  if (branch < 4) researchEdges.push(edge(owner, `${owner}-4`));
}
assert.equal(researchNodes.length, 45);
assert.equal(researchEdges.length, 55);
checkGeometry(researchNodes, researchEdges);

// Missing endpoints, empty input, and malformed cycles have bounded fallbacks.
assert.deepEqual(layout([], []), { positions: new Map(), width: 0, height: 0, cyclic: false });
assert.deepEqual(bounds(new Map()), { x: 0, y: 0, width: 0, height: 0 });
const missing = [edge('a', 'absent'), edge('absent', 'a'), edge('a', 'a1')];
checkGeometry([node('a'), node('a1')], missing);
const cycleEdges = [edge('a', 'b'), edge('b', 'a'), edge('a', 'a')];
const cyclic = layout([node('a'), node('b', 'b')], cycleEdges);
assert.equal(cyclic.cyclic, true);
assert.equal(cyclic.positions.size, 2);
for (const p of cyclic.positions.values()) assert.ok(p.x + W <= cyclic.width && p.y + H <= cyclic.height);
for (const e of cycleEdges) samplePath(routeEdge(e, cyclic.positions, cycleEdges));

// Dragging changes actual endpoints even if stored ranks still describe the DAG.
const movedEdge = edge('a', 'a5');
const oldPath = routeEdge(movedEdge, result.positions, edges);
for (const moved of [{ x: -500, y: -350 }, { x: 1300, y: 20 }, { x: -500, y: 60 }, { x: 80, y: 900 }]) {
  const positions = new Map(result.positions);
  positions.set('a5', { ...positions.get('a5'), ...moved });
  const path = routeEdge(movedEdge, positions, edges), samples = samplePath(path), end = samples.at(-1);
  assert.notEqual(path, oldPath);
  const epsilon = 1e-7;
  assert.ok(end.x >= moved.x - epsilon && end.x <= moved.x + W + epsilon
    && end.y >= moved.y - epsilon && end.y <= moved.y + H + epsilon);
  assert.ok(Math.min(Math.abs(end.x - moved.x), Math.abs(end.x - moved.x - W),
    Math.abs(end.y - moved.y), Math.abs(end.y - moved.y - H)) < epsilon, 'Arrow must meet the moved card border');
  const box = bounds(positions);
  assert.ok(box.x <= moved.x && box.y <= moved.y && box.x + box.width >= moved.x + W && box.y + box.height >= moved.y + H);
}

const browser = { window: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../idea_workbench/static/graph-layout.js'), 'utf8'), browser);
assert.deepEqual(Object.keys(browser.window.ResearchGraph).sort(), Object.keys(graph).sort());
if (process.argv[2]) {
  const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  checkGeometry(data.nodes, data.edges);
  console.log(`External graph geometry passed: ${data.nodes.length} nodes, ${data.edges.length} edges.`);
}
console.log('Research graph geometry tests passed.');
