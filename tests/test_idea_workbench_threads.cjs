'use strict';

// Thread map layout and bead states. Run: node tests/test_idea_workbench_threads.cjs
const assert = require('node:assert/strict');
const { layoutThreads, linkPath, COL, LANE } = require('../idea_workbench/static/thread-layout.js');
const model = require('../idea_workbench/static/journal-model.js');

let clock = 0;
const node = (id, kind = 'experiment', status = 'done') => ({ id, kind, status, title: `Title ${id}`, created_at: `2026-10-01T00:00:${String(clock++).padStart(2, '0')}` });
const edge = (source, target) => ({ source, target });
const laneOf = (result, id) => result.beads.get(id).lane;
const colOf = (result, id) => result.beads.get(id).col;
const threadIds = result => result.threads.map(t => t.members.join(','));

// Empty input is a valid, empty map.
const empty = layoutThreads([], []);
assert.deepEqual([empty.threads, empty.links, empty.lanes], [[], [], 0]);
assert.equal(empty.beads.size, 0);

// A linear idea → experiment → insight → experiment chain is one horizontal thread.
{
  const nodes = [node('a', 'idea', 'active'), node('b'), node('c', 'insight'), node('d', 'experiment', 'active')];
  const result = layoutThreads(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')]);
  assert.deepEqual(threadIds(result), ['a,b,c,d']);
  assert.deepEqual(['a', 'b', 'c', 'd'].map(id => colOf(result, id)), [0, 1, 2, 3]);
  assert.equal(result.lanes, 1);
  assert.deepEqual(result.links, []);
  assert.equal(result.threads[0].alive, true);
  const ys = new Set([...result.beads.values()].map(b => b.y));
  assert.equal(ys.size, 1, 'A chain stays on one line instead of growing downward');
}

// A new question forks into its own thread; the link starts at the triggering bead.
{
  const nodes = [node('a', 'idea'), node('b'), node('c', 'insight'), node('d', 'idea', 'active'), node('e', 'experiment', 'proposed')];
  const result = layoutThreads(nodes, [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'e')]);
  assert.deepEqual(threadIds(result), ['a,b,c', 'd,e']);
  assert.deepEqual(result.links, [{ source: 'c', target: 'd', kind: 'fork' }]);
  assert.equal(colOf(result, 'd'), 3);
  assert.equal(laneOf(result, 'd'), 1, 'A fork right after its source needs its own lane');
  assert.equal(result.threads[0].alive, false);
  assert.equal(result.threads[1].alive, true);
}

// Lanes freed by finished threads are reused: height follows concurrent questions, not the total.
{
  const nodes = [node('r', 'idea'), node('e1'), node('e2'), node('e3'), node('e4'), node('e5'),
    node('s', 'idea'), node('e6'), node('u', 'idea'), node('e7')];
  const edges = [edge('r', 'e1'), edge('e1', 'e2'), edge('e2', 'e3'), edge('e3', 'e4'), edge('e4', 'e5'),
    edge('r', 's'), edge('s', 'e6'), edge('e5', 'u'), edge('u', 'e7')];
  const result = layoutThreads(nodes, edges);
  assert.deepEqual(threadIds(result), ['r,e1,e2,e3,e4,e5', 's,e6', 'u,e7']);
  assert.equal(laneOf(result, 's'), 1);
  assert.equal(laneOf(result, 'u'), 1, 'The later fork reuses the lane that s finished with');
  assert.equal(result.lanes, 2);
  const [, first, second] = result.threads;
  assert.ok(first.labelWidth <= (second.start - first.start) * COL, 'A label never runs into the next thread in its lane');
}

// Parallel attempts from one question become parallel threads that fork from it.
{
  const nodes = [node('a', 'idea'), node('e1'), node('e2')];
  const result = layoutThreads(nodes, [edge('a', 'e1'), edge('a', 'e2')]);
  assert.deepEqual(threadIds(result), ['a,e1', 'e2']);
  assert.deepEqual(result.links, [{ source: 'a', target: 'e2', kind: 'fork' }]);
  assert.equal(colOf(result, 'e2'), 1);
}

// A synthesis continues one source thread and draws a merge from the other.
{
  const nodes = [node('a', 'idea'), node('b'), node('c', 'idea'), node('d'), node('e'), node('s', 'insight')];
  const edges = [edge('a', 'b'), edge('a', 'c'), edge('c', 'd'), edge('d', 'e'), edge('b', 's'), edge('e', 's')];
  const result = layoutThreads(nodes, edges);
  assert.deepEqual(threadIds(result), ['a,b,s', 'c,d,e']);
  assert.deepEqual(result.links.find(l => l.target === 's'), { source: 'e', target: 's', kind: 'merge' });
  assert.equal(colOf(result, 's'), 4, 'A merge waits for its latest source');
}

// Beads never share a position, links always move rightward, and the map contains everything.
{
  let seed = 7;
  const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const nodes = Array.from({ length: 60 }, (_, i) => node(`n${i}`, random() < .25 ? 'idea' : random() < .5 ? 'insight' : 'experiment'));
  const edges = [];
  for (let i = 1; i < nodes.length; i++) {
    edges.push(edge(nodes[Math.floor(random() * i)].id, nodes[i].id));
    if (random() < .15) edges.push(edge(nodes[Math.floor(random() * i)].id, nodes[i].id));
  }
  const unique = [...new Map(edges.map(e => [`${e.source}>${e.target}`, e])).values()];
  const result = layoutThreads(nodes, unique);
  assert.equal(result.beads.size, nodes.length);
  const spots = new Set([...result.beads.values()].map(b => `${b.col}:${b.lane}`));
  assert.equal(spots.size, nodes.length, 'Two beads share a position');
  for (const e of unique) assert.ok(colOf(result, e.source) < colOf(result, e.target), `${e.source} → ${e.target} goes backwards`);
  for (const b of result.beads.values()) assert.ok(b.x > 0 && b.y > 0 && b.x < result.width && b.y < result.height);
  const linked = new Set(result.links.map(l => `${l.source}>${l.target}`));
  for (const t of result.threads) t.members.slice(1).forEach((id, i) => linked.add(`${t.members[i]}>${id}`));
  for (const e of unique) assert.ok(linked.has(`${e.source}>${e.target}`), `Edge ${e.source} → ${e.target} is not drawn`);
  const shuffled = layoutThreads([...nodes].reverse(), [...unique].reverse());
  assert.deepEqual([...shuffled.beads].sort(), [...result.beads].sort(), 'Layout must not depend on input order');
}

// Malformed cycles still show every record.
{
  const result = layoutThreads([node('a', 'idea'), node('b')], [edge('a', 'b'), edge('b', 'a')]);
  assert.equal(result.beads.size, 2);
  assert.equal(result.cyclic, true);
}

// Sample M/L/H/V/Q paths so routing is checked on the drawn geometry.
function samplePath(path) {
  assert.ok(path && !/NaN|undefined/.test(path), `Invalid path: ${path}`);
  const tokens = path.match(/[MLHVQ]|-?\d*\.?\d+/g), points = [];
  let i = 0, x = 0, y = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const command = tokens[i++];
    if (command === 'M') { x = num(); y = num(); points.push({ x, y }); continue; }
    const start = { x, y };
    let control = null;
    if (command === 'L') { x = num(); y = num(); }
    else if (command === 'H') x = num();
    else if (command === 'V') y = num();
    else if (command === 'Q') { control = { x: num(), y: num() }; x = num(); y = num(); }
    for (let step = 1; step <= 40; step++) {
      const t = step / 40, q = 1 - t;
      points.push(control ? { x: q * q * start.x + 2 * q * t * control.x + t * t * x, y: q * q * start.y + 2 * q * t * control.y + t * t * y }
        : { x: start.x + (x - start.x) * t, y: start.y + (y - start.y) * t });
    }
  }
  return points;
}
const clearOf = (points, bead) => points.every(p => Math.hypot(p.x - bead.x, p.y - bead.y) > 12);

// Links bend between columns, never through a bead column, and end before the target bead.
{
  const path = linkPath({ x: 100, y: 50 }, { x: 100 + COL, y: 150 });
  assert.match(path, /^M 100 50 /);
  const points = samplePath(path);
  assert.ok(points.every(p => p.x <= 100 + COL - 10), 'A link stops before its target bead');
  assert.match(linkPath({ x: 10, y: 50 }, { x: 10 + COL, y: 50 }), /^M 10 50 H \d+$/);
  const skip = samplePath(linkPath({ x: 10, y: 50 }, { x: 10 + 3 * COL, y: 50 }));
  for (let c = 1; c < 3; c++) assert.ok(clearOf(skip, { x: 10 + c * COL, y: 50 }), 'A same-lane link must not run over the beads it skips');
}

// A merge from early in one thread to a later step in another must not run over unrelated beads.
{
  const nodes = [node('a1', 'idea'), ...[2, 3, 4, 5, 6].map(i => node(`a${i}`)), node('b1', 'idea'),
    ...[2, 3, 4, 5].map(i => node(`b${i}`)), node('m', 'insight')];
  const edges = [...[1, 2, 3, 4, 5].map(i => edge(`a${i}`, `a${i + 1}`)), ...[1, 2, 3, 4].map(i => edge(`b${i}`, `b${i + 1}`)),
    edge('a2', 'm'), edge('b5', 'm')];
  const result = layoutThreads(nodes, edges);
  const merge = result.links.find(l => l.source === 'a2' && l.target === 'm');
  assert.ok(merge, 'The merge from a2 is drawn');
  const points = samplePath(linkPath(result.beads.get('a2'), result.beads.get('m')));
  for (const [id, bead] of result.beads) {
    if (id !== 'a2' && id !== 'm') assert.ok(clearOf(points, bead), `Merge link runs over ${id}`);
  }
  assert.ok(points.every(p => Math.abs(p.y - result.beads.get('a2').y) < 1 || Math.abs(p.y - result.beads.get('a2').y) > 20
    || p.x < result.beads.get('a2').x + COL), 'The link leaves the source lane right after the source');
}

// The canvas is wide enough for the last thread's label.
{
  const result = layoutThreads([node('a', 'idea'), node('b'), node('c', 'idea')], [edge('a', 'b'), edge('b', 'c')]);
  const last = result.threads.at(-1), head = result.beads.get(last.head);
  assert.ok(result.width >= head.x - 10 + last.labelWidth, 'The last label is clipped by the canvas edge');
  assert.ok(LANE > 0);
}

// Bead state comes from what was recorded, never from titles.
{
  const at = n => `2026-10-02T00:00:0${n}`;
  const entry = (kind, extra = {}) => ({ node_id: 'x', kind, author: kind === 'proposal' ? 'agent' : 'human', text: 't', run_id: null, outcome: null, decision: null, created_at: at(extra.n || 0), ...extra });
  const experiment = (status = 'done') => ({ id: 'x', kind: 'experiment', status });
  assert.equal(model.beadState({ id: 'x', kind: 'idea', status: 'active' }, [], []), 'thought');
  assert.equal(model.beadState({ id: 'x', kind: 'insight', status: 'done' }, [], []), 'thought');
  assert.equal(model.beadState(experiment('proposed'), [entry('proposal')], []), 'awaiting');
  const declined = [entry('proposal'), entry('decision', { decision: 'declined', n: 1 })];
  assert.equal(model.beadState(experiment('paused'), declined, []), 'declined');
  assert.equal(model.beadState(experiment('active'), declined, [{ id: 'r', status: 'running' }]), 'running', 'Running later outranks an old decline');
  assert.equal(model.beadState(experiment('done'), [...declined, entry('reaction', { outcome: 'expected', n: 3 })], [{ id: 'r', status: 'succeeded' }]), 'expected');
  assert.equal(model.beadState(experiment('active'), [], [{ id: 'r', status: 'running' }]), 'running');
  const reactions = [entry('reaction', { outcome: 'expected', n: 1 }), entry('reaction', { outcome: 'surprised', n: 2 })];
  assert.equal(model.beadState(experiment(), reactions, [{ id: 'r', status: 'succeeded' }]), 'surprised', 'The latest reaction wins');
  assert.equal(model.beadState(experiment('proposed'), [], []), 'planned');
  assert.equal(model.beadState({ id: 'x', kind: 'next', status: 'proposed' }, [], []), 'planned');
  assert.equal(model.beadState(experiment(), [], [{ id: 'r', status: 'imported' }]), 'plain', 'Imported history has no recorded reaction');

  const runs = [{ id: 'r1', status: 'succeeded', origin: 'managed' }, { id: 'r2', status: 'failed', origin: 'managed' },
    { id: 'r3', status: 'running', origin: 'managed' }, { id: 'r4', status: 'imported', origin: 'imported' }];
  const pending = model.awaitingReaction([entry('reaction', { outcome: 'mixed', run_id: 'r1' })], runs);
  assert.deepEqual(pending.map(r => r.id), ['r2']);

  // The state the researcher picks is the state shown.
  assert.equal(model.beadState(experiment('active'), [], []), 'running', 'An active experiment reads as in progress');
  assert.equal(model.beadState(experiment('paused'), [], []), 'paused');
  assert.equal(model.beadState(experiment('active'), reactions, [{ id: 'r', status: 'succeeded' }]), 'running', 'Reopening hides an old outcome');
  assert.equal(model.beadState(experiment('active'), declined, []), 'running', 'Picking a state after declining overrides the decline');
  // An outcome for the whole experiment answers runs that finished before it, not later ones.
  const judged = [entry('reaction', { outcome: 'expected', n: 5 })];
  const timed = [{ id: 'early', status: 'succeeded', finished_at: at(4) }, { id: 'late', status: 'succeeded', finished_at: at(6) },
    { id: 'untimed', status: 'failed' }];
  assert.deepEqual(model.awaitingReaction(judged, timed).map(r => r.id), ['late']);
  assert.deepEqual(model.awaitingReaction([], timed).map(r => r.id), ['early', 'late', 'untimed'], 'Runs without a finish time still wait');
  const grouped = model.byNode([{ node_id: 'a', created_at: at(2) }, { node_id: 'b', created_at: at(1) }, { node_id: 'a', created_at: at(1) }]);
  assert.deepEqual(grouped.get('a').map(e => e.created_at), [at(1), at(2)]);
  assert.equal(model.label({ kind: 'reaction', outcome: 'surprised', author: 'human', decision: null, via: 'app' }), '你的原话 · 结果反应 · 与预期不符');
  assert.equal(model.label({ kind: 'intent', author: 'human', via: 'cli' }), '你的原话（经 Agent 转录） · 为什么');
  assert.equal(model.label({ kind: 'note', author: 'agent', via: 'cli' }), 'Agent · 随记');
  const finished = [{ id: 'r', status: 'succeeded', finished_at: at(5) }];
  assert.equal(model.isHindsight({ kind: 'expectation', created_at: at(6) }, finished), true);
  assert.equal(model.isHindsight({ kind: 'expectation', created_at: at(4) }, finished), false);
  assert.equal(model.isHindsight({ kind: 'note', created_at: at(6) }, finished), false);
  assert.equal(model.isHindsight({ kind: 'intent', created_at: at(6) }, [{ id: 'r', status: 'running', finished_at: null }]), false);
}

console.log('Thread map passed: one line per question, lane reuse, forks, merges, bounded labels and recorded bead states.');
