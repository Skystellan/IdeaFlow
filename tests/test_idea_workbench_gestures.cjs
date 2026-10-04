'use strict';

// Exercise the real pointer handlers with a minimal DOM; no browser dependency.
// Run: node tests/test_idea_workbench_gestures.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../idea_workbench/static/app.js'), 'utf8');
const handlers = source.slice(source.indexOf('  function selectedPositions('), source.indexOf('  function resetContext('));
const element = () => ({
  classList: { values: new Set(), add(value) { this.values.add(value); }, remove(value) { this.values.delete(value); } },
  style: {}, focus() {}, setPointerCapture() { this.captured = true; },
  hasPointerCapture() { return this.captured; }, releasePointerCapture() { this.captured = false; },
});
const viewport = element();
const buttons = new Map(['a', 'b', 'c'].map(id => [id, { ...element(), parentElement: element(), dataset: { nodeId: id } }]));
const nodes = new Map([['a', { x: 20, y: 30 }], ['b', { x: 320, y: 130 }], ['c', { x: 620, y: 30 }]]);
let redraws = 0, saved, activated;
const context = vm.createContext({
  positions: nodes, nodeButtons: buttons, manualPositions: new Map(), camera: { x: 10, y: 20, scale: .5 },
  selectedNodes: new Set(['a', 'b']), selectedEdges: new Set(['a-b', 'b-c']), selectedId: null,
  state: { nodes: [...nodes.keys()] }, gesture: null, edgeSaving: false, spacePressed: false,
  edgePaths: [], connectionTarget: null,
  $: () => viewport,
  drawEdges() { redraws++; }, positionNodeActions() {}, applyCamera() {}, renderGraph() {},
  cancelConnection() {}, closeDetails() {},
  clearSelection() { context.selectedNodes.clear(); context.selectedEdges.clear(); },
  activateNode(id) { activated = id; }, selectEdge() {},
  rememberView() { saved = JSON.stringify(Object.fromEntries(context.manualPositions)); },
});
vm.runInContext(handlers, context);
const event = (id, x, y, extra = {}) => ({
  button: 0, pointerId: 1, clientX: x, clientY: y, type: 'pointermove', preventDefault() {},
  target: { closest(selector) { return selector === '.node-group' && id ? { querySelector: () => buttons.get(id) } : null; } },
  ...extra,
});

context.startGesture(event('a', 100, 100));
context.updateGesture(event('a', 101, 101));
assert.equal(redraws, 0, 'A small click wobble must not move the group');
context.updateGesture(event('a', 120, 110));
assert.deepEqual(nodes.get('a'), { x: 60, y: 50 });
assert.deepEqual(nodes.get('b'), { x: 360, y: 150 });
assert.deepEqual(nodes.get('c'), { x: 620, y: 30 }, 'An unselected endpoint must stay put');
assert.equal(redraws, 1, 'Connections redraw after the whole group moves');
context.updateGesture(event('a', 140, 130));
assert.deepEqual(nodes.get('a'), { x: 100, y: 90 });
assert.deepEqual(nodes.get('b'), { x: 400, y: 190 }, 'Offsets are measured from pointer-down, not accumulated');
assert.equal(buttons.get('b').parentElement.style.left, '400px');
assert.equal(context.camera.x, 10, 'Dragging nodes must not pan the canvas');
context.endGesture(event('a', 140, 130, { type: 'pointerup' }));
assert.equal(activated, undefined, 'Finishing a drag must not collapse the selection to a single node');
assert.deepEqual([...context.selectedNodes], ['a', 'b']);
assert.deepEqual([...context.selectedEdges], ['a-b', 'b-c']);
assert.deepEqual(JSON.parse(saved), { a: { x: 100, y: 90 }, b: { x: 400, y: 190 } });
assert.ok([...buttons.values()].every(button => !button.classList.values.has('is-dragging')));

// Dragging an unselected card moves only that card, not the previous group.
context.startGesture(event('c', 100, 100));
context.updateGesture(event('c', 110, 105));
context.endGesture(event('c', 110, 105, { type: 'pointerup' }));
assert.deepEqual(nodes.get('c'), { x: 640, y: 40 });
assert.deepEqual(nodes.get('b'), { x: 400, y: 190 });
assert.equal(context.selectedNodes.size, 0);

// Space and middle-button dragging still pan; Command still starts a marquee.
context.selectedNodes.add('a'); context.selectedNodes.add('b');
context.spacePressed = true;
context.startGesture(event('a', 100, 100));
context.updateGesture(event('a', 110, 120));
context.endGesture(event('a', 110, 120, { type: 'pointerup' }));
assert.equal(context.camera.x, 20); assert.equal(context.camera.y, 40);
assert.deepEqual(nodes.get('a'), { x: 100, y: 90 });
context.spacePressed = false;
context.startGesture(event('a', 100, 100, { button: 1 }));
context.updateGesture(event('a', 110, 120, { button: 1 }));
context.endGesture(event('a', 110, 120, { type: 'pointerup', button: 1 }));
assert.equal(context.camera.x, 30); assert.equal(context.camera.y, 60);
context.startGesture(event('a', 100, 100, { metaKey: true }));
assert.equal(context.gesture.box, true);
context.endGesture(event('a', 100, 100, { type: 'pointercancel' }));
assert.deepEqual([...context.selectedNodes], ['a', 'b']);
console.log('Group drag passed: scaled movement, relative spacing, untouched nodes, saved positions and existing gestures.');
