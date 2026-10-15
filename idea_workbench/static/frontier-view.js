(() => {
  'use strict';

  // The "next step" panel: what waits on the researcher right now, across canvases.
  const RUN_STATUSES = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', interrupted: '已中断' };
  const SECTIONS = [
    { key: 'awaiting_decision', title: '待你决定', focus: 'decision', meta: item => `Agent：${item.rationale}` },
    { key: 'awaiting_reaction', title: '结果回来了', focus: 'reaction', meta: item => `${item.run_id} · ${RUN_STATUSES[item.status] || item.status}` },
    { key: 'running', title: '运行中', focus: null, meta: item => `${item.run_id} · ${RUN_STATUSES[item.status] || item.status}` },
    { key: 'recent_surprises', title: '最近与预期不符', focus: null, meta: item => item.text || '（未写文字）' },
    { key: 'planned', title: '计划中', focus: null, meta: () => '' },
  ];

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function create({ container, countBadge, onOpen }) {
    let signature = '';

    function item(section, entry, canvasById, currentCanvasId) {
      const button = el('button', 'frontier-item');
      button.type = 'button';
      button.dataset.nodeId = entry.node_id;
      const meta = [section.meta(entry), entry.canvas_id !== currentCanvasId ? canvasById.get(entry.canvas_id)?.title : '']
        .filter(Boolean).join(' · ');
      button.append(el('span', 'frontier-title', entry.title));
      if (meta) button.append(el('span', 'frontier-meta', meta));
      button.addEventListener('click', () => onOpen(entry.node_id, section.focus));
      const row = el('li');
      row.append(button);
      return row;
    }

    function render(frontier, canvasById, currentCanvasId) {
      if (!frontier) return;
      const next = JSON.stringify([frontier, currentCanvasId, [...canvasById].map(([id, canvas]) => [id, canvas.title])]);
      if (next === signature) return;
      signature = next;
      const fragment = document.createDocumentFragment();
      for (const section of SECTIONS) {
        const items = frontier[section.key] || [];
        if (!items.length) continue;
        const block = el('section', 'frontier-section');
        block.dataset.section = section.key;
        const heading = el('h3', '', section.title);
        heading.append(el('span', 'count-badge', items.length));
        const list = el('ul', 'frontier-items');
        items.forEach(entry => list.append(item(section, entry, canvasById, currentCanvasId)));
        block.append(heading, list);
        fragment.append(block);
      }
      if (!fragment.childNodes.length) {
        fragment.append(el('p', 'muted small frontier-empty',
          '现在没有等你处理的事。让 Agent 用 propose 提出下一步，或者在任意节点上随手记一句。'));
      }
      container.replaceChildren(fragment);
      const waiting = (frontier.awaiting_decision?.length || 0) + (frontier.awaiting_reaction?.length || 0);
      countBadge.textContent = waiting ? String(waiting) : '';
      countBadge.hidden = !waiting;
    }

    return { render };
  }

  window.FrontierView = { create };
})();
