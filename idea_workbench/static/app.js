(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const KINDS = { idea: '想法', experiment: '实验', insight: '想法', next: '实验' };
  const STATUSES = { active: '进行中', paused: '已暂停', done: '已完成', proposed: '待验证' };
  const RUN_STATUSES = { queued: '排队中', running: '运行中', succeeded: '成功', failed: '失败', interrupted: '已中断', imported: '已导入' };
  const RELATIONS = { continues: '延续', fork: '分叉', synthesis: '汇合' };
  const STORAGE_KEY = 'idea-workbench-ui-v1';
  const desktop = Boolean(window.workbenchDesktop);
  const Graph = window.ResearchGraph;
  let camera = { x: 0, y: 0, scale: 1 };
  let positions = new Map();
  let manualPositions = new Map();
  let visibleEdges = [];
  let viewKey = '', canvasId = '';
  let viewRestored = false, spacePressed = false;
  let gesture = null, viewSaveTimer;
  const SVG_NS = 'http://www.w3.org/2000/svg';
  let saved = {};
  try { saved = JSON.parse((desktop ? localStorage : sessionStorage).getItem(STORAGE_KEY) || '{}') || {}; } catch { /* Storage can be disabled. */ }
  let state = null;
  let stateRevision = 0;
  let nodeById = new Map();
  let canvasById = new Map();
  let incoming = new Map();
  let outgoing = new Map();
  // Reopening the app starts with an unobstructed canvas; drafts are still restored.
  let selectedId = null;
  let selectedRunId = '';
  let draft = saved.draft && ['create', 'edit'].includes(saved.draft.mode) ? saved.draft : null;
  let pane = 'record';
  let graphSignature = '';
  let detailSignature = '';
  let runsSignature = '';
  let refreshPromise = null;
  let saving = false;
  let statusSaving = false;
  let pollTimer;
  let contextRequest = 0;
  let artifactRequest = 0;
  let runRequest = 0;
  let compareRequest = 0;
  let contextVersion = '';
  let canvasListSignature = '';
  let feedbackTimer;
  let resizeGesture = null;
  let detailWidth = 420;
  try { detailWidth = Number(localStorage.getItem('ideaflow-detail-width')) || 420; } catch { /* Optional view preference. */ }
  let connectionSource = null, connectionTarget = null;
  let edgeSaving = false, canvasSaving = false;
  const nodeButtons = new Map();
  const edgePaths = [];
  const selectedNodes = new Set(), selectedEdges = new Set();
  const edgeKey = edge => JSON.stringify([edge.source, edge.target]);
  let pendingDeletion = null;

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function message(element, text, error = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle('error', error);
    if (element.id === 'feedback') {
      clearTimeout(feedbackTimer);
      if (text) feedbackTimer = setTimeout(() => { element.hidden = true; }, 5000);
    }
  }

  function remember() {
    try { (desktop ? localStorage : sessionStorage).setItem(STORAGE_KEY, JSON.stringify({ selectedId, selectedRunId, draft })); }
    catch { if (draft && $('node-dialog').open) $('form-draft-note').textContent = '浏览器存储不可用；草稿仅在当前页面保留，请勿刷新。'; }
    $('resume-draft').hidden = !draft;
  }

  function fmt(value) {
    return value === null || value === undefined ? '未记录' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  }

  function date(value) {
    if (!value) return '未记录';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString('zh-CN', { hour12: false });
  }

  function nodeName(id) {
    const node = nodeById.get(id);
    return node ? `${KINDS[node.kind]} · ${node.title}` : `未找到节点 ${id}`;
  }

  function ownerId(node) { return node.canvas_id; }
  function runLabel(run) { return `${run.id} · ${RUN_STATUSES[run.status] || run.status} · ${nodeById.get(run.experiment_id)?.title || run.experiment_id}`; }

  async function api(path, options = {}) {
    const headers = { Accept: 'application/json', ...options.headers };
    if (options.method && options.method !== 'GET') {
      if (!state?.csrf_token) throw new Error('尚未取得写入令牌。请刷新连接后重试，草稿会保留。');
      headers['Content-Type'] = 'application/json';
      headers['X-Idea-Token'] = state.csrf_token;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(path, { ...options, headers, signal: controller.signal, credentials: 'same-origin', cache: 'no-store' });
      const text = await response.text();
      if (!response.ok) {
        let reason = text;
        try { const data = JSON.parse(text); reason = fmt(data.error?.message ?? data.error ?? data.detail ?? data.message ?? text); } catch { /* Plain-text errors are also supported. */ }
        throw new Error(`请求失败（${response.status}）：${reason || response.statusText}`);
      }
      if (options.asText) return text;
      try { return JSON.parse(text); } catch { throw new Error('服务返回了无效 JSON，请检查本地服务。'); }
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('请求超时，请检查本地服务后重试。');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  function indexState() {
    nodeById = new Map(state.nodes.map(node => [node.id, node]));
    canvasById = new Map(state.canvases.map(canvas => [canvas.id, canvas]));
    incoming = new Map(state.nodes.map(node => [node.id, []]));
    outgoing = new Map(state.nodes.map(node => [node.id, []]));
    for (const edge of state.edges) {
      if (!nodeById.has(edge.source) || !nodeById.has(edge.target)) continue;
      incoming.get(edge.target).push(edge);
      outgoing.get(edge.source).push(edge);
    }
  }

  function ancestors(id) {
    const ids = new Set();
    const queue = id ? [id] : [];
    while (queue.length) {
      const current = queue.pop();
      if (ids.has(current)) continue;
      ids.add(current);
      for (const edge of incoming.get(current) || []) queue.push(edge.source);
    }
    return ids;
  }

  function loadGraphView() {
    const prefix = `ideaflow-canvases-v2:${state.project.root}`;
    if (!canvasId) {
      try { canvasId = localStorage.getItem(`${prefix}:active`) || ''; } catch { /* Optional view preference. */ }
    }
    if (!canvasById.has(canvasId)) canvasId = state.canvases[0]?.id || '';
    const key = `${prefix}:${canvasId}`;
    if (key === viewKey) return;
    viewKey = key;
    manualPositions = new Map();
    camera = { x: 0, y: 0, scale: 1 };
    viewRestored = false;
    try {
      const data = JSON.parse(localStorage.getItem(key) || '{}');
      for (const [id, point] of Object.entries(data.positions || {})) {
        if (nodeById.has(id) && Number.isFinite(point?.x) && Number.isFinite(point?.y)) manualPositions.set(id, point);
      }
      if (data.camera && ['x', 'y', 'scale'].every(key => Number.isFinite(data.camera[key]))) {
        camera = { ...data.camera, scale: Math.max(.08, Math.min(2.5, data.camera.scale)) };
        viewRestored = true;
      }
    } catch { /* An unavailable or obsolete local view never blocks research records. */ }
    graphSignature = '';
  }

  function rememberView() {
    if (!viewKey) return;
    try {
      localStorage.setItem(viewKey, JSON.stringify({ positions: Object.fromEntries(manualPositions), camera }));
      localStorage.setItem(`ideaflow-canvases-v2:${state.project.root}:active`, canvasId);
      $('layout-status').textContent = desktop ? '布局已保存在此 App' : '布局已保存在此浏览器';
    } catch { $('layout-status').textContent = '浏览器存储不可用，布局仅保留到页面关闭'; }
  }

  function renderCanvases() {
    const canvases = state.canvases;
    $('canvas-title').textContent = canvasById.get(canvasId)?.title || '新建画布';
    $('switch-canvas').title = `切换画布 · ${canvasById.get(canvasId)?.title || '尚无画布'}`;
    $('add-thought').disabled = $('add-experiment').disabled = !canvasId || !state.csrf_token;
    const counts = new Map();
    state.nodes.forEach(node => counts.set(ownerId(node), (counts.get(ownerId(node)) || 0) + 1));
    const signature = JSON.stringify([canvases.map(node => [node.id, node.title, counts.get(node.id)]), canvasId]);
    if (signature === canvasListSignature) return;
    canvasListSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const canvas of canvases) {
      const button = el('button', 'canvas-option');
      button.type = 'button';
      button.dataset.canvasId = canvas.id;
      button.setAttribute('aria-pressed', String(canvas.id === canvasId));
      button.append(el('span', 'canvas-option-title', canvas.title), el('span', 'canvas-option-meta', `${counts.get(canvas.id) || 0} 个节点${canvas.id === canvasId ? ' · 当前画布' : ''}`));
      button.addEventListener('click', () => { $('canvas-dialog').close(); switchCanvas(canvas.id); });
      fragment.append(button);
    }
    if (!canvases.length) fragment.append(el('p', 'muted', '为第一个想法创建画布。'));
    $('canvas-list').replaceChildren(fragment);
  }

  function closeDetails() {
    selectedId = null;
    selectedRunId = '';
    detailSignature = '';
    runsSignature = '';
    runRequest++;
    resetContext();
    resetArtifact();
    $('detail-panel').hidden = $('detail-resizer').hidden = true;
    highlightGraph();
    remember();
  }

  function switchCanvas(id) {
    if (!canvasById.has(id) || id === canvasId || edgeSaving) return;
    cancelConnection();
    clearSelection();
    clearTimeout(viewSaveTimer);
    rememberView();
    closeDetails();
    canvasId = id;
    loadGraphView();
    renderCanvases();
    renderGraph();
    if (!viewRestored) fitGraph();
    rememberView();
  }

  function setDetailWidth(width, persist = false) {
    const maximum = Math.max(320, Math.min(760, window.innerWidth - 300));
    detailWidth = Math.max(320, Math.min(maximum, width));
    document.documentElement.style.setProperty('--detail-width', `${detailWidth}px`);
    $('detail-resizer').setAttribute('aria-valuemax', maximum);
    $('detail-resizer').setAttribute('aria-valuenow', Math.round(detailWidth));
    if (persist) {
      try { localStorage.setItem('ideaflow-detail-width', detailWidth); } catch { /* Optional view preference. */ }
    }
  }

  function positionNodeActions() {
    const node = nodeById.get(selectedId), point = positions.get(selectedId), toolbar = $('node-actions');
    toolbar.hidden = !node || !point || Boolean(connectionSource) || Boolean(selectedNodes.size || selectedEdges.size);
    if (toolbar.hidden) return;
    const statusControl = $('node-status');
    // Reassigning value/disabled closes Chromium's open native select, even when unchanged.
    // Leave an in-progress choice alone while polling or repositioning the toolbar.
    if (!statusSaving && (document.activeElement !== statusControl || statusControl.dataset.statusNodeId !== node.id)) {
      if (statusControl.value !== node.status) statusControl.value = node.status;
    }
    statusControl.dataset.statusNodeId = node.id;
    if (statusControl.disabled !== statusSaving) statusControl.disabled = statusSaving;
    const viewport = $('graph-scroll'), width = toolbar.offsetWidth, height = toolbar.offsetHeight;
    const x = camera.x + (point.x + Graph.NODE_WIDTH / 2) * camera.scale - width / 2;
    let y = camera.y + (point.y + Graph.NODE_HEIGHT) * camera.scale + 18;
    if (y + height > viewport.clientHeight - 76) y = camera.y + point.y * camera.scale - height - 18;
    toolbar.style.left = `${Math.max(12, Math.min(viewport.clientWidth - width - 12, x))}px`;
    toolbar.style.top = `${Math.max(64, Math.min(viewport.clientHeight - height - 76, y))}px`;
  }

  function pinLayout() {
    for (const [id, point] of positions) manualPositions.set(id, { x: point.x, y: point.y });
  }

  function activateNode(id) {
    if (connectionSource) connectNodes(connectionSource, id);
    else selectNode(id);
  }

  function beginConnection(id) {
    if (edgeSaving || !positions.has(id)) return;
    clearSelection();
    connectionSource = id;
    connectionTarget = null;
    $('graph-scroll').classList.add('is-connecting');
    $('connection-hint').hidden = false;
    $('connection-help').textContent = '拖到目标节点，或点击目标完成连线 · Esc 取消';
    positionNodeActions();
  }

  function cancelConnection() {
    connectionSource = connectionTarget = null;
    if (gesture?.link) {
      const pointerId = gesture.pointerId;
      gesture = null;
      if ($('graph-scroll').hasPointerCapture(pointerId)) $('graph-scroll').releasePointerCapture(pointerId);
    }
    $('connection-preview').setAttribute('d', '');
    $('connection-hint').hidden = true;
    $('graph-scroll').classList.remove('is-connecting');
    for (const button of nodeButtons.values()) button.classList.remove('is-connection-target');
    positionNodeActions();
  }

  function startConnection(event, id, port) {
    if (event.metaKey) { startGesture(event); return; }
    event.stopPropagation();
    if (event.button !== 0 || gesture || edgeSaving) return;
    event.preventDefault();
    if (port === 'input') {
      if (connectionSource) connectNodes(connectionSource, id);
      return;
    }
    beginConnection(id);
    gesture = { link: true, pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
    $('graph-scroll').setPointerCapture(event.pointerId);
    updateConnectionPreview(event.clientX, event.clientY);
  }

  function updateConnectionPreview(x, y) {
    const source = positions.get(connectionSource);
    if (!source) return;
    const hovered = document.elementFromPoint(x, y)?.closest('.node-group')?.dataset.nodeId;
    connectionTarget = hovered && hovered !== connectionSource ? hovered : null;
    for (const [id, button] of nodeButtons) button.classList.toggle('is-connection-target', id === connectionTarget);
    const rect = $('graph-scroll').getBoundingClientRect(), target = positions.get(connectionTarget);
    const start = { x: source.x + Graph.NODE_WIDTH / 2, y: source.y + Graph.NODE_HEIGHT };
    const end = target ? { x: target.x + Graph.NODE_WIDTH / 2, y: target.y } : { x: (x - rect.left - camera.x) / camera.scale, y: (y - rect.top - camera.y) / camera.scale };
    const bend = Math.max(40, Math.abs(end.y - start.y) / 2);
    $('connection-preview').setAttribute('d', `M ${start.x} ${start.y} C ${start.x} ${start.y + bend}, ${end.x} ${end.y - bend}, ${end.x} ${end.y}`);
  }

  async function connectNodes(source, target) {
    if (edgeSaving || !source || !target) return;
    if (source === target) { message($('feedback'), '请选择另一个节点作为目标。'); return; }
    pinLayout();
    edgeSaving = true;
    cancelConnection();
    try {
      await api('/api/edges', { method: 'POST', body: JSON.stringify({ source, target }) });
      await refreshAfterWrite();
      message($('feedback'), '连线已保存。');
    } catch (error) { message($('feedback'), `连线未保存：${error.message}`, true); }
    finally {
      edgeSaving = false;
      renderGraph();
      renderDetails();
      rememberView();
    }
  }

  async function removeConnection(edge, button) {
    if (edgeSaving) return;
    edgeSaving = true;
    button.disabled = true;
    pinLayout();
    try {
      await api('/api/edges', { method: 'DELETE', body: JSON.stringify({ source: edge.source, target: edge.target }) });
      await refreshAfterWrite();
      message($('feedback'), '已移除连线，两个节点保留。');
    } catch (error) { message($('feedback'), `无法移除连线：${error.message}`, true); }
    finally { edgeSaving = false; button.disabled = false; renderGraph(); renderDetails(); rememberView(); }
  }

  function clearSelection() {
    selectedNodes.clear();
    selectedEdges.clear();
    highlightGraph();
  }

  function selectEdge(key, additive = false) {
    if (edgeSaving) return;
    cancelConnection();
    if (!additive) clearSelection();
    closeDetails();
    if (additive && selectedEdges.has(key)) selectedEdges.delete(key);
    else selectedEdges.add(key);
    highlightGraph();
  }

  function selectionPayload() {
    return {
      canvas_id: canvasId,
      node_ids: selectedNodes.size ? [...selectedNodes] : selectedId ? [selectedId] : [],
      edges: visibleEdges.filter(edge => selectedEdges.has(edgeKey(edge))).map(({ source, target }) => ({ source, target }))
    };
  }

  function requestDeletion() {
    if (edgeSaving || saving || statusSaving || gesture || connectionSource || $('delete-dialog').open) return;
    const payload = selectionPayload(), ids = new Set(payload.node_ids);
    if (!ids.size && !payload.edges.length) return;
    const edges = state.edges.filter(edge => ids.has(edge.source) || ids.has(edge.target) || selectedEdges.has(edgeKey(edge)));
    const runs = state.runs.filter(run => ids.has(run.experiment_id));
    pendingDeletion = payload;
    $('delete-summary').textContent = `将删除 ${ids.size} 个节点和 ${edges.length} 条连线。` +
      (ids.size ? '节点关联的连线会一并删除，其余节点保留。' : '两端节点保留。') +
      (runs.length ? `\n同时删除 ${runs.length} 条运行记录，磁盘上的实验文件保留。` : '') + '\n删除后无法撤销。';
    message($('delete-error'), '');
    $('delete-dialog').showModal();
  }

  async function deleteSelection() {
    if (!pendingDeletion || edgeSaving) return;
    const payload = pendingDeletion;
    edgeSaving = true;
    $('confirm-delete').disabled = $('cancel-delete').disabled = true;
    pinLayout();
    try {
      const result = await api('/api/selection', { method: 'DELETE', body: JSON.stringify(payload) });
      for (const id of payload.node_ids) manualPositions.delete(id);
      clearSelection();
      if (payload.node_ids.includes(selectedId)) closeDetails();
      if (draft?.mode === 'edit' && payload.node_ids.includes(draft.id)) { draft = null; remember(); }
      pendingDeletion = null;
      $('delete-dialog').close();
      await refreshAfterWrite();
      message($('feedback'), `已删除 ${result.nodes} 个节点、${result.edges} 条连线。`);
      $('graph-scroll').focus({ preventScroll: true });
    } catch (error) { message($('delete-error'), `删除未完成：${error.message}`, true); }
    finally {
      edgeSaving = false;
      $('confirm-delete').disabled = $('cancel-delete').disabled = false;
      renderGraph();
      renderDetails();
      rememberView();
    }
  }

  function updateBoxSelection(x, y) {
    const view = $('graph-scroll').getBoundingClientRect();
    x = Math.max(view.left, Math.min(view.right, x));
    y = Math.max(view.top, Math.min(view.bottom, y));
    const left = Math.min(gesture.x, x) - view.left, top = Math.min(gesture.y, y) - view.top;
    const width = Math.abs(x - gesture.x), height = Math.abs(y - gesture.y);
    Object.assign($('selection-box').style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
    $('selection-box').hidden = false;
    const rect = { left: (left - camera.x) / camera.scale, right: (left + width - camera.x) / camera.scale,
      top: (top - camera.y) / camera.scale, bottom: (top + height - camera.y) / camera.scale };
    selectedNodes.clear();
    selectedEdges.clear();
    for (const [id, point] of positions) {
      if (point.x <= rect.right && point.x + Graph.NODE_WIDTH >= rect.left &&
          point.y <= rect.bottom && point.y + Graph.NODE_HEIGHT >= rect.top) selectedNodes.add(id);
    }
    for (const [key, points] of gesture.edgeSamples) {
      if (points.some((point, i) => i > 0 && Graph.segmentIntersectsRect(points[i - 1], point, rect))) selectedEdges.add(key);
    }
    highlightGraph();
  }

  function applyCamera() {
    $('graph-canvas').style.transform = `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})`;
    $('graph-scroll').style.backgroundSize = `${Math.max(10, 20 * camera.scale)}px ${Math.max(10, 20 * camera.scale)}px`;
    $('graph-scroll').style.backgroundPosition = `${camera.x}px ${camera.y}px`;
    $('zoom-level').textContent = `${Math.round(camera.scale * 100)}%`;
    $('zoom-in').disabled = camera.scale >= 2.5;
    $('zoom-out').disabled = camera.scale <= .08;
    positionNodeActions();
  }

  function zoomAt(scale, x = $('graph-scroll').clientWidth / 2, y = $('graph-scroll').clientHeight / 2) {
    scale = Math.max(.08, Math.min(2.5, scale));
    const ratio = scale / camera.scale;
    camera.x = x - (x - camera.x) * ratio;
    camera.y = y - (y - camera.y) * ratio;
    camera.scale = scale;
    applyCamera();
    clearTimeout(viewSaveTimer);
    viewSaveTimer = setTimeout(rememberView, 180);
  }

  function fitGraph() {
    if (!positions.size) return;
    const bounds = Graph.bounds(positions), viewport = $('graph-scroll');
    camera.scale = Math.max(.08, Math.min(1, (viewport.clientWidth - 80) / bounds.width, (viewport.clientHeight - 160) / bounds.height));
    camera.x = (viewport.clientWidth - bounds.width * camera.scale) / 2 - bounds.x * camera.scale;
    camera.y = (viewport.clientHeight - bounds.height * camera.scale) / 2 - bounds.y * camera.scale;
    applyCamera();
    rememberView();
  }

  function graphNodes() {
    return state.nodes.filter(node => ownerId(node) === canvasId);
  }

  function drawEdges() {
    for (const { edge, path, hit } of edgePaths) {
      const d = Graph.routeEdge(edge, positions, visibleEdges);
      path.setAttribute('d', d);
      hit.setAttribute('d', d);
    }
  }

  function renderGraph() {
    if (gesture || connectionSource || edgeSaving) return; // Keep nodes stable while drawing or saving a connection.
    const signature = JSON.stringify([state.nodes, state.edges, state.runs.map(run => [run.id, run.status]), canvasId]);
    if (signature === graphSignature) { highlightGraph(); return; }
    graphSignature = signature;
    const focusedId = document.activeElement?.dataset.nodeId;
    const nodes = graphNodes(), ids = new Set(nodes.map(node => node.id));
    visibleEdges = state.edges.filter(edge => ids.has(edge.source) && ids.has(edge.target));
    for (const id of selectedNodes) if (!ids.has(id)) selectedNodes.delete(id);
    const edgeKeys = new Set(visibleEdges.map(edgeKey));
    for (const key of selectedEdges) if (!edgeKeys.has(key)) selectedEdges.delete(key);
    const layout = Graph.layout(nodes, visibleEdges);
    positions = layout.positions;
    for (const [id, point] of manualPositions) {
      if (positions.has(id)) Object.assign(positions.get(id), point);
    }
    const missingEdges = state.edges.length - [...incoming.values()].reduce((sum, edges) => sum + edges.length, 0);
    message($('graph-warning'), layout.cyclic ? '记录中存在循环来源，已展开显示；请检查后端来源关系。' : missingEdges ? '部分来源节点缺失，相关连线暂时无法显示。' : '', true);
    const runCounts = new Map();
    state.runs.forEach(run => runCounts.set(run.experiment_id, (runCounts.get(run.experiment_id) || 0) + 1));
    const fragment = document.createDocumentFragment();
    nodeButtons.clear();
    for (const node of nodes) {
      const position = positions.get(node.id);
      const group = el('div', 'node-group');
      group.dataset.nodeId = node.id;
      group.style.left = `${position.x}px`;
      group.style.top = `${position.y}px`;
      const button = el('button', 'graph-node');
      button.type = 'button';
      button.dataset.nodeId = node.id;
      button.dataset.kind = node.kind;
      button.dataset.status = node.status;
      button.dataset.category = ['idea', 'insight'].includes(node.kind) ? 'thought' : 'experiment';
      button.title = `${nodeName(node.id)}\n${STATUSES[node.status]}\n拖动可调整位置 · Alt＋方向键也可移动`;
      button.setAttribute('aria-label', `${KINDS[node.kind]}：${node.title}，${STATUSES[node.status]}`);
      const top = el('span', 'node-top');
      const badge = el('span', 'status-badge', STATUSES[node.status]);
      badge.dataset.status = node.status;
      top.append(el('span', 'kind-tag', KINDS[node.kind]), badge);
      const bottom = el('span', 'node-bottom');
      const crossCanvas = [...incoming.get(node.id), ...outgoing.get(node.id)].some(edge => ownerId(nodeById.get(edge.source)) !== ownerId(nodeById.get(edge.target)));
      bottom.append(el('span', 'node-branch', crossCanvas ? '↗ 关联其他画布' : ''));
      if (runCounts.has(node.id)) bottom.append(el('span', '', `${runCounts.get(node.id)} 次运行`));
      button.append(top, el('span', 'node-title', node.title), bottom);
      button.addEventListener('click', event => { if (event.detail === 0) activateNode(node.id); });
      button.addEventListener('focus', () => {
        const bounds = button.getBoundingClientRect(), view = $('graph-scroll').getBoundingClientRect();
        if (bounds.right < view.left || bounds.left > view.right || bounds.bottom < view.top || bounds.top > view.bottom) centerNode(node.id);
      });
      group.append(button);
      for (const port of ['input', 'output']) {
        const handle = el('button', 'connection-handle');
        handle.type = 'button';
        handle.dataset.nodeId = node.id;
        handle.dataset.port = port;
        handle.setAttribute('aria-label', `${port === 'output' ? '从' : '连接到'} ${node.title}${port === 'output' ? ' 连线' : ''}`);
        handle.title = port === 'output' ? '拖到目标节点，或点击后选择目标 · Esc 取消' : '连线入口';
        handle.addEventListener('pointerdown', event => startConnection(event, node.id, port));
        handle.addEventListener('click', event => {
          if (event.detail !== 0) return;
          if (port === 'output') beginConnection(node.id);
          else if (connectionSource) connectNodes(connectionSource, node.id);
        });
        group.append(handle);
      }
      fragment.append(group);
      nodeButtons.set(node.id, button);
    }
    $('graph-nodes').replaceChildren(fragment);
    const paths = document.createDocumentFragment();
    edgePaths.length = 0;
    for (const edge of visibleEdges) {
      const path = document.createElementNS(SVG_NS, 'path');
      const title = document.createElementNS(SVG_NS, 'title');
      title.textContent = `${nodeById.get(edge.source).title} → ${nodeById.get(edge.target).title}`;
      path.append(title);
      path.setAttribute('aria-hidden', 'true');
      const hit = document.createElementNS(SVG_NS, 'path');
      hit.classList.add('edge-hit');
      hit.dataset.edgeKey = edgeKey(edge);
      hit.setAttribute('role', 'button');
      hit.setAttribute('tabindex', '0');
      hit.setAttribute('aria-label', `连线：${title.textContent}`);
      hit.addEventListener('click', event => { if (event.detail === 0) selectEdge(edgeKey(edge), event.metaKey); });
      hit.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.code === 'Space') { event.preventDefault(); selectEdge(edgeKey(edge), event.metaKey); }
      });
      paths.append(path, hit);
      edgePaths.push({ edge, path, hit });
    }
    $('edge-paths').replaceChildren(paths);
    drawEdges();
    $('graph-canvas').style.width = `${layout.width}px`;
    $('graph-canvas').style.height = `${layout.height}px`;
    $('graph-edges').setAttribute('width', layout.width);
    $('graph-edges').setAttribute('height', layout.height);
    $('empty-graph').hidden = nodes.length > 0;
    $('graph-canvas').hidden = nodes.length === 0;
    $('graph-summary').textContent = `当前画布 ${nodes.length} 个节点 · 项目共 ${state.canvases.length} 个画布 · ${state.runs.length} 次运行`;
    highlightGraph();
    applyCamera();
    if (focusedId) nodeButtons.get(focusedId)?.focus({ preventScroll: true });
  }

  function highlightGraph() {
    const upstream = ancestors(selectedId);
    const active = positions.has(selectedId) && (incoming.get(selectedId)?.length || 0) > 0;
    for (const [id, button] of nodeButtons) {
      button.setAttribute('aria-pressed', String(id === selectedId || selectedNodes.has(id)));
      button.classList.toggle('is-ancestor', upstream.has(id) && id !== selectedId);
    }
    for (const { edge, path, hit } of edgePaths) {
      const traced = upstream.has(edge.source) && upstream.has(edge.target) || edge.source === selectedId;
      const selected = selectedEdges.has(edgeKey(edge));
      path.classList.toggle('is-trace', traced);
      path.classList.toggle('is-selected', selected);
      path.classList.toggle('is-muted', active && !traced);
      path.setAttribute('marker-end', traced || selected ? 'url(#trace-arrow)' : 'url(#edge-arrow)');
      hit.setAttribute('aria-pressed', String(selected));
    }
    $('selection-actions').hidden = !(selectedNodes.size || selectedEdges.size) || Boolean(gesture?.box);
    $('selection-count').textContent = `已选 ${selectedNodes.size} 个节点 · ${selectedEdges.size} 条连线`;
    $('delete-selection').disabled = edgeSaving;
    $('locate-selection').disabled = !selectedId;
    positionNodeActions();
  }

  function centerNode(id) {
    const position = positions.get(id);
    if (!position) return;
    const viewport = $('graph-scroll');
    camera.x = viewport.clientWidth / 2 - (position.x + Graph.NODE_WIDTH / 2) * camera.scale;
    camera.y = (viewport.clientHeight - 44) / 2 - (position.y + Graph.NODE_HEIGHT / 2) * camera.scale;
    applyCamera();
  }

  function locateSelected() {
    if (!selectedId) return;
    camera.scale = Math.max(.8, camera.scale);
    centerNode(selectedId);
    nodeButtons.get(selectedId)?.focus({ preventScroll: true });
    rememberView();
  }

  function selectedPositions(id) {
    const ids = selectedNodes.size && (!id || selectedNodes.has(id)) ? selectedNodes : id ? [id] : [];
    return new Map([...ids].map(key => [key, { ...positions.get(key) }]));
  }

  function moveNodes(origins, dx, dy) {
    for (const [id, origin] of origins) {
      const x = origin.x + dx, y = origin.y + dy;
      Object.assign(positions.get(id), { x, y });
      manualPositions.set(id, { x, y });
      const style = nodeButtons.get(id).parentElement.style;
      style.left = `${x}px`;
      style.top = `${y}px`;
    }
    // Route once after every selected node has reached its new position.
    drawEdges();
    positionNodeActions();
  }

  function startGesture(event) {
    if (event.target.closest('.canvas-controls, .empty-state, .node-actions, .connection-hint, .selection-actions') || !state?.nodes.length) return;
    if (event.target.closest('.connection-handle') && !event.metaKey) return;
    if (event.button !== 0 && event.button !== 1) return;
    if (gesture || edgeSaving) return;
    event.preventDefault();
    const node = event.target.closest('.node-group')?.querySelector('.graph-node');
    const edge = event.target.closest('.edge-hit')?.dataset.edgeKey;
    const id = event.button === 0 && !spacePressed ? node?.dataset.nodeId : null;
    if (event.metaKey && event.button === 0) {
      cancelConnection();
      if (selectedId) selectedNodes.add(selectedId);
      closeDetails();
      const edgeSamples = edgePaths.map(({ edge, path }) => {
        const length = path.getTotalLength(), steps = Math.max(1, Math.ceil(length * camera.scale / 6));
        return [edgeKey(edge), Array.from({ length: steps + 1 }, (_, i) => path.getPointAtLength(length * i / steps))];
      });
      gesture = { box: true, pointerId: event.pointerId, id, edge, x: event.clientX, y: event.clientY, moved: false,
        previousNodes: new Set(selectedNodes), previousEdges: new Set(selectedEdges), edgeSamples };
      $('graph-scroll').setPointerCapture(event.pointerId);
      $('graph-scroll').classList.add('is-selecting');
      $('graph-scroll').focus({ preventScroll: true });
      return;
    }
    if (id && !selectedNodes.has(id)) clearSelection();
    const origins = id ? selectedPositions(id) : new Map();
    gesture = { pointerId: event.pointerId, id, edge, x: event.clientX, y: event.clientY, origin: { ...camera }, origins, moved: false };
    $('graph-scroll').setPointerCapture(event.pointerId);
    $('graph-scroll').classList.add('is-dragging');
    if (id) for (const key of origins.keys()) nodeButtons.get(key).classList.add('is-dragging');
    else $('graph-scroll').focus({ preventScroll: true });
  }

  function updateGesture(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y;
    if (gesture.link) {
      gesture.moved ||= Math.hypot(dx, dy) >= 4;
      updateConnectionPreview(event.clientX, event.clientY);
      return;
    }
    if (!gesture.moved && Math.hypot(dx, dy) < 4) return;
    gesture.moved = true;
    if (gesture.box) { updateBoxSelection(event.clientX, event.clientY); return; }
    if (gesture.id) moveNodes(gesture.origins, dx / camera.scale, dy / camera.scale);
    else {
      camera.x = gesture.origin.x + dx;
      camera.y = gesture.origin.y + dy;
      applyCamera();
    }
  }

  function endGesture(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    const finished = gesture;
    gesture = null;
    $('graph-scroll').classList.remove('is-dragging');
    for (const id of finished.origins?.keys() || []) nodeButtons.get(id)?.classList.remove('is-dragging');
    if ($('graph-scroll').hasPointerCapture(event.pointerId)) $('graph-scroll').releasePointerCapture(event.pointerId);
    if (finished.box) {
      $('selection-box').hidden = true;
      $('graph-scroll').classList.remove('is-selecting');
      if (event.type !== 'pointerup') {
        selectedNodes.clear(); selectedEdges.clear();
        finished.previousNodes.forEach(id => selectedNodes.add(id));
        finished.previousEdges.forEach(key => selectedEdges.add(key));
      } else if (!finished.moved) {
        if (finished.id) {
          if (selectedNodes.has(finished.id)) selectedNodes.delete(finished.id); else selectedNodes.add(finished.id);
        } else if (finished.edge) {
          if (selectedEdges.has(finished.edge)) selectedEdges.delete(finished.edge); else selectedEdges.add(finished.edge);
        } else clearSelection();
      }
      renderGraph();
      return;
    }
    if (finished.link) {
      if (event.type === 'pointerup' && finished.moved && connectionTarget) connectNodes(connectionSource, connectionTarget);
      else if (event.type !== 'pointerup' || finished.moved) cancelConnection();
      return;
    }
    if (event.type === 'pointerup' && finished.id && !finished.moved) {
      activateNode(finished.id);
      nodeButtons.get(finished.id)?.focus({ preventScroll: true });
    } else if (event.type === 'pointerup' && finished.edge && !finished.moved) {
      selectEdge(finished.edge);
    } else if (event.type === 'pointerup' && !finished.id && !finished.moved) {
      cancelConnection();
      clearSelection();
      closeDetails();
    }
    if (finished.moved) rememberView();
    renderGraph();
  }

  function resetContext() {
    contextRequest++;
    contextVersion = '';
    $('context-text').value = '';
    $('copy-context').disabled = true;
    $('generate-context').disabled = false;
    $('generate-context').textContent = '生成 / 更新上下文';
    message($('context-message'), '');
  }

  function resetArtifact() {
    artifactRequest++;
    $('artifact-view').hidden = true;
    $('artifact-text').textContent = '';
    message($('artifact-error'), '');
    document.querySelectorAll('[data-artifact]').forEach(button => button.setAttribute('aria-pressed', 'false'));
  }

  function selectNode(id, locate = false) {
    if (!nodeById.has(id)) return;
    clearSelection();
    const owner = ownerId(nodeById.get(id));
    if (owner !== canvasId) switchCanvas(owner);
    if (id !== selectedId) {
      selectedId = id;
      detailSignature = '';
      runsSignature = '';
      selectedRunId = '';
      runRequest++;
      resetContext();
      resetArtifact();
      message($('node-action-error'), '');
    }
    renderDetails();
    highlightGraph();
    remember();
    if (locate) locateSelected();
    else {
      const bounds = nodeButtons.get(id)?.getBoundingClientRect(), view = $('graph-scroll').getBoundingClientRect();
      if (bounds && (bounds.right > view.right - 12 || bounds.left < view.left || bounds.bottom > view.bottom || bounds.top < view.top)) {
        centerNode(id);
        rememberView();
      }
    }
  }

  function showPane(name) {
    pane = name;
    document.querySelectorAll('[data-pane]').forEach(button => {
      const active = button.dataset.pane === pane;
      button.setAttribute('aria-pressed', String(active));
      $(`pane-${button.dataset.pane}`).hidden = !active;
    });
    if (pane === 'runs') renderRuns();
  }

  function renderRelations(container, edges, source) {
    const fragment = document.createDocumentFragment();
    if (!edges.length) fragment.append(el('p', 'muted small', source ? '研究起点 · 没有上游来源。' : '尚无后续记录。从下方选择下一步。'));
    for (const edge of edges) {
      const id = source ? edge.source : edge.target;
      const item = el('div', 'relation-item');
      const button = el('button', 'relation-link', nodeName(id));
      button.type = 'button';
      button.addEventListener('click', () => selectNode(id, true));
      const node = nodeById.get(id);
      item.append(button, el('p', '', [node && STATUSES[node.status], RELATIONS[edge.relation] || '来源关系'].filter(Boolean).join(' · ')));
      if (edge.reason) item.append(el('p', '', edge.reason));
      const remove = el('button', 'relation-remove', '移除连线');
      remove.type = 'button';
      remove.setAttribute('aria-label', `移除连线：${nodeName(edge.source)} → ${nodeName(edge.target)}`);
      remove.addEventListener('click', () => removeConnection(edge, remove));
      item.append(remove);
      fragment.append(item);
    }
    container.replaceChildren(fragment);
  }

  function renderDetails() {
    const node = nodeById.get(selectedId);
    $('detail-panel').hidden = $('detail-resizer').hidden = !node;
    $('empty-detail').hidden = Boolean(node);
    $('node-detail').hidden = !node;
    if (!node) return;
    const signature = JSON.stringify([node, incoming.get(node.id).map(edge => [edge, nodeById.get(edge.source)]), outgoing.get(node.id).map(edge => [edge, nodeById.get(edge.target)]), canvasById.get(ownerId(node))]);
    if (signature !== detailSignature) {
      detailSignature = signature;
      $('detail-kind').textContent = KINDS[node.kind];
      $('detail-status').textContent = STATUSES[node.status];
      $('detail-status').dataset.status = node.status;
      $('detail-title').textContent = node.title;
      $('detail-id').textContent = node.id;
      $('detail-owner').textContent = `画布：${canvasById.get(ownerId(node))?.title || '未记录'}`;
      $('detail-body').textContent = node.body || '尚未填写详细记录。';
      $('detail-time').textContent = `创建 ${date(node.created_at)} · 更新 ${date(node.updated_at)}`;
      renderRelations($('source-list'), incoming.get(node.id), true);
      renderRelations($('target-list'), outgoing.get(node.id), false);
    }
    renderRuns();
    if (contextVersion && contextVersion !== evidenceSignature()) message($('context-message'), '研究记录或运行已更新。下方保留上次生成的内容，请重新生成以获取最新上下文。');
  }

  function evidenceSignature() {
    const upstream = ancestors(selectedId);
    return JSON.stringify([state.nodes.filter(node => upstream.has(node.id)), state.edges.filter(edge => upstream.has(edge.target)), state.runs.filter(run => upstream.has(run.experiment_id))]);
  }

  function fillSelect(select, items, placeholder, preferred = select.value) {
    const signature = JSON.stringify(items);
    if (select.dataset.options === signature) return;
    select.dataset.options = signature;
    const fragment = document.createDocumentFragment();
    if (placeholder !== null) fragment.append(new Option(placeholder, ''));
    for (const item of items) fragment.append(new Option(item.label, item.value));
    select.replaceChildren(fragment);
    if (items.some(item => item.value === preferred)) select.value = preferred;
    else if (placeholder !== null) select.value = '';
  }

  function renderRuns() {
    const upstream = ancestors(selectedId);
    const runs = state.runs.filter(run => upstream.has(run.experiment_id)).slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    if (!runs.some(run => run.id === selectedRunId)) {
      selectedRunId = runs[0]?.id || '';
      runsSignature = '';
      resetArtifact();
    }
    fillSelect($('run-select'), runs.map(run => ({ value: run.id, label: runLabel(run) })), null, selectedRunId);
    $('run-select').value = selectedRunId;
    $('run-select').disabled = !runs.length;
    $('run-empty').hidden = runs.length > 0;
    $('artifact-section').hidden = !selectedRunId;
    const run = runs.find(item => item.id === selectedRunId);
    const signature = JSON.stringify(run || null);
    if (signature !== runsSignature) {
      runsSignature = signature;
      $('run-content').replaceChildren();
      if (run) renderRun($('run-content'), run);
    }
  }

  function fields(container, rows) {
    const list = el('dl');
    for (const [name, value] of rows) {
      const row = el('div', 'field-row');
      row.append(el('dt', '', name), el('dd', 'mono', fmt(value)));
      list.append(row);
    }
    container.append(list);
  }

  function jsonBlock(container, title, value, empty = '未记录') {
    container.append(el('h4', '', title), el('pre', '', value === null || value === undefined ? empty : fmt(value)));
  }

  function renderRun(container, run) {
    const badge = el('span', 'status-badge', RUN_STATUSES[run.status] || run.status);
    badge.dataset.status = run.status;
    container.append(el('h4', 'mono', run.id), badge);
    fields(container, [
      ['来源', run.origin === 'imported' ? '导入的运行' : '受管理的运行'],
      ['所属实验', nodeName(run.experiment_id)],
      ['创建时间', date(run.created_at)], ['开始时间', date(run.started_at)], ['结束时间', date(run.finished_at)],
      ['退出码', run.exit_code]
    ]);
    if (run.error) container.append(el('p', 'notice error', fmt(run.error)));
    container.append(el('p', 'muted small', '命令仅作记录。由 Codex / CLI 启动实验，本页面不执行命令。'));
    jsonBlock(container, '命令参数列表', run.command);
    jsonBlock(container, '计划参数 · params', run.params);
    jsonBlock(container, '实采参数 · actual_params', run.actual_params, '未记录实采参数；不能将计划参数视为实际使用值。');
    jsonBlock(container, '结果指标 · metrics', run.metrics, '尚未记录指标。运行成功也不意味着研究假设已证实。');
    container.append(el('h4', '', '代码记录'));
    if (!run.snapshot) container.append(el('p', 'notice', '代码未记录（snapshot 为空）。无法确认该运行使用的代码版本，也不能据此断言代码相同。'));
    else {
      fields(container, [['Git commit', run.snapshot.git_commit], ['Git 分支', run.snapshot.git_branch], ['工作区未提交改动', run.snapshot.dirty === null || run.snapshot.dirty === undefined ? null : run.snapshot.dirty ? '有' : '无'], ['快照方式', run.snapshot.method]]);
      const details = el('details');
      const files = run.snapshot.files || [];
      details.append(el('summary', '', `快照文件 · ${files.length} 个`));
      const list = el('ul', 'file-list mono');
      for (const file of files) list.append(el('li', '', `${file.path}\n${fmt(file.size)} 字节 · SHA-256 ${fmt(file.sha256)}`));
      details.append(list);
      container.append(details);
    }
  }

  async function refreshState() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const next = await api('/api/state');
        if (!next.project || !Array.isArray(next.nodes) || !Array.isArray(next.edges) || !Array.isArray(next.runs) || !Array.isArray(next.canvases)) throw new Error('项目状态缺少画布或研究记录，请重启本地服务。');
        const initial = !state;
        state = next;
        stateRevision++;
        indexState();
        const previousView = viewKey;
        loadGraphView();
        if (!nodeById.has(selectedId)) selectedId = null;
        renderCanvases();
        $('project-name').textContent = state.project.name || '科研工作台';
        $('project-root').textContent = state.project.root || '本地项目';
        $('project-root').title = state.project.root || '';
        document.title = `${state.project.name || '研究流向'} — IdeaFlow`;
        $('create-root').disabled = !state.csrf_token;
        $('empty-create').disabled = !state.csrf_token;
        $('open-compare').disabled = state.runs.length < 2;
        renderGraph();
        renderDetails();
        updateCompareOptions();
        if ($('node-dialog').open && draft?.mode === 'edit' && nodeById.get(draft.id)?.updated_at !== draft.original_updated_at) $('form-draft-note').textContent = '此节点的已保存记录在编辑期间有更新。当前草稿已保留，保存将提交表单中的标题与正文。';
        $('sync-status').textContent = `已同步 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} · 每 3 秒`;
        $('sync-status').classList.remove('offline');
        message($('connection-error'), '');
        remember();
        if ((initial || previousView !== viewKey) && !viewRestored) fitGraph();
        return true;
      } catch (error) {
        $('sync-status').textContent = '连接中断 · 自动重试';
        $('sync-status').classList.add('offline');
        message($('connection-error'), `无法同步：${error.message}${state ? ' 当前保留上次读取的记录与所有草稿。' : ' 请确认本地服务已启动，页面与 API 使用同一地址。'}`, true);
        return false;
      }
    })();
    try { return await refreshPromise; } finally { refreshPromise = null; }
  }

  async function poll() {
    await refreshState();
    pollTimer = setTimeout(poll, 3000);
  }

  async function refreshAfterWrite(node) {
    // Wait for any pre-write read before fetching the committed state.
    if (refreshPromise) await refreshPromise;
    if (node) {
      const index = state.nodes.findIndex(item => item.id === node.id);
      if (index < 0) state.nodes.push(node); else state.nodes[index] = node;
      indexState();
      renderGraph();
      renderDetails();
    }
    await refreshState();
  }

  function openForm(mode, kind = 'idea') {
    if (!state) return;
    cancelConnection();
    $('canvas-dialog').close();
    $('options-dialog').close();
    if (draft) {
      fillForm();
      $('form-draft-note').textContent = '已恢复尚未保存的草稿。保存或丢弃后，可以创建另一条记录。';
      $('node-dialog').showModal();
      return;
    }
    const node = mode === 'edit' ? nodeById.get(selectedId) : null;
    draft = {
      mode, id: node?.id || null, kind: node?.kind || kind, title: node?.title || '', body: node?.body || '',
      status: node?.status || (['experiment', 'next'].includes(kind) ? 'proposed' : 'active'),
      source_ids: [], reason: '', canvas_id: canvasId, original_updated_at: node?.updated_at || null
    };
    fillForm();
    remember();
    $('node-dialog').showModal();
    $('form-title').focus();
  }

  function fillForm() {
    draft.canvas_id ||= nodeById.get(draft.source_ids?.[0])?.canvas_id || canvasId;
    $('form-heading').textContent = draft.mode === 'edit' ? '编辑记录' : '添加节点';
    const thoughtKind = draft.kind === 'insight' ? 'insight' : 'idea';
    const experimentKind = draft.kind === 'next' ? 'next' : 'experiment';
    $('form-kind').replaceChildren(new Option('想法', thoughtKind), new Option('实验', experimentKind));
    $('form-kind').value = draft.kind;
    $('form-kind').disabled = draft.mode === 'edit';
    $('form-title').value = draft.title;
    $('form-body').value = draft.body;
    $('form-draft-note').textContent = desktop ? '草稿保留在此 App，重启后可以继续；只有保存后才会写入项目。' : '草稿保留在当前浏览器标签页；只有保存后才会写入项目。';
    $('form-placement').textContent = `画布：${canvasById.get(draft.canvas_id)?.title || '未找到'}${draft.source_ids?.length ? ' · 已保留原草稿的来源关系' : ''}`;
    message($('form-error'), '');
  }

  function captureDraft() {
    if (!draft || saving) return;
    const kind = $('form-kind').value;
    if (kind !== draft.kind && draft.mode === 'create') draft.status = ['experiment', 'next'].includes(kind) ? 'proposed' : 'active';
    draft.kind = kind;
    draft.title = $('form-title').value;
    draft.body = $('form-body').value;
    remember();
  }

  async function createCanvas(event) {
    event.preventDefault();
    if (canvasSaving) return;
    const title = $('new-canvas-title').value.trim();
    if (!title) { message($('new-canvas-error'), '请填写画布名称。', true); return; }
    canvasSaving = true;
    $('save-canvas').disabled = $('close-new-canvas').disabled = true;
    message($('new-canvas-error'), '');
    try {
      const canvas = await api('/api/canvases', { method: 'POST', body: JSON.stringify({ title }) });
      await refreshAfterWrite();
      $('new-canvas-dialog').close();
      switchCanvas(canvas.id);
    } catch (error) { message($('new-canvas-error'), `创建失败：${error.message}`, true); }
    finally { canvasSaving = false; $('save-canvas').disabled = $('close-new-canvas').disabled = false; }
  }

  function closeForm() {
    if (saving) return;
    captureDraft();
    $('node-dialog').close();
  }

  async function saveNode(event) {
    event.preventDefault();
    if (saving) return;
    captureDraft();
    message($('form-error'), '');
    if (!draft.title.trim()) { message($('form-error'), '请填写非空标题。', true); $('form-title').focus(); return; }
    if (draft.mode === 'create' && draft.source_ids?.some(id => !nodeById.has(id))) {
      message($('form-error'), '原草稿的部分来源已不存在，请保留正文后重新创建节点。', true); return;
    }
    const editing = draft.mode === 'edit';
    const payload = { title: draft.title.trim(), body: draft.body };
    if (!editing) {
      Object.assign(payload, { kind: draft.kind, status: draft.status, canvas_id: draft.canvas_id,
        source_ids: draft.source_ids || [], reason: draft.reason || '' });
      if (draft.kind !== 'idea' && draft.idea_id) payload.idea_id = draft.idea_id;
    }
    pinLayout();
    const viewport = $('graph-scroll');
    const newPoint = { x: (viewport.clientWidth / 2 - camera.x) / camera.scale - Graph.NODE_WIDTH / 2,
      y: (viewport.clientHeight / 2 - camera.y) / camera.scale - Graph.NODE_HEIGHT / 2 };
    while ([...positions.values()].some(p => Math.abs(p.x - newPoint.x) < Graph.NODE_WIDTH + 24 && Math.abs(p.y - newPoint.y) < Graph.NODE_HEIGHT + 24)) newPoint.y += Graph.NODE_HEIGHT + 60;
    saving = true;
    $('node-fields').disabled = true;
    ['save-node', 'discard-draft', 'keep-draft', 'close-form'].forEach(id => { $(id).disabled = true; });
    $('save-node').textContent = '正在保存…';
    try {
      const node = await api(editing ? `/api/nodes/${encodeURIComponent(draft.id)}` : '/api/nodes', { method: editing ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
      draft = null;
      remember();
      $('node-dialog').close();
      if (!editing && node.canvas_id === canvasId) manualPositions.set(node.id, newPoint);
      message($('feedback'), editing ? '记录已保存。' : '节点已添加。拖动下方圆点连线；选中后可调整状态。');
      await refreshAfterWrite(node);
      selectNode(node.id, true);
      rememberView();
    } catch (error) {
      message($('form-error'), `保存失败：${error.message} 草稿已保留。若请求中途断开，请先刷新核对是否已写入，再决定重试。`, true);
    } finally {
      saving = false;
      $('node-fields').disabled = false;
      ['save-node', 'discard-draft', 'keep-draft', 'close-form'].forEach(id => { $(id).disabled = false; });
      $('save-node').textContent = '保存记录';
    }
  }

  async function changeNodeStatus() {
    const node = nodeById.get(selectedId), status = $('node-status').value;
    if (!node || statusSaving || status === node.status) return;
    statusSaving = true;
    $('node-status').disabled = true;
    try {
      const updated = await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: JSON.stringify({ status }) });
      await refreshAfterWrite(updated);
    } catch (error) { message($('feedback'), `状态未保存：${error.message}`, true); }
    finally { statusSaving = false; positionNodeActions(); }
  }

  async function generateContext() {
    if (!selectedId) return;
    const id = selectedId, request = ++contextRequest, version = evidenceSignature();
    $('generate-context').disabled = true;
    $('generate-context').textContent = '正在生成…';
    message($('context-message'), '');
    try {
      const result = await api(`/api/context?${new URLSearchParams({ node: id })}`);
      if (request !== contextRequest || id !== selectedId) return;
      if (typeof result.text !== 'string') throw new Error('上下文响应缺少 text 文本。');
      $('context-text').value = result.text;
      $('copy-context').disabled = !result.text;
      contextVersion = version;
      message($('context-message'), version === evidenceSignature() ? '已生成。复制后粘贴到 Codex 即可继续研究。' : '生成过程中记录已变化，可再次更新获取最新上下文。');
    } catch (error) {
      if (request === contextRequest) message($('context-message'), `生成失败：${error.message}`, true);
    } finally {
      if (request === contextRequest) { $('generate-context').disabled = false; $('generate-context').textContent = '生成 / 更新上下文'; }
    }
  }

  async function copyContext() {
    const text = $('context-text').value;
    try {
      await navigator.clipboard.writeText(text);
      message($('context-message'), '已复制。可粘贴给 Codex。');
    } catch {
      $('context-text').focus();
      $('context-text').select();
      message($('context-message'), '浏览器未允许自动复制，已选中文本。请按 ⌘C / Ctrl+C 复制。');
    }
  }

  async function loadRun() {
    selectedRunId = $('run-select').value;
    const id = selectedRunId, nodeId = selectedId, request = ++runRequest;
    runsSignature = '';
    resetArtifact();
    renderRuns();
    const revision = stateRevision;
    remember();
    if (!id) return;
    try {
      const run = await api(`/api/run?${new URLSearchParams({ id })}`);
      if (request !== runRequest || id !== selectedRunId || nodeId !== selectedId || revision !== stateRevision) return;
      $('run-content').replaceChildren();
      renderRun($('run-content'), run);
    } catch (error) {
      if (request === runRequest && id === selectedRunId) $('run-content').prepend(el('p', 'notice error', `读取运行详情失败：${error.message} 下方保留状态接口中的记录。`));
    }
  }

  async function loadArtifact(name, button) {
    if (!selectedRunId) return;
    const id = selectedRunId, request = ++artifactRequest;
    $('artifact-view').hidden = false;
    $('artifact-title').textContent = `${id} / ${name}`;
    $('artifact-text').textContent = '正在读取…';
    message($('artifact-error'), '');
    document.querySelectorAll('[data-artifact]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    try {
      const text = await api(`/api/artifact?${new URLSearchParams({ run: id, name })}`, { asText: true });
      if (request !== artifactRequest || id !== selectedRunId) return;
      $('artifact-text').textContent = text || '（文件为空）';
    } catch (error) {
      if (request !== artifactRequest || id !== selectedRunId) return;
      $('artifact-text').textContent = '';
      message($('artifact-error'), `文件读取失败：${error.message}`, true);
    }
  }

  function updateCompareOptions() {
    const items = state.runs.slice().sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).map(run => ({ value: run.id, label: runLabel(run) }));
    fillSelect($('compare-left'), items, '选择左侧运行');
    fillSelect($('compare-right'), items, '选择右侧运行');
  }

  function invalidateCompare() {
    compareRequest++;
    $('compare-result').replaceChildren();
    $('compare-button').disabled = false;
    $('compare-button').textContent = '比较运行';
    message($('compare-error'), '');
  }

  function comparisonTable(container, title, rows) {
    if (!rows.length) {
      container.append(el('h3', '', title), el('p', 'muted small', '接口未报告差异。缺失的记录不能据此推断为相同。'));
      return;
    }
    const wrap = el('div', 'table-scroll'), table = el('table');
    table.append(el('caption', '', title));
    const head = el('thead'), header = el('tr');
    ['字段', '左侧', '右侧'].forEach(text => { const th = el('th', '', text); th.scope = 'col'; header.append(th); });
    head.append(header);
    const body = el('tbody');
    for (const item of rows) {
      const row = el('tr');
      const value = side => item[`${side}_present`] === false || item[side] === undefined ? '字段缺失' : item[side] === null ? 'null（已记录）' : fmt(item[side]);
      row.append(el('td', 'mono', item.key), el('td', 'mono', value('left')), el('td', 'mono', value('right')));
      body.append(row);
    }
    table.append(head, body); wrap.append(table); container.append(wrap);
  }

  function renderComparison(result) {
    const container = $('compare-result');
    container.replaceChildren(el('p', 'muted small', `比较结果读取于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}，不会被自动轮询替换；需要时可重新比较。`));
    const summaries = el('div', 'comparison-summary');
    for (const [label, run] of [['左侧', result.left], ['右侧', result.right]]) {
      const section = el('section');
      section.append(el('h3', '', `${label} · ${run.id}`), el('p', 'small', nodeName(run.experiment_id)), el('p', 'muted small', `${RUN_STATUSES[run.status]} · ${run.origin === 'imported' ? '导入' : '受管理'} · ${date(run.created_at)}`));
      jsonBlock(section, '计划参数 · params', run.params);
      jsonBlock(section, '实采参数 · actual_params', run.actual_params);
      section.append(el('p', 'muted small', `本次参数比较使用：${run.actual_params === null || run.actual_params === undefined ? '计划参数（实采参数未记录）' : '实采参数'}`));
      const metrics = el('details');
      metrics.append(el('summary', '', '完整结果指标'), el('pre', '', fmt(run.metrics)));
      section.append(metrics);
      if (!run.snapshot) section.append(el('p', 'notice', '代码未记录'));
      else section.append(el('p', 'muted mono', `commit: ${fmt(run.snapshot.git_commit)}\nbranch: ${fmt(run.snapshot.git_branch)}\nmethod: ${fmt(run.snapshot.method)}`));
      summaries.append(section);
    }
    container.append(summaries);
    comparisonTable(container, '参数差异 · 接口返回项', result.parameters);
    comparisonTable(container, '指标差异', result.metrics);
    container.append(el('h3', '', '代码差异'));
    if (!result.left.snapshot || !result.right.snapshot) container.append(el('p', 'notice', '至少一侧代码未记录，不能比较代码，也不能认定两次运行代码一致。'));
    else if (!result.code.comparable) container.append(el('p', 'notice', '两侧代码记录不可比较。请检查快照方式与文件记录。'));
    else {
      const groups = [['内容不同', result.code.changed], ['仅左侧存在', result.code.only_left], ['仅右侧存在', result.code.only_right]];
      if (groups.every(([, paths]) => !paths.length)) container.append(el('p', 'muted small', '已记录的快照文件未发现差异；未记录的文件不在比较范围内。'));
      for (const [title, paths] of groups) {
        if (!paths.length) continue;
        container.append(el('h4', '', `${title} · ${paths.length}`));
        const list = el('ul', 'comparison-files mono');
        paths.forEach(path => list.append(el('li', '', path)));
        container.append(list);
      }
    }
  }

  async function compareRuns(event) {
    event.preventDefault();
    const left = $('compare-left').value, right = $('compare-right').value;
    if (!left || !right || left === right) { message($('compare-error'), '请选择两次不同的运行。', true); return; }
    const request = ++compareRequest;
    $('compare-button').disabled = true;
    $('compare-button').textContent = '正在比较…';
    $('compare-result').replaceChildren();
    message($('compare-error'), '');
    try {
      const result = await api(`/api/compare?${new URLSearchParams({ left, right })}`);
      if (request !== compareRequest) return;
      renderComparison(result);
    } catch (error) { if (request === compareRequest) message($('compare-error'), `比较失败：${error.message}`, true); }
    finally { if (request === compareRequest) { $('compare-button').disabled = false; $('compare-button').textContent = '比较运行'; } }
  }

  $('create-root').addEventListener('click', () => {
    $('canvas-dialog').close();
    $('new-canvas-title').value = '';
    message($('new-canvas-error'), '');
    $('new-canvas-dialog').showModal();
    $('new-canvas-title').focus();
  });
  $('close-new-canvas').addEventListener('click', () => $('new-canvas-dialog').close());
  $('new-canvas-form').addEventListener('submit', createCanvas);
  $('new-canvas-dialog').addEventListener('cancel', event => { if (canvasSaving) event.preventDefault(); });
  $('empty-create').addEventListener('click', () => openForm('create'));
  $('add-thought').addEventListener('click', () => openForm('create', 'idea'));
  $('add-experiment').addEventListener('click', () => openForm('create', 'experiment'));
  $('switch-canvas').addEventListener('click', () => $('canvas-dialog').showModal());
  $('close-canvases').addEventListener('click', () => $('canvas-dialog').close());
  $('more-options').addEventListener('click', () => $('options-dialog').showModal());
  $('close-options').addEventListener('click', () => $('options-dialog').close());
  $('close-detail').addEventListener('click', () => { const id = selectedId; closeDetails(); nodeButtons.get(id)?.focus({ preventScroll: true }); });
  $('detail-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const id = selectedId;
      closeDetails();
      nodeButtons.get(id)?.focus({ preventScroll: true });
    }
  });
  $('edit-node').addEventListener('click', () => openForm('edit'));
  $('resume-draft').addEventListener('click', () => { if (draft) { fillForm(); $('node-dialog').showModal(); } });
  $('node-status').addEventListener('change', changeNodeStatus);
  $('edit-selected').addEventListener('click', () => openForm('edit'));
  $('connect-selected').addEventListener('click', () => { beginConnection(selectedId); $('graph-scroll').focus({ preventScroll: true }); });
  $('cancel-connection').addEventListener('click', () => { cancelConnection(); renderGraph(); });
  $('delete-node').addEventListener('click', requestDeletion);
  $('delete-selection').addEventListener('click', requestDeletion);
  $('clear-selection').addEventListener('click', () => { clearSelection(); $('graph-scroll').focus({ preventScroll: true }); });
  $('confirm-delete').addEventListener('click', deleteSelection);
  $('cancel-delete').addEventListener('click', () => { pendingDeletion = null; $('delete-dialog').close(); });
  $('delete-dialog').addEventListener('cancel', event => { if (edgeSaving) event.preventDefault(); else pendingDeletion = null; });
  $('refresh-button').addEventListener('click', () => refreshState());
  $('locate-selection').addEventListener('click', () => { $('options-dialog').close(); locateSelected(); });
  $('zoom-in').addEventListener('click', () => zoomAt(camera.scale * 1.3));
  $('zoom-out').addEventListener('click', () => zoomAt(camera.scale / 1.3));
  $('zoom-reset').addEventListener('click', () => zoomAt(1));
  $('fit-graph').addEventListener('click', fitGraph);
  $('auto-layout').addEventListener('click', () => {
    $('options-dialog').close();
    for (const id of positions.keys()) manualPositions.delete(id);
    graphSignature = '';
    renderGraph();
    fitGraph();
  });
  $('graph-scroll').addEventListener('wheel', event => {
    if (event.target.closest('.canvas-controls, .node-actions, .connection-hint, .selection-actions') || !state?.nodes.length) return;
    event.preventDefault();
    if (gesture) return;
    const rect = $('graph-scroll').getBoundingClientRect();
    const dx = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.width : 1);
    const dy = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
    // Chromium reports trackpad pinch as Ctrl+wheel; ordinary scrolling pans.
    if (event.ctrlKey) {
      zoomAt(camera.scale * Math.exp(-Math.max(-160, Math.min(160, dy)) * .012), event.clientX - rect.left, event.clientY - rect.top);
    } else {
      const horizontal = event.shiftKey && dx === 0;
      camera.x -= horizontal ? dy : dx;
      camera.y -= horizontal ? 0 : dy;
      applyCamera();
      clearTimeout(viewSaveTimer);
      viewSaveTimer = setTimeout(rememberView, 180);
    }
  }, { passive: false });
  $('graph-scroll').addEventListener('pointerdown', startGesture);
  $('graph-scroll').addEventListener('pointermove', updateGesture);
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => $('graph-scroll').addEventListener(name, endGesture));
  $('graph-scroll').addEventListener('keydown', event => {
    if (event.target.closest('input, select, textarea, [contenteditable="true"]')) return;
    if (event.key === 'Escape' && gesture?.box) {
      event.preventDefault();
      endGesture({ pointerId: gesture.pointerId, type: 'pointercancel' });
      return;
    }
    if (event.key === 'Escape' && connectionSource) { event.preventDefault(); cancelConnection(); renderGraph(); return; }
    if (event.key === 'Escape' && (selectedNodes.size || selectedEdges.size)) { event.preventDefault(); clearSelection(); return; }
    if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); if (!event.repeat) requestDeletion(); return; }
    if (event.target.closest('.canvas-controls, .empty-state, .node-actions, .connection-hint, .connection-handle, .selection-actions')) return;
    const direction = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault();
      const id = event.target.closest('.graph-node')?.dataset.nodeId;
      if (event.altKey && (id || selectedNodes.size)) {
        const step = event.shiftKey ? 50 : 10;
        moveNodes(selectedPositions(id), direction[0] * step, direction[1] * step);
      } else {
        camera.x -= direction[0] * 60;
        camera.y -= direction[1] * 60;
        applyCamera();
      }
      rememberView();
    } else if (['+', '=', '-', '0', 'Home'].includes(event.key)) {
      event.preventDefault();
      if (event.key === '0' || event.key === 'Home') fitGraph();
      else zoomAt(camera.scale * (event.key === '-' ? 1 / 1.3 : 1.3));
    } else if (event.key === 'Escape' && selectedId) {
      event.preventDefault();
      closeDetails();
    } else if (event.code === 'Space' && event.target === $('graph-scroll')) {
      event.preventDefault();
      spacePressed = true;
    }
  });
  window.addEventListener('keyup', event => { if (event.code === 'Space') spacePressed = false; });
  window.addEventListener('blur', () => {
    spacePressed = false;
    if (gesture?.box) endGesture({ pointerId: gesture.pointerId, type: 'pointercancel' });
  });
  document.querySelectorAll('[data-derive]').forEach(button => button.addEventListener('click', () => openForm('create', button.dataset.derive)));
  document.querySelectorAll('[data-pane]').forEach(button => button.addEventListener('click', () => showPane(button.dataset.pane)));
  $('node-form').addEventListener('submit', saveNode);
  $('node-form').addEventListener('input', captureDraft);
  $('form-kind').addEventListener('change', captureDraft);
  $('close-form').addEventListener('click', closeForm);
  $('keep-draft').addEventListener('click', closeForm);
  $('node-dialog').addEventListener('cancel', event => { event.preventDefault(); closeForm(); });
  $('discard-draft').addEventListener('click', () => {
    if (saving) return;
    draft = null;
    remember();
    $('node-dialog').close();
  });
  $('search-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!state) return;
    const query = $('node-search').value.trim().toLocaleLowerCase();
    if (!query) return;
    const matches = state.nodes.filter(node => `${node.id} ${node.title}`.toLocaleLowerCase().includes(query));
    if (!matches.length) { message($('feedback'), '没有找到匹配的节点。'); return; }
    const index = matches.findIndex(node => node.id === selectedId);
    const match = matches[(index + 1) % matches.length];
    $('options-dialog').close();
    selectNode(match.id, true);
    message($('feedback'), `已定位：${match.title}${matches.length > 1 ? `。共 ${matches.length} 个匹配，再次定位查看下一个。` : ''}`);
  });
  $('run-select').addEventListener('change', loadRun);
  document.querySelectorAll('[data-artifact]').forEach(button => button.addEventListener('click', () => loadArtifact(button.dataset.artifact, button)));
  $('generate-context').addEventListener('click', generateContext);
  $('copy-context').addEventListener('click', copyContext);
  $('open-compare').addEventListener('click', () => {
    $('options-dialog').close();
    updateCompareOptions();
    if (!$('compare-left').value) $('compare-left').value = selectedRunId || state.runs[0]?.id || '';
    if (!$('compare-right').value) $('compare-right').value = state.runs.find(run => run.id !== $('compare-left').value)?.id || '';
    $('compare-dialog').showModal();
  });
  $('close-compare').addEventListener('click', () => $('compare-dialog').close());
  $('compare-left').addEventListener('change', invalidateCompare);
  $('compare-right').addEventListener('change', invalidateCompare);
  $('compare-form').addEventListener('submit', compareRuns);
  $('detail-resizer').addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeGesture = { pointerId: event.pointerId, x: event.clientX, width: detailWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');
  });
  $('detail-resizer').addEventListener('pointermove', event => {
    if (resizeGesture?.pointerId === event.pointerId) setDetailWidth(resizeGesture.width + resizeGesture.x - event.clientX);
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(name => $('detail-resizer').addEventListener(name, event => {
    if (resizeGesture?.pointerId !== event.pointerId) return;
    resizeGesture = null;
    document.body.classList.remove('is-resizing');
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDetailWidth(detailWidth, true);
  }));
  $('detail-resizer').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey ? 50 : 20;
    setDetailWidth(event.key === 'Home' ? 320 : event.key === 'End' ? 760 : detailWidth + (event.key === 'ArrowLeft' ? step : -step), true);
  });
  window.addEventListener('resize', () => setDetailWidth(detailWidth));
  window.addEventListener('pagehide', () => { clearTimeout(pollTimer); clearTimeout(viewSaveTimer); rememberView(); });
  window.addEventListener('pageshow', event => { if (event.persisted) { clearTimeout(pollTimer); poll(); } });
  new ResizeObserver(() => { if (state) applyCamera(); }).observe($('graph-scroll'));
  setDetailWidth(detailWidth);
  remember();
  poll();
})();
