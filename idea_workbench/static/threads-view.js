(() => {
  'use strict';

  // Draws the thread map into the canvas layers the app already pans and zooms.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const TENTATIVE = new Set(['planned', 'awaiting', 'declined']);

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function path(d, className, extra = {}) {
    const element = document.createElementNS(SVG_NS, 'path');
    element.setAttribute('d', d);
    element.setAttribute('class', className);
    for (const [key, value] of Object.entries(extra)) element.setAttribute(key, value);
    return element;
  }

  function place(element, x, y) {
    element.style.left = `${x}px`;
    element.style.top = `${y}px`;
    return element;
  }

  function groupRuns(runs) {
    const groups = new Map();
    for (const run of runs) {
      if (!groups.has(run.experiment_id)) groups.set(run.experiment_id, []);
      groups.get(run.experiment_id).push(run);
    }
    return groups;
  }

  function bead(node, state, point, isHead, onSelect) {
    const { STATE_LABELS } = window.JournalModel;
    const button = place(el('button', 'thread-bead'), point.x, point.y);
    button.type = 'button';
    button.dataset.nodeId = node.id;
    button.dataset.state = state;
    button.dataset.kind = ['idea', 'insight'].includes(node.kind) ? 'thought' : 'experiment';
    button.title = `${node.title}\n${STATE_LABELS[state]}`;
    button.setAttribute('aria-label', `${node.title}：${STATE_LABELS[state]}`);
    button.append(el('span', 'bead-mark'));
    if (!isHead) button.append(el('span', 'bead-label', node.title));
    button.addEventListener('click', () => onSelect(node.id));
    return button;
  }

  function threadLabel(thread, node, point, onSelect) {
    const label = place(el('button', 'thread-label', node.title), point.x - 10, point.y - 40);
    label.type = 'button';
    label.dataset.alive = String(thread.alive);
    label.style.maxWidth = `${thread.labelWidth}px`;
    label.title = node.title;
    label.setAttribute('aria-label', `研究线程：${node.title}${thread.alive ? '' : '（已结束或暂停）'}`);
    label.addEventListener('click', () => onSelect(node.id));
    return label;
  }

  function render({ nodes, edges, entries, runs, nodeLayer, edgeLayer, onSelect }) {
    const { layoutThreads, linkPath } = window.ThreadLayout;
    const { byNode, beadState } = window.JournalModel;
    const layout = layoutThreads(nodes, edges);
    const journal = byNode(entries), runsByNode = groupRuns(runs);
    const byId = new Map(nodes.map(node => [node.id, node]));
    const states = new Map(nodes.map(node => [node.id, beadState(node, journal.get(node.id) || [], runsByNode.get(node.id) || [])]));
    const beads = document.createDocumentFragment(), lines = document.createDocumentFragment();
    const buttons = new Map();

    for (const thread of layout.threads) {
      const head = layout.beads.get(thread.head);
      thread.members.slice(1).forEach((id, i) => {
        const from = layout.beads.get(thread.members[i]), to = layout.beads.get(id);
        const tentative = TENTATIVE.has(states.get(id)) ? ' is-tentative' : '';
        lines.append(path(`M ${from.x} ${from.y} H ${to.x}`, `thread-line${thread.alive ? ' is-alive' : ''}${tentative}`));
      });
      beads.append(threadLabel(thread, byId.get(thread.head), head, onSelect));
    }
    for (const link of layout.links) {
      const surprise = states.get(link.source) === 'surprised' ? ' is-surprise' : '';
      lines.append(path(linkPath(layout.beads.get(link.source), layout.beads.get(link.target)),
        `thread-link is-${link.kind}${surprise}`, link.kind === 'fork' ? { 'marker-end': 'url(#edge-arrow)' } : {}));
    }
    const heads = new Set(layout.threads.map(thread => thread.head));
    for (const [id, point] of layout.beads) {
      const button = bead(byId.get(id), states.get(id), point, heads.has(id), onSelect);
      buttons.set(id, button);
      beads.append(button);
    }
    nodeLayer.replaceChildren(beads);
    edgeLayer.replaceChildren(lines);
    return { buttons, centers: layout.beads, width: layout.width, height: layout.height, cyclic: layout.cyclic };
  }

  window.ThreadsView = { render };
})();
