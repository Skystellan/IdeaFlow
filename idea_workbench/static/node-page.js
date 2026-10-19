(() => {
  'use strict';

  // The selected node as an editable page: title, type and body save themselves as you type.
  // Unsent edits wait in NoteOutbox, so closing the app or losing the local service never loses words.
  const SESSION = `s-${Math.random().toString(36).slice(2, 12)}`;
  const SAVE_DELAY = 700;
  const THOUGHT_KINDS = ['idea', 'insight'];
  const SAVE_LABELS = { saved: '已保存', editing: '编辑中', saving: '正在保存…', error: '未保存' };

  const category = kind => THOUGHT_KINDS.includes(kind) ? 'thought' : 'experiment';
  // Legacy insight/next records keep their stored kind until the category actually changes.
  const kindFor = (target, current) => target === category(current) ? current : target === 'thought' ? 'idea' : 'experiment';

  function create({ title, kindButtons, editorRoot, saveState, pageToggle, api, notify, onSaved, onLost, onEscape }) {
    let current = null, dirty = {}, timer = null, kindSaving = false;
    let storage = null;
    try { storage = window.localStorage; } catch { /* Storage can be disabled; edits then live only in this page. */ }
    const memory = new Map();
    const outbox = window.NoteOutbox.create({
      storage: storage || { length: 0, key: () => null, getItem: name => memory.get(name) ?? null, setItem: (name, value) => memory.set(name, value), removeItem: name => memory.delete(name) },
      api, session: SESSION, onSent: sent, onLost,
      onState: (state, detail) => setState(state === 'done' ? (dirty.title || dirty.body ? 'editing' : 'saved') : state, detail),
    });

    const editor = window.NoteEditor.create({
      root: editorRoot, onChange: () => edited('body'), onEscape,
      onError: text => notify(text, true),
      upload: file => api('/api/assets', { method: 'POST', body: file, headers: { 'Content-Type': file.type }, timeout: 60000 }),
    });

    function setState(state, detail = '') {
      saveState.dataset.state = state;
      saveState.textContent = detail ? `${SAVE_LABELS[state]}：${detail}` : SAVE_LABELS[state];
      saveState.title = state === 'error' ? '修改保留在本机，会自动重试' : '';
    }

    // Move the current node's unsaved fields into the outbox.
    function collect() {
      clearTimeout(timer);
      if (!current || !(dirty.title || dirty.body)) return;
      const changes = { ...outbox.get(current.id) };
      if (dirty.title && title.value.trim()) changes.title = title.value.trim();
      if (dirty.body) changes.body = editor.markdown();
      dirty = {};
      for (const field of ['title', 'body']) if (changes[field] === current.base[field]) delete changes[field];
      outbox.set(current.id, changes);
    }

    // Only the fields this save sent are known to match the server now. Anything else (a body
    // Codex changed meanwhile) is noticed by `show` on the next refresh.
    function sent(node, changes) {
      if (current?.id === node.id) {
        for (const field of Object.keys(changes)) current.base = { ...current.base, [field]: node[field] };
        // The text may have changed back (⌘Z) while this save was in flight.
        if ('body' in changes && !dirty.body && !outbox.has(node.id) && editor.markdown() !== node.body) edited('body');
        if ('title' in changes && !dirty.title && !outbox.has(node.id) && title.value.trim() && title.value.trim() !== node.title) edited('title');
      }
      onSaved(node);
    }

    function save() { collect(); outbox.drain(); }

    function edited(field) {
      if (!current) return;
      dirty[field] = true;
      setState('editing');
      clearTimeout(timer);
      timer = setTimeout(() => (editor.isComposing() ? edited(field) : save()), SAVE_DELAY);
    }

    // CSS field-sizing grows the title by itself; older browsers measure it, again whenever its size changes.
    const autoSized = window.CSS?.supports?.('field-sizing', 'content');
    function fitTitle() {
      if (autoSized) return;
      title.style.height = 'auto';
      title.style.height = `${title.scrollHeight}px`;
    }
    if (!autoSized && window.ResizeObserver) new ResizeObserver(fitTitle).observe(title.parentElement);

    function load(node) {
      const pending = outbox.get(node.id) || {};
      title.value = pending.title ?? node.title;
      fitTitle();
      editor.setMarkdown(pending.body ?? node.body);
      setState(outbox.has(node.id) ? 'editing' : 'saved');
    }

    // Called on every refresh. Edits in progress win; newer server versions load when idle.
    function show(node, state) {
      if (!node) { save(); current = null; return; }
      if (current?.id !== node.id) {
        save();
        current = { id: node.id, base: node };
        load(node);
      } else if (node.updated_at > current.base.updated_at) {
        const previous = current.base;
        current.base = node;
        if (node.body !== previous.body) {
          if (!dirty.body && outbox.get(node.id)?.body === undefined) editor.setMarkdown(node.body);
          else notify('这条记录刚被 Codex 或其他窗口更新；继续编辑会保存你的版本，旧版本保留在修订历史中。');
        }
        if (node.title !== previous.title && !dirty.title && document.activeElement !== title && outbox.get(node.id)?.title === undefined) {
          title.value = node.title;
          fitTitle();
        }
      }
      renderKind(node, state);
    }

    function renderKind(node, state) {
      const hasRuns = state.runs.some(run => run.experiment_id === node.id);
      const awaiting = state.frontier?.awaiting_decision?.some(item => item.node_id === node.id);
      for (const button of kindButtons) {
        const target = button.dataset.kind, selected = target === category(node.kind);
        button.setAttribute('aria-pressed', String(selected));
        const blocked = awaiting ? 'Agent 的提议等你决定后才能改类型' : hasRuns && target === 'thought' && !selected ? '已有运行记录的实验不能改成想法' : '';
        button.disabled = kindSaving || Boolean(blocked);
        button.title = blocked || (selected ? '当前类型' : `改为${button.textContent}`);
      }
    }

    async function changeKind(node, target, refresh) {
      const kind = kindFor(target, node.kind);
      if (kind === node.kind || kindSaving) return;
      kindSaving = true;
      kindButtons.forEach(button => { button.disabled = true; });
      try {
        const updated = await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: JSON.stringify({ kind }) });
        notify(`已改为${target === 'thought' ? '想法' : '实验'}。`);
        await refresh(updated);
      } catch (error) { notify(`类型未修改：${error.message}`, true); }
      finally { kindSaving = false; }
    }

    function setPageMode(open) {
      document.body.classList.toggle('is-page', open);
      pageToggle.setAttribute('aria-pressed', String(open));
      pageToggle.textContent = open ? '⤡' : '⤢';
      pageToggle.title = open ? '收起到侧栏（Esc）' : '展开为整页';
      pageToggle.setAttribute('aria-label', pageToggle.title);
    }

    title.addEventListener('input', () => { fitTitle(); edited('title'); });
    title.addEventListener('keydown', event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Enter') { event.preventDefault(); editor.focus(); }
      else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onEscape(); }
    });
    title.addEventListener('blur', () => {
      if (!title.value.trim() && current) { title.value = current.base.title; fitTitle(); dirty.title = false; }
      save();
    });
    editorRoot.addEventListener('blur', save);
    pageToggle.addEventListener('click', () => setPageMode(!document.body.classList.contains('is-page')));
    window.addEventListener('resize', fitTitle);

    return {
      show, changeKind, setPageMode, category,
      flush: save,
      // Send edits left from an earlier session once the project is known.
      resume: root => outbox.open(root),
      // Nodes deleted on purpose drop their pending edits.
      forget(ids) {
        outbox.forget(ids);
        if (current && ids.includes(current.id)) { clearTimeout(timer); dirty = {}; }
      },
      isPage: () => document.body.classList.contains('is-page'),
      focusTitle() { title.focus(); title.select(); },
      focusBody: () => editor.focus(true),
      // Keep words typed in the last instant before the page goes away.
      persistNow() { collect(); },
      adopt(id, changes) {
        const clean = {};
        if (typeof changes?.title === 'string' && changes.title.trim()) clean.title = changes.title.trim();
        if (typeof changes?.body === 'string') clean.body = changes.body;
        if (typeof id === 'string' && id && Object.keys(clean).length && !outbox.has(id)) { outbox.set(id, clean); outbox.drain(); }
      },
    };
  }

  window.NodePage = { create, category, kindFor };
})();
