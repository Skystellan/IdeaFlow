(() => {
  'use strict';

  // Thread map: each question is a horizontal thread of beads; forks start new threads.
  // x is the step along the dependency order, so a chain grows sideways, never downward.
  // Lanes freed by finished threads are reused, so height follows concurrent questions.
  const COL = 84, LANE = 112, MARGIN_X = 64, MARGIN_TOP = 72, BOTTOM = 72, LABEL_MAX = 360;
  const ALIVE = new Set(['active', 'proposed']);

  function order(byId, incoming, outgoing) {
    const key = id => `${byId.get(id).created_at || ''}\u0000${id}`;
    const compare = (a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0;
    const degree = new Map([...byId.keys()].map(id => [id, incoming.get(id).length]));
    const ready = [...byId.keys()].filter(id => !degree.get(id)).sort(compare);
    const insert = id => {
      let low = 0, high = ready.length;
      while (low < high) { const mid = (low + high) >> 1; if (compare(ready[mid], id) < 0) low = mid + 1; else high = mid; }
      ready.splice(low, 0, id);
    };
    const result = [];
    while (ready.length) {
      const id = ready.shift();
      result.push(id);
      for (const target of outgoing.get(id)) {
        degree.set(target, degree.get(target) - 1);
        if (!degree.get(target)) insert(target);
      }
    }
    const placed = new Set(result);
    // Cycles have no topological order; keep every record visible after the rest.
    const leftovers = [...byId.keys()].filter(id => !placed.has(id)).sort(compare);
    return { ids: [...result, ...leftovers], cyclic: leftovers.length > 0 };
  }

  function buildThreads(ids, byId, incoming, index) {
    const threadOf = new Map(), threads = [], links = [];
    for (const id of ids) {
      const parents = incoming.get(id).filter(p => threadOf.has(p)).sort((a, b) => index.get(a) - index.get(b));
      let thread = null;
      if (byId.get(id).kind !== 'idea') {
        const parent = parents.find(p => threadOf.get(p).members.at(-1) === p);
        thread = parent ? threadOf.get(parent) : null;
      }
      if (!thread) {
        thread = { id, head: id, from: parents[0] ?? null, members: [] };
        threads.push(thread);
      }
      thread.members.push(id);
      threadOf.set(id, thread);
      const previous = thread.members.at(-2);
      for (const parent of parents) {
        if (parent === previous) continue;
        links.push({ source: parent, target: id, kind: thread.head === id && parent === thread.from ? 'fork' : 'merge' });
      }
    }
    return { threadOf, threads, links };
  }

  function assignColumns(ids, incoming, threadOf) {
    const col = new Map();
    for (const id of ids) {
      const members = threadOf.get(id).members, previous = members[members.indexOf(id) - 1];
      const parents = incoming.get(id).filter(p => col.has(p)).map(p => col.get(p));
      let column = parents.length ? Math.max(...parents) + 1 : 0;
      if (previous !== undefined) column = Math.max(column, col.get(previous) + 1);
      col.set(id, column);
    }
    return col;
  }

  function assignLanes(threads, threadOf, index) {
    const laneEnds = [];
    const sorted = [...threads].sort((a, b) => a.start - b.start || index.get(a.head) - index.get(b.head));
    for (const thread of sorted) {
      const parentLane = thread.from ? threadOf.get(thread.from).lane ?? 0 : 0;
      // One empty column separates threads that share a lane.
      const free = laneEnds.map((end, lane) => end + 1 < thread.start ? lane : -1).filter(lane => lane >= 0);
      free.sort((a, b) => (a < parentLane) - (b < parentLane) || Math.abs(a - parentLane) - Math.abs(b - parentLane) || a - b);
      thread.lane = free.length ? free[0] : laneEnds.length;
      laneEnds[thread.lane] = thread.end;
    }
    for (const thread of threads) {
      const next = threads.filter(t => t.lane === thread.lane && t.start > thread.start)
        .reduce((nearest, t) => !nearest || t.start < nearest.start ? t : nearest, null);
      thread.labelWidth = next ? (next.start - thread.start) * COL - 20 : LABEL_MAX;
    }
    return laneEnds.length;
  }

  function layoutThreads(nodes = [], edges = []) {
    const byId = new Map(nodes.filter(n => n && n.id != null).map(n => [n.id, n]));
    const incoming = new Map([...byId.keys()].map(id => [id, []]));
    const outgoing = new Map([...byId.keys()].map(id => [id, []]));
    for (const edge of edges) {
      if (!edge || !byId.has(edge.source) || !byId.has(edge.target) || edge.source === edge.target) continue;
      if (incoming.get(edge.target).includes(edge.source)) continue;
      incoming.get(edge.target).push(edge.source);
      outgoing.get(edge.source).push(edge.target);
    }
    const { ids, cyclic } = order(byId, incoming, outgoing);
    const index = new Map(ids.map((id, i) => [id, i]));
    const { threadOf, threads, links } = buildThreads(ids, byId, incoming, index);
    const col = assignColumns(ids, incoming, threadOf);
    for (const thread of threads) {
      thread.start = col.get(thread.head);
      thread.end = Math.max(...thread.members.map(id => col.get(id)));
      thread.alive = thread.members.some(id => ALIVE.has(byId.get(id).status));
    }
    const lanes = assignLanes(threads, threadOf, index);
    const beads = new Map(ids.map(id => {
      const thread = threadOf.get(id);
      return [id, { col: col.get(id), lane: thread.lane, thread: thread.id,
        x: MARGIN_X + col.get(id) * COL, y: MARGIN_TOP + thread.lane * LANE }];
    }));
    const columns = ids.length ? Math.max(...col.values()) + 1 : 0;
    // Leave room for the widest label that has no later thread to stop it.
    const labelEdge = Math.max(0, ...threads.map(t => MARGIN_X + t.start * COL - 10 + t.labelWidth));
    return { threads, beads, links, lanes, cyclic,
      width: ids.length ? Math.max(MARGIN_X * 2 + (columns - 1) * COL + COL * 2, labelEdge + 16) : 0,
      height: ids.length ? MARGIN_TOP + (lanes - 1) * LANE + BOTTOM : 0 };
  }

  // Orthogonal polyline with rounded corners, written with M/L/Q only.
  function rounded(points, radius = 12) {
    const kept = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
    let d = `M ${kept[0].x} ${kept[0].y}`;
    for (let i = 1; i < kept.length - 1; i++) {
      const [a, b, c] = [kept[i - 1], kept[i], kept[i + 1]];
      const into = Math.hypot(b.x - a.x, b.y - a.y), out = Math.hypot(c.x - b.x, c.y - b.y);
      const r = Math.min(radius, into / 2, out / 2);
      d += ` L ${b.x - (b.x - a.x) / into * r} ${b.y - (b.y - a.y) / into * r}`
        + ` Q ${b.x} ${b.y} ${b.x + (c.x - b.x) / out * r} ${b.y + (c.y - b.y) / out * r}`;
    }
    const last = kept.at(-1);
    return `${d} L ${last.x} ${last.y}`;
  }

  // Adjacent columns: a metro elbow halfway between them. Longer spans leave the source
  // lane at once and travel in the empty gap beside the target lane, so a link never runs
  // over the beads it skips.
  function linkPath(from, to) {
    const end = to.x - 11;
    if (to.x - from.x <= COL) {
      if (from.y === to.y) return `M ${from.x} ${from.y} H ${end}`;
      const turn = to.x - COL / 2;
      return rounded([from, { x: turn, y: from.y }, { x: turn, y: to.y }, { x: end, y: to.y }]);
    }
    const gap = to.y + (to.y > from.y ? -LANE / 2 : LANE / 2), leave = from.x + COL / 2, enter = to.x - COL / 2;
    return rounded([from, { x: leave, y: from.y }, { x: leave, y: gap }, { x: enter, y: gap }, { x: enter, y: to.y }, { x: end, y: to.y }]);
  }

  const api = { COL, LANE, layoutThreads, linkPath };
  if (typeof window !== 'undefined') window.ThreadLayout = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
