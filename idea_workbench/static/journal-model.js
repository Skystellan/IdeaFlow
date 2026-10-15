(() => {
  'use strict';

  // Pure reading of the append-only journal. States come only from recorded entries and
  // runs; nothing is inferred from titles, so history without recorded words stays plain.
  const KIND_LABELS = { proposal: '提议', decision: '决定', intent: '为什么', expectation: '预期', reaction: '结果反应', note: '随记' };
  const OUTCOME_LABELS = { expected: '符合预期', surprised: '与预期不符', mixed: '混合或说不清' };
  const DECISION_LABELS = { approved: '批准', declined: '暂不做' };
  const AUTHOR_LABELS = { human: '你的原话', agent: 'Agent' };
  const STATE_LABELS = {
    thought: '想法', awaiting: 'Agent 提议，等你决定', declined: '考虑过，暂不做', running: '运行中',
    expected: '符合预期', surprised: '与预期不符', mixed: '结果混合', planned: '计划中', plain: '未记录反应',
  };
  const UNFINISHED = new Set(['queued', 'running']);

  function byNode(entries = []) {
    const groups = new Map();
    for (const entry of entries) {
      if (!groups.has(entry.node_id)) groups.set(entry.node_id, []);
      groups.get(entry.node_id).push(entry);
    }
    for (const list of groups.values()) list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    return groups;
  }

  const last = (entries, kind) => entries.filter(e => e.kind === kind).at(-1);

  function beadState(node, entries = [], runs = []) {
    if (node.kind === 'idea' || node.kind === 'insight') return 'thought';
    const decision = last(entries, 'decision');
    // A decline describes the proposal; once the experiment is run anyway, its runs speak.
    if (decision?.decision === 'declined' && !runs.length) return 'declined';
    if (node.status === 'proposed' && !decision && entries.some(e => e.kind === 'proposal')) return 'awaiting';
    if (runs.some(run => UNFINISHED.has(run.status))) return 'running';
    const reaction = last(entries, 'reaction');
    if (reaction) return reaction.outcome;
    return node.status === 'proposed' ? 'planned' : 'plain';
  }

  function awaitingReaction(entries = [], runs = []) {
    const reacted = new Set(entries.filter(e => e.kind === 'reaction' && e.run_id).map(e => e.run_id));
    return runs.filter(run => !UNFINISHED.has(run.status) && run.origin !== 'imported' && !reacted.has(run.id));
  }

  function label(entry) {
    // Words recorded through the CLI were relayed by an agent, not typed by the researcher.
    const author = entry.author === 'human' && entry.via === 'cli' ? '你的原话（经 Agent 转录）' : AUTHOR_LABELS[entry.author];
    return [author, KIND_LABELS[entry.kind], OUTCOME_LABELS[entry.outcome] || DECISION_LABELS[entry.decision]].filter(Boolean).join(' · ');
  }

  // A reason or expectation written after one of the node's runs had already finished.
  function isHindsight(entry, runs = []) {
    if (entry.kind !== 'intent' && entry.kind !== 'expectation') return false;
    return runs.some(run => !UNFINISHED.has(run.status) && run.finished_at && String(run.finished_at) < String(entry.created_at));
  }

  const api = { KIND_LABELS, OUTCOME_LABELS, STATE_LABELS, byNode, beadState, awaitingReaction, label, isHindsight };
  if (typeof window !== 'undefined') window.JournalModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
