(() => {
  'use strict';

  // One state per node, picked directly and drawn like the thread-map legend. Status choices
  // edit the node; an outcome is the researcher's reaction (append-only) and marks it done.
  const THOUGHT_STATES = [
    ['status:active', '进行中'], ['status:proposed', '待验证'], ['status:done', '已完成'], ['status:paused', '已暂停'],
  ];
  const EXPERIMENT_STATES = [
    ['status:proposed', 'planned'], ['status:active', 'running'], ['outcome:expected', 'expected'],
    ['outcome:surprised', 'surprised'], ['outcome:mixed', 'mixed'], ['status:done', 'plain'], ['status:paused', 'paused'],
  ];
  const UNFINISHED = new Set(['queued', 'running']);
  const isThought = node => node.kind === 'idea' || node.kind === 'insight';

  function context(node, state) {
    const { byNode, beadState } = window.JournalModel;
    const entries = byNode(state.entries).get(node.id) || [];
    const runs = state.runs.filter(run => run.experiment_id === node.id);
    return { entries, runs, bead: beadState(node, entries, runs),
      awaiting: state.frontier?.awaiting_decision?.some(item => item.node_id === node.id) };
  }

  // What the picker offers for this node, with the bead state each choice produces.
  function options(node, state) {
    const { STATE_LABELS } = window.JournalModel;
    if (isThought(node)) return THOUGHT_STATES.map(([value, label]) => ({ value, label, state: 'thought' }));
    const { entries, runs, awaiting } = context(node, state);
    if (awaiting) return [{ value: 'decide', label: '批准或暂不做…', state: 'awaiting', hint: '写一句理由' }];
    const live = runs.some(run => UNFINISHED.has(run.status));
    const judged = entries.some(entry => entry.kind === 'reaction');
    return EXPERIMENT_STATES
      // An outcome cannot be withdrawn, only replaced, so "not judged" is offered until there is one.
      .filter(([value]) => !(value === 'status:done' && judged))
      .map(([value, bead]) => ({ value, label: STATE_LABELS[bead], state: bead,
        disabled: live && value.startsWith('outcome:'), hint: live && value.startsWith('outcome:') ? '运行结束后再判断' : '' }));
  }

  function current(node, state) {
    if (isThought(node)) {
      const value = `status:${node.status}`;
      return { value, state: 'thought', label: THOUGHT_STATES.find(([key]) => key === value)?.[1] || node.status };
    }
    const { bead } = context(node, state);
    const value = ['expected', 'surprised', 'mixed'].includes(bead) ? `outcome:${bead}` : bead === 'awaiting' ? 'decide'
      : `status:${node.status}`;
    return { value, state: bead, label: window.JournalModel.STATE_LABELS[bead] };
  }

  async function apply({ api, node, value, refresh, notify, onDecide }) {
    if (value === 'decide') { onDecide(); return; }
    const [kind, choice] = value.split(':');
    try {
      if (kind === 'outcome') {
        await api('/api/reactions', { method: 'POST', body: JSON.stringify({ node_id: node.id, outcome: choice }) });
      } else if (choice !== node.status) {
        await api(`/api/nodes/${encodeURIComponent(node.id)}`, { method: 'PATCH', body: JSON.stringify({ status: choice }) });
      }
      await refresh();
      return kind;
    } catch (error) {
      notify(`状态未修改：${error.message}`, true);
      return null;
    }
  }

  function icon(state) {
    const box = document.createElement('span');
    box.className = 'state-icon';
    box.dataset.state = state;
    const mark = document.createElement('span');
    mark.className = 'bead-mark';
    box.append(mark);
    return box;
  }

  // The page's state button with its menu.
  function createPicker({ button, menu, onPick }) {
    let items = [], signature = '';

    function close(focus = false) {
      menu.hidden = true;
      signature = '';
      button.setAttribute('aria-expanded', 'false');
      if (focus) button.focus();
    }

    function render(node, state) {
      const now = current(node, state), choices = options(node, state);
      // Refreshes arrive every few seconds; rebuilding an open menu would steal focus.
      const next = JSON.stringify([node.id, now, choices]);
      if (next === signature || !menu.hidden) return;
      signature = next;
      button.replaceChildren(icon(now.state), Object.assign(document.createElement('span'), { textContent: now.label }),
        Object.assign(document.createElement('span'), { className: 'state-caret', textContent: '▾' }));
      button.title = `状态：${now.label}`;
      items = choices.map(option => {
        const item = document.createElement('button');
        Object.assign(item, { type: 'button', disabled: Boolean(option.disabled), title: option.hint || '' });
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(option.value === now.value));
        item.append(icon(option.state), Object.assign(document.createElement('span'), { textContent: option.label }));
        if (option.hint) item.append(Object.assign(document.createElement('span'), { className: 'state-hint', textContent: option.hint }));
        item.addEventListener('click', () => { close(true); if (option.value !== now.value || option.value === 'decide') onPick(option.value); });
        return item;
      });
      menu.replaceChildren(...items);
    }

    button.addEventListener('click', () => {
      if (!menu.hidden) { close(); return; }
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      (items.find(item => item.getAttribute('aria-checked') === 'true' && !item.disabled) || items.find(item => !item.disabled))?.focus();
    });
    menu.addEventListener('keydown', event => {
      const enabled = items.filter(item => !item.disabled), index = enabled.indexOf(document.activeElement);
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        enabled[(index + (event.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length]?.focus();
      } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
    });
    document.addEventListener('pointerdown', event => {
      if (!menu.hidden && !menu.contains(event.target) && !button.contains(event.target)) close();
    });
    return { render, close };
  }

  const api = { options, current, apply, icon, createPicker };
  if (typeof window !== 'undefined') window.NodeState = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
