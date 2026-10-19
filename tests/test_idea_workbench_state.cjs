'use strict';

// The node state picker offers what the thread map can show, and nothing the store would refuse.
// Run: node tests/test_idea_workbench_state.cjs
const assert = require('node:assert/strict');
global.window = { JournalModel: require('../idea_workbench/static/journal-model.js') };
const { options, current } = require('../idea_workbench/static/node-state.js');

const state = (extra = {}) => ({ entries: [], runs: [], frontier: { awaiting_decision: [] }, ...extra });
const experiment = status => ({ id: 'e', kind: 'experiment', status });
const values = list => list.map(option => option.value);

// Experiments offer every legend state the researcher decides; awaiting and running come from records.
assert.deepEqual(values(options(experiment('active'), state())), ['status:proposed', 'status:active', 'outcome:expected',
  'outcome:surprised', 'outcome:mixed', 'status:done', 'status:paused']);
assert.deepEqual(current(experiment('done'), state()), { value: 'status:done', state: 'plain', label: '已完成，未判断' });
assert.deepEqual(current(experiment('active'), state()), { value: 'status:active', state: 'running', label: '进行中' });

// After an outcome, "not judged" is gone (outcomes are replaced, never withdrawn) and the outcome shows.
const judged = state({ entries: [{ node_id: 'e', kind: 'reaction', outcome: 'surprised', run_id: null, created_at: '2026-10-19' }] });
assert.equal(values(options(experiment('done'), judged)).includes('status:done'), false);
assert.equal(current(experiment('done'), judged).value, 'outcome:surprised');

// A running run blocks outcomes until it finishes.
const live = state({ runs: [{ id: 'r', experiment_id: 'e', status: 'running' }] });
assert.deepEqual(options(experiment('active'), live).filter(option => option.disabled).map(option => option.value),
  ['outcome:expected', 'outcome:surprised', 'outcome:mixed']);

// An agent proposal awaiting a decision only offers the decision.
const awaiting = state({ frontier: { awaiting_decision: [{ node_id: 'e' }] },
  entries: [{ node_id: 'e', kind: 'proposal', created_at: '2026-10-19' }] });
assert.deepEqual(values(options(experiment('proposed'), awaiting)), ['decide']);
assert.equal(current(experiment('proposed'), awaiting).value, 'decide');

// Thoughts pick a plain status.
assert.deepEqual(values(options({ id: 't', kind: 'idea', status: 'active' }, state())),
  ['status:active', 'status:proposed', 'status:done', 'status:paused']);
assert.deepEqual(current({ id: 't', kind: 'insight', status: 'paused' }, state()), { value: 'status:paused', state: 'thought', label: '已暂停' });

console.log('node state picker: ok');
