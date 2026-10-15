'use strict';

// Unsent note edits must survive a dead service, other projects and deleted nodes.
// Run: node tests/test_idea_workbench_outbox.cjs
const assert = require('node:assert/strict');
const { create } = require('../idea_workbench/static/note-outbox.js');

function storage(initial = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    get length() { return items.size; },
    key: index => [...items.keys()][index] ?? null,
    getItem: name => items.get(name) ?? null,
    setItem: (name, value) => items.set(name, String(value)),
    removeItem: name => items.delete(name),
  };
}

function harness({ initial, respond }) {
  const store = storage(initial), sent = [], lost = [], states = [], timers = [];
  const outbox = create({
    storage: store, session: 's-test',
    api: async (path, options) => respond(decodeURIComponent(path.split('/').pop()), JSON.parse(options.body)),
    onSent: (node, changes) => sent.push([node.id, changes]),
    onLost: async (id, changes) => { lost.push([id, changes]); },
    onState: (state, detail) => states.push(detail ? `${state}:${detail}` : state),
    setTimer: callback => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  return { outbox, store, sent, lost, states, timers };
}

const key = (project, id) => `ideaflow-unsaved-v2:${encodeURIComponent(project)}:${id}`;
const fail = (status, text) => { throw new Error(`请求失败（${status}）：${text}`); };

(async () => {
  // Only the opened project's edits are sent; another project's stay untouched.
  {
    const { outbox, store, sent } = harness({
      initial: { [key('/a', 'n1')]: '{"body":"from A"}', [key('/b', 'n1')]: '{"body":"from B"}' },
      respond: (id, body) => ({ id, ...body }),
    });
    await outbox.open('/a');
    assert.deepEqual(sent, [['n1', { body: 'from A' }]]);
    assert.equal(store.getItem(key('/a', 'n1')), null, 'Delivered edits leave storage');
    assert.equal(store.getItem(key('/b', 'n1')), '{"body":"from B"}');
  }

  // Edits made while offline stay stored and are retried; a newer edit is never cleared by an older reply.
  {
    let online = false;
    const { outbox, store, sent, states, timers } = harness({
      respond: (id, body) => { if (!online) throw new Error('暂时连不上本地服务。'); return { id, ...body }; },
    });
    await outbox.open('/a');
    outbox.set('n1', { body: 'offline words' });
    await outbox.drain();
    assert.equal(store.getItem(key('/a', 'n1')), '{"body":"offline words"}');
    assert.equal(states.at(-1), 'error:暂时连不上本地服务。');
    assert.equal(timers.length, 1, 'A retry is scheduled');
    online = true;
    const sending = timers[0]();
    outbox.set('n1', { body: 'typed during the request' });
    await sending;
    assert.deepEqual(sent.map(([, changes]) => changes.body), ['offline words', 'typed during the request']);
    assert.equal(outbox.size, 0);
    assert.equal(states.at(-1), 'done');
  }

  // A rejected edit stays queued without blocking other nodes; a deleted node's words move elsewhere.
  {
    const { outbox, store, sent, lost, timers } = harness({
      respond: (id, body) => id === 'bad' ? fail(400, 'title must be non-empty text') : id === 'gone' ? fail(400, 'Unknown node: gone') : { id, ...body },
    });
    await outbox.open('/a');
    outbox.set('bad', { title: ' ' });
    outbox.set('gone', { body: 'keep me' });
    outbox.set('good', { body: 'fine' });
    await outbox.drain();
    assert.deepEqual(sent, [['good', { body: 'fine' }]]);
    assert.deepEqual(lost, [['gone', { body: 'keep me' }]]);
    assert.equal(store.getItem(key('/a', 'gone')), null);
    assert.equal(store.getItem(key('/a', 'bad')), '{"title":" "}', 'Rejected edits are kept, not dropped');
    assert.equal(timers.length, 0, 'Rejected edits are not retried in a loop');
  }

  // If recovering a deleted node's words fails, they stay queued.
  {
    const store = storage();
    const failing = create({
      storage: store, session: 's', api: async () => fail(400, 'Unknown node: gone'),
      onSent() {}, onLost: async () => { throw new Error('暂时连不上本地服务。'); }, onState() {},
      setTimer: () => 0, clearTimer() {},
    });
    await failing.open('/a');
    failing.set('gone', { body: 'still here' });
    await failing.drain();
    assert.equal(store.getItem(key('/a', 'gone')), '{"body":"still here"}');
  }

  // Deleting nodes on purpose forgets their pending edits; nothing is sent before a project is open.
  {
    const { outbox, store, sent } = harness({ respond: (id, body) => ({ id, ...body }) });
    outbox.set('early', { body: 'before open' });
    await outbox.drain();
    assert.deepEqual(sent, []);
    outbox.set('deleted', { body: 'x' });
    outbox.forget(['deleted']);
    await outbox.open('/a');
    assert.deepEqual(sent, [['early', { body: 'before open' }]]);
    assert.equal(store.items.size, 0);
  }

  // A save already in flight when the node is deleted on purpose is not recovered.
  {
    let release;
    const { outbox, lost } = harness({ respond: () => new Promise((_, reject) => { release = () => reject(new Error('请求失败（400）：Unknown node: n1')); }) });
    await outbox.open('/a');
    outbox.set('n1', { body: 'typed just before deleting' });
    const sending = outbox.drain();
    outbox.forget(['n1']);
    release();
    await sending;
    assert.deepEqual(lost, []);
  }

  console.log('note outbox: ok');
})().catch(error => { console.error(error); process.exit(1); });
