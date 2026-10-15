(() => {
  'use strict';

  // Unsent node edits. Each is stored per project and node in localStorage until the service
  // confirms it, so closing the app, a stopped service or a second window never drops words.
  // Edits for a node deleted elsewhere go to `onLost` instead of being discarded.
  const PREFIX = 'ideaflow-unsaved-v2';
  const RETRY_DELAY = 4000;
  const rejected = error => /（400）/.test(error.message);

  function create({ storage, api, session, onSent, onLost, onState, setTimer = setTimeout, clearTimer = clearTimeout }) {
    const entries = new Map(), forgotten = new Set();
    let project = null, sending = false, retry = null;
    const key = id => `${PREFIX}:${project}:${id}`;

    function persist(id) {
      if (!project) return;
      try {
        if (entries.has(id)) storage.setItem(key(id), JSON.stringify(entries.get(id)));
        else storage.removeItem(key(id));
      } catch { /* Best effort; the edit is still held in memory. */ }
    }

    function set(id, changes) {
      if (Object.keys(changes).length) entries.set(id, changes); else entries.delete(id);
      persist(id);
    }

    function forget(ids) {
      for (const id of ids) { entries.delete(id); forgotten.add(id); persist(id); }
    }

    function sentOrLost(id, changes) {
      // A newer edit typed while the request was in flight stays queued.
      if (entries.get(id) === changes) { entries.delete(id); persist(id); }
    }

    async function drain() {
      clearTimer(retry);
      if (sending || !project) return;
      sending = true;
      let failure = null;
      const skipped = new Set();
      // Rescan each time: edits made while a request is in flight join the queue.
      for (let entry; (entry = [...entries].find(([id]) => !skipped.has(id)));) {
        const [id, changes] = entry;
        onState('saving');
        try {
          const node = await api(`/api/nodes/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ ...changes, draft_session: session }) });
          sentOrLost(id, changes);
          onSent(node, changes);
        } catch (error) {
          let problem = error;
          if (/Unknown node/.test(error.message)) {
            // Deleted on purpose in this window: nothing to recover.
            if (forgotten.has(id)) { sentOrLost(id, changes); continue; }
            try { await onLost(id, changes); sentOrLost(id, changes); continue; } catch (lost) { problem = lost; }
          }
          failure = problem;
          skipped.add(id);
          // A rejected edit stays queued until it changes; anything else means the service is away.
          if (!rejected(problem)) break;
        }
      }
      sending = false;
      if (!failure) { onState('done'); return; }
      onState('error', failure.message);
      if (!rejected(failure)) retry = setTimer(drain, RETRY_DELAY);
    }

    // Load what earlier sessions left for this project, then send everything queued.
    function open(root) {
      project = encodeURIComponent(root);
      const prefix = `${PREFIX}:${project}:`;
      try {
        for (let index = 0; index < storage.length; index++) {
          const name = storage.key(index);
          const id = name?.startsWith(prefix) ? name.slice(prefix.length) : null;
          const value = id && JSON.parse(storage.getItem(name));
          if (value && typeof value === 'object' && !entries.has(id)) entries.set(id, value);
        }
      } catch { /* Unreadable leftovers are skipped. */ }
      entries.forEach((_, id) => persist(id));
      return drain();
    }

    return {
      open, set, forget, drain,
      get: id => entries.get(id),
      has: id => entries.has(id),
      get size() { return entries.size; },
    };
  }

  const api = { create };
  if (typeof window !== 'undefined') window.NoteOutbox = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
