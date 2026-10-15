(() => {
  'use strict';

  // Detail-panel journal: decide on proposals, react to results, and append verbatim notes.
  // Entries are shown as written and offer no edit or delete controls.
  const RUN_STATUSES = { succeeded: '成功', failed: '失败', interrupted: '已中断' };
  const NOTE_KINDS = [['note', '随记'], ['intent', '为什么做'], ['expectation', '预期']];

  function el(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = String(text);
    return element;
  }

  function when(value) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? String(value || '') : parsed.toLocaleString('zh-CN', { hour12: false });
  }

  function field(label, draft, placeholder, rows = 2) {
    const id = `journal-${draft}`;
    const wrap = el('div', 'journal-field');
    const caption = el('label', '', label);
    caption.htmlFor = id;
    const input = el('textarea');
    Object.assign(input, { id, rows, placeholder, maxLength: 4000 });
    input.dataset.draft = draft;
    wrap.append(caption, input);
    return wrap;
  }

  function errorLine() {
    const line = el('p', 'notice error journal-error');
    line.setAttribute('role', 'alert');
    line.hidden = true;
    return line;
  }

  function button(text, className = '') {
    const element = el('button', className, text);
    element.type = 'button';
    return element;
  }

  function create({ container, api, refresh, notify, onFork }) {
    const { byNode, awaitingReaction, label, isHindsight, OUTCOME_LABELS } = window.JournalModel;
    // Unsaved words per node, so switching nodes or a background refresh never loses them.
    const saved = new Map();
    let signature = '', nodeId = null, busy = false, composing = false, deferred = null;

    const draftKey = input => input.type === 'radio' ? input.name : input.dataset.draft;

    function readDrafts() {
      const drafts = {};
      container.querySelectorAll('[data-draft]').forEach(input => {
        if (input.type !== 'radio') drafts[draftKey(input)] = input.value;
        else if (input.checked) drafts[draftKey(input)] = input.value;
      });
      return drafts;
    }

    function writeDrafts(drafts) {
      container.querySelectorAll('[data-draft]').forEach(input => {
        const value = drafts[draftKey(input)];
        if (input.type === 'radio') input.checked = value === input.value;
        else if (value !== undefined) input.value = value;
      });
    }

    function clearDrafts(keys) {
      container.querySelectorAll('[data-draft]').forEach(input => {
        if (!keys.includes(draftKey(input))) return;
        if (input.type === 'radio') input.checked = false; else input.value = '';
      });
      const drafts = saved.get(nodeId) || {};
      saved.set(nodeId, Object.fromEntries(Object.entries(drafts).filter(([key]) => !keys.includes(key))));
    }

    // Rebuilding while someone types (or composes with an IME) would steal focus; wait until they leave.
    function editing() {
      const active = document.activeElement;
      return composing || Boolean(active && container.contains(active) && active.matches('textarea, input, select'));
    }

    function flush() {
      if (!deferred || editing()) return;
      const [node, state] = deferred;
      deferred = null;
      render(node, state);
    }

    container.addEventListener('compositionstart', () => { composing = true; });
    container.addEventListener('compositionend', () => { composing = false; });
    container.addEventListener('focusout', () => setTimeout(flush, 0));

    async function submit(trigger, error, path, body, success, keys) {
      if (busy) return;
      busy = true;
      trigger.disabled = true;
      error.hidden = true;
      try {
        await api(path, { method: 'POST', body: JSON.stringify(body) });
        clearDrafts(keys);
        signature = '';
        notify(success);
        await refresh();
      } catch (failure) {
        error.textContent = `未保存：${failure.message}`;
        error.hidden = false;
      } finally {
        busy = false;
        trigger.disabled = false;
      }
    }

    function decisionBox(node, proposals) {
      const box = el('section', 'journal-prompt');
      box.dataset.prompt = 'decision';
      box.append(el('h3', '', '待你决定'));
      for (const proposal of proposals) {
        box.append(el('p', 'journal-caption', 'Agent 的理由（Agent 草拟）'), el('blockquote', 'journal-quote', proposal.text));
      }
      const reason = field('你为什么想做？保存时记下原话和时间，之后不能修改', 'decision-text', '我怀疑是提到旧规则本身在诱发旧行为');
      const expectation = field('预期（可不填）', 'decision-expect', '如果去掉提及后旧行为消失，我会转向研究否定词');
      const error = errorLine(), actions = el('div', 'action-row');
      const approve = button('批准，交给 Agent 运行', 'primary'), decline = button('暂不做');
      actions.append(approve, decline);
      box.append(reason, expectation, error, actions);
      const [text, expect] = [reason, expectation].map(wrap => wrap.querySelector('textarea'));
      approve.addEventListener('click', () => {
        if (!text.value.trim()) { error.textContent = '写一句为什么就行，粗糙也没关系。'; error.hidden = false; text.focus(); return; }
        submit(approve, error, '/api/decisions', { node_id: node.id, decision: 'approved', text: text.value, expectation: expect.value },
          '已批准。原话已锁定，Agent 可以开始运行。', ['decision-text', 'decision-expect']);
      });
      decline.addEventListener('click', () => submit(decline, error, '/api/decisions',
        { node_id: node.id, decision: 'declined', text: text.value }, '已记录为“考虑过但没做”。', ['decision-text', 'decision-expect']));
      return box;
    }

    function reactionBox(run) {
      const box = el('section', 'journal-prompt');
      box.dataset.prompt = 'reaction';
      box.append(el('h3', '', '结果回来了，你的第一反应？'),
        el('p', 'muted small', `${run.id} · ${RUN_STATUSES[run.status] || run.status} · ${when(run.finished_at)}`));
      const choices = el('div', 'outcome-choices');
      choices.setAttribute('role', 'radiogroup');
      choices.setAttribute('aria-label', '与预期相比');
      for (const [value, text] of Object.entries(OUTCOME_LABELS)) {
        const option = el('label', 'outcome-choice');
        const radio = el('input');
        Object.assign(radio, { type: 'radio', name: `outcome-${run.id}`, value });
        radio.dataset.draft = `outcome-${run.id}`;
        option.dataset.outcome = value;
        option.append(radio, el('span', '', text));
        choices.append(option);
      }
      const note = field('一句话（可不填）', `reaction-${run.id}`, '没过拟合，反而更稳', 2);
      const error = errorLine(), save = button('记下反应');
      box.append(choices, note, error, save);
      save.addEventListener('click', () => {
        const picked = box.querySelector('input[type="radio"]:checked');
        if (!picked) { error.textContent = '先选一个：符合预期、与预期不符，或混合。'; error.hidden = false; return; }
        const text = note.querySelector('textarea');
        submit(save, error, '/api/reactions', { run_id: run.id, outcome: picked.value, text: text.value },
          picked.value === 'surprised' ? '已记下。可以从这条意外分出新问题。' : '已记下反应。', [`outcome-${run.id}`, `reaction-${run.id}`]);
      });
      return box;
    }

    function entryList(node, entries, runs) {
      const section = el('section', 'journal-entries');
      section.append(el('h3', '', '原话记录'),
        el('p', 'muted small', '只追加，不能修改。你的原话和 Agent 的话分开标注；上方“整理”可以随时改写。'));
      if (!entries.length) {
        section.append(el('p', 'journal-missing', '还没有原话记录。可以在下面写一句当时的想法；事后补写的内容会带上补写的时间。'));
        return section;
      }
      const list = el('ol', 'journal-list');
      for (const entry of entries) {
        const item = el('li', 'journal-entry');
        item.dataset.author = entry.author;
        item.dataset.kind = entry.kind;
        const late = isHindsight(entry, runs) ? '结果出来后补写' : '';
        item.append(el('p', 'journal-meta', [when(entry.created_at), label(entry), late, entry.run_id].filter(Boolean).join(' · ')));
        item.append(el('blockquote', 'journal-quote', entry.text || '（未写文字）'));
        if (entry.kind === 'reaction' && entry.outcome === 'surprised') {
          const fork = button('从这里分出新问题', 'journal-fork');
          fork.addEventListener('click', () => onFork(node.id));
          item.append(fork);
        }
        list.append(item);
      }
      section.append(list);
      return section;
    }

    function noteForm(node) {
      const form = el('section', 'journal-note');
      const kind = el('select');
      kind.dataset.draft = 'note-kind';
      kind.setAttribute('aria-label', '记录类型');
      NOTE_KINDS.forEach(([value, text]) => kind.append(new Option(text, value)));
      const text = field('随手记一句', 'note-text', '先试一下 A，看看会不会好一些。暂时没想清楚为什么。', 3);
      const error = errorLine(), actions = el('div', 'action-row'), save = button('追加（保存后不能修改）');
      actions.append(kind, save);
      form.append(text, actions, error);
      const input = text.querySelector('textarea');
      save.addEventListener('click', () => {
        if (!input.value.trim()) { error.textContent = '先写一句再追加。'; error.hidden = false; input.focus(); return; }
        submit(save, error, '/api/entries', { node_id: node.id, kind: kind.value, text: input.value }, '已追加到原话记录。', ['note-text']);
      });
      return form;
    }

    function render(node, state) {
      if (nodeId) saved.set(nodeId, readDrafts());
      if (!node) { deferred = null; container.replaceChildren(); signature = ''; nodeId = null; return; }
      const entries = byNode(state.entries).get(node.id) || [];
      const runs = state.runs.filter(run => run.experiment_id === node.id);
      const proposals = entries.filter(entry => entry.kind === 'proposal');
      const awaiting = node.status === 'proposed' && proposals.length > 0 && !entries.some(entry => entry.kind === 'decision');
      const pending = node.kind === 'experiment' ? awaitingReaction(entries, runs) : [];
      const next = JSON.stringify([node.id, node.status, entries.map(entry => entry.id), awaiting,
        runs.map(run => [run.id, run.status, run.finished_at])]);
      if (next === signature) return;
      if (node.id === nodeId && editing()) { deferred = [node, state]; return; }
      deferred = null;
      signature = next;
      nodeId = node.id;
      container.replaceChildren(...[awaiting ? decisionBox(node, proposals) : null, ...pending.map(reactionBox),
        entryList(node, entries, runs), noteForm(node)].filter(Boolean));
      writeDrafts(saved.get(node.id) || {});
    }

    function focus(kind) {
      if (!kind) return;
      const target = container.querySelector(kind === 'decision' ? '[data-draft="decision-text"]'
        : '[data-prompt="reaction"] input[type="radio"]');
      target?.focus({ preventScroll: false });
    }

    return { render, focus };
  }

  window.JournalView = { create };
})();
