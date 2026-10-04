(() => {
  'use strict';

  const NODE_WIDTH = 240, NODE_HEIGHT = 132;
  const COLUMN_GAP = 72, ROW_GAP = 80, MARGIN = 48;
  const compareId = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const finite = p => p && Number.isFinite(p.x) && Number.isFinite(p.y);

  function bounds(positions) {
    const points = [...positions.values()].filter(finite);
    if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
    const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
    return { x, y, width: Math.max(...points.map(p => p.x)) + NODE_WIDTH - x,
      height: Math.max(...points.map(p => p.y)) + NODE_HEIGHT - y };
  }

  function layout(nodes = [], edges = []) {
    const byId = new Map(nodes.filter(n => n && n.id != null).map(n => [n.id, n]));
    const ids = [...byId.keys()].sort(compareId);
    const incoming = new Map(ids.map(id => [id, []]));
    const outgoing = new Map(ids.map(id => [id, []]));
    for (const edge of edges) {
      if (!edge || !byId.has(edge.source) || !byId.has(edge.target)) continue;
      incoming.get(edge.target).push(edge.source);
      outgoing.get(edge.source).push(edge.target);
    }
    const degree = new Map(ids.map(id => [id, incoming.get(id).length]));
    const ranks = new Map(ids.map(id => [id, 0]));
    const queue = ids.filter(id => !degree.get(id));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const target of outgoing.get(id).sort(compareId)) {
        ranks.set(target, Math.max(ranks.get(target), ranks.get(id) + 1));
        degree.set(target, degree.get(target) - 1);
        if (!degree.get(target)) queue.push(target);
      }
    }
    const cyclic = queue.length !== ids.length;
    if (cyclic) {
      // Preserve every card even when malformed cycles have no topological order.
      let rank = Math.max(0, ...ranks.values()) + 1;
      for (const id of ids) if (degree.get(id)) ranks.set(id, rank++);
    }

    const branches = new Map();
    for (const id of ids) {
      const node = byId.get(id), owner = node.kind === 'idea' ? id : node.idea_id ?? id;
      if (!branches.has(owner)) branches.set(owner, new Map());
      const layers = branches.get(owner), rank = ranks.get(id);
      if (!layers.has(rank)) layers.set(rank, []);
      layers.get(rank).push(id);
    }
    const ordered = [...branches].sort((a, b) =>
      Math.min(...a[1].keys()) - Math.min(...b[1].keys()) || compareId(a[0], b[0]));
    const positions = new Map();
    let left = MARGIN;
    for (const [, layers] of ordered) {
      // A branch reserves only its busiest rank's width, not one lane per record.
      for (const [rank, layer] of [...layers].sort((a, b) => a[0] - b[0])) {
        const parentX = id => {
          const parents = incoming.get(id).map(parent => positions.get(parent)).filter(Boolean);
          return parents.length ? parents.reduce((sum, p) => sum + p.x, 0) / parents.length : left;
        };
        layer.sort((a, b) => parentX(a) - parentX(b) || compareId(a, b));
        layer.forEach((id, column) => positions.set(id, {
          x: left + column * (NODE_WIDTH + COLUMN_GAP),
          y: MARGIN + rank * (NODE_HEIGHT + ROW_GAP), rank,
        }));
      }
      left += Math.max(...[...layers.values()].map(layer => layer.length)) * (NODE_WIDTH + COLUMN_GAP);
    }
    const box = bounds(positions);
    return { positions, width: positions.size ? box.x + box.width + MARGIN : 0,
      height: positions.size ? box.y + box.height + MARGIN : 0, cyclic };
  }

  // Port ordering follows the current opposite endpoints, including after dragging.
  function portOffset(edge, positions, edges, source, vertical) {
    const own = source ? 'source' : 'target', other = source ? 'target' : 'source';
    const axis = vertical ? 'x' : 'y', size = vertical ? NODE_WIDTH : NODE_HEIGHT;
    const peers = edges.filter(e => e && e[own] === edge[own] && finite(positions.get(e[other])));
    if (!peers.some(e => e.source === edge.source && e.target === edge.target)) peers.push(edge);
    peers.sort((a, b) => positions.get(a[other])[axis] - positions.get(b[other])[axis]
      || compareId(a[other], b[other]));
    let index = peers.indexOf(edge);
    if (index < 0) index = peers.findIndex(e => e.source === edge.source && e.target === edge.target);
    return (index - (peers.length - 1) / 2) * Math.min(18, (size - 48) / Math.max(1, peers.length - 1));
  }

  function curvePath(segments, xy) {
    return `M ${xy(segments[0][0])}` + segments.map(([, a, b, end]) =>
      ` C ${xy(a)} ${xy(b)} ${xy(end)}`).join('');
  }

  function curveBlocked(segments, rectangles) {
    for (const [start, a, b, end] of segments) {
      // Bound each sample's length so a thin/nearby card cannot hide between samples.
      const length = Math.hypot(a.u - start.u, a.v - start.v)
        + Math.hypot(b.u - a.u, b.v - a.v) + Math.hypot(end.u - b.u, end.v - b.v);
      const steps = Math.max(12, Math.ceil(length / 8));
      let previous = start;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps, q = 1 - t;
        const point = {
          u: q ** 3 * start.u + 3 * q * q * t * a.u + 3 * q * t * t * b.u + t ** 3 * end.u,
          v: q ** 3 * start.v + 3 * q * q * t * a.v + 3 * q * t * t * b.v + t ** 3 * end.v,
        };
        if (rectangles.some(r => segmentIntersectsRect(
          { x: previous.u, y: previous.v }, { x: point.u, y: point.v }, r))) return true;
        previous = point;
      }
    }
    return false;
  }

  function routeEdge(edge, positions, edges = []) {
    if (!edge) return '';
    const from = positions.get(edge.source), to = positions.get(edge.target);
    if (!finite(from) || !finite(to)) return '';
    // Work in travel coordinates: v points toward the target; u crosses the lanes.
    // This makes upward and sideways dragged edges use the same routing logic.
    const vertical = Math.abs(to.y - from.y) >= NODE_HEIGHT + 12 || Math.abs(to.x - from.x) < NODE_WIDTH + 12;
    const sign = (vertical ? to.y - from.y : to.x - from.x) < 0 ? -1 : 1;
    const size = vertical ? NODE_WIDTH : NODE_HEIGHT;
    const xy = p => vertical ? `${p.u} ${p.v * sign}` : `${p.v * sign} ${p.u}`;
    const rectangles = [...positions].filter(([, p]) => finite(p)).map(([id, p]) => {
      const u = vertical ? p.x : p.y, v = vertical ? p.y : p.x;
      const length = vertical ? NODE_HEIGHT : NODE_WIDTH;
      return { id, left: u, right: u + size, top: sign > 0 ? v : -v - length,
        bottom: sign > 0 ? v + length : -v };
    });
    const source = rectangles.find(r => r.id === edge.source), target = rectangles.find(r => r.id === edge.target);
    const start = { u: source.left + size / 2 + portOffset(edge, positions, edges, true, vertical), v: source.bottom };
    const end = { u: target.left + size / 2 + portOffset(edge, positions, edges, false, vertical), v: target.top };
    const unrelated = rectangles.filter(r => r.id !== edge.source && r.id !== edge.target);
    const distance = end.v - start.v;
    const bend = Math.min(96, Math.max(24, distance / 2));
    const direct = [[start, { u: start.u, v: start.v + bend }, { u: end.u, v: end.v - bend }, end]];
    // Test the curve itself, not its bounding box: nearby cards need not force a detour.
    if (distance > 0 && !curveBlocked(direct, unrelated)) return curvePath(direct, xy);

    const axis = vertical ? 'x' : 'y';
    const peers = edges.filter(e => finite(positions.get(e.source)) && finite(positions.get(e.target))
      && positions.get(e.target)[axis] === to[axis]).slice().sort((a, b) =>
      compareId(a.source, b.source) || compareId(a.target, b.target));
    const lane = peers.findIndex(e => e.source === edge.source && e.target === edge.target);
    const offset = lane < 0 ? 0 : (lane - (peers.length - 1) / 2) * Math.min(10, 28 / Math.max(1, peers.length - 1));
    // Only cards between the endpoints can require a bypass. Distant branches must
    // not push a connection out to the edge of the whole canvas.
    const local = rectangles.filter(r => r.bottom >= Math.min(start.v, end.v) - 32
      && r.top <= Math.max(start.v, end.v) + 32);
    const candidates = new Set([start.u, end.u, (start.u + end.u) / 2]);
    for (const r of local) { candidates.add(r.left - 32 + offset); candidates.add(r.right + 32 + offset); }
    const corridors = [...candidates].sort((a, b) =>
      Math.abs(start.u - a) + Math.abs(end.u - a) - Math.abs(start.u - b) - Math.abs(end.u - b) || a - b);
    // Shrink only the endpoint cards slightly so touching their ports is allowed.
    const obstacles = rectangles.map(r => r === source || r === target
      ? { left: r.left + .1, right: r.right - .1, top: r.top + .1, bottom: r.bottom - .1 }
      : { left: r.left - 6, right: r.right + 6, top: r.top - 6, bottom: r.bottom + 6 });
    for (const u of corridors) {
      // ponytail: one local corridor, with broad curves shortened only to clear cards;
      // dense interlocking obstacles would require a multi-corridor router.
      const turns = distance > 0 ? [distance / 2, distance / 3, distance / 5, Math.min(26, distance / 3)] : [26];
      for (const turn of turns) {
        const a = { u, v: start.v + turn }, b = { u, v: end.v - turn };
        const segments = [
          [start, { u: start.u, v: start.v + turn / 2 }, { u, v: start.v + turn / 2 }, a],
          [a, { u, v: a.v + (b.v - a.v) / 3 }, { u, v: b.v - (b.v - a.v) / 3 }, b],
          [b, { u, v: end.v - turn / 2 }, { u: end.u, v: end.v - turn / 2 }, end],
        ];
        if (!curveBlocked(segments, obstacles)) return curvePath(segments, xy);
      }
    }
    // Overlapping manually placed cards can make a clear route impossible. Keep
    // the connection local until the cards move apart instead of adding a huge rail.
    return curvePath(direct, xy);
  }

  // Clip a line segment against a selection rectangle, including border touches.
  function segmentIntersectsRect(a, b, rect) {
    let start = 0, end = 1;
    for (const [axis, min, max] of [['x', rect.left, rect.right], ['y', rect.top, rect.bottom]]) {
      const delta = b[axis] - a[axis];
      if (delta === 0) { if (a[axis] < min || a[axis] > max) return false; continue; }
      const first = (min - a[axis]) / delta, last = (max - a[axis]) / delta;
      start = Math.max(start, Math.min(first, last));
      end = Math.min(end, Math.max(first, last));
      if (start > end) return false;
    }
    return true;
  }

  const api = { NODE_WIDTH, NODE_HEIGHT, layout, routeEdge, bounds, segmentIntersectsRect };
  if (typeof window !== 'undefined') window.ResearchGraph = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
