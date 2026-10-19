"""SQLite research graph shared by the CLI, web UI and experiment worker."""
from __future__ import annotations

import json
import sqlite3
import time
import uuid
from contextlib import closing, contextmanager
from pathlib import Path

from . import journal
from .fields import encode, now, text_field

KINDS = {"idea", "experiment", "insight", "next"}
STATUSES = {"active", "paused", "done", "proposed"}
BODY_LIMIT = 100000
TEXT_FIELDS = {"title", "body"}
# An app editing session overwrites its own autosaves for this long before taking another snapshot.
DRAFT_WINDOW = 10 * 60
__all__ = ["KINDS", "STATUSES", "Store", "encode", "now", "text_field"]


class Store:
    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        self.db = self.path / "research.sqlite3"
        # Latest app autosave per node: (editing session, resulting updated_at, session start).
        self._drafts = {}
        self._clock = time.monotonic
        if not self.db.is_file():
            raise ValueError("Project is not initialized. Run: python3 -m idea_workbench init")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("""CREATE TABLE IF NOT EXISTS canvases(
                id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL)""")
            project = json.loads(db.execute("SELECT value FROM meta WHERE key='project'").fetchone()[0])
            db.execute("INSERT OR IGNORE INTO canvases(id,title,created_at) VALUES(?,?,?)",
                       ("canvas-main", project["name"], now()))
            if "canvas_id" not in {r["name"] for r in db.execute("PRAGMA table_info(nodes)")}:
                db.execute("ALTER TABLE nodes ADD COLUMN canvas_id TEXT REFERENCES canvases(id)")
            db.execute("UPDATE nodes SET canvas_id='canvas-main' WHERE canvas_id IS NULL")
            for statement in journal.SCHEMA:
                db.execute(statement)

    @classmethod
    def initialize(cls, path, name, project_root):
        name = text_field(name, "name", 200, True)
        project_root = Path(project_root).expanduser().resolve()
        if not project_root.is_dir():
            raise ValueError("Project root must be an existing directory")
        path = Path(path).expanduser().resolve()
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        with closing(sqlite3.connect(path / "research.sqlite3")) as db, db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                PRAGMA foreign_keys=ON;
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS nodes(
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                    body TEXT NOT NULL, status TEXT NOT NULL,
                    idea_id TEXT NOT NULL REFERENCES nodes(id),
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS edges(
                    source TEXT NOT NULL REFERENCES nodes(id),
                    target TEXT NOT NULL REFERENCES nodes(id),
                    relation TEXT NOT NULL, reason TEXT NOT NULL,
                    PRIMARY KEY(source,target));
                CREATE TABLE IF NOT EXISTS revisions(
                    id INTEGER PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id),
                    previous TEXT NOT NULL, changed_at TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS runs(
                    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES nodes(id),
                    data TEXT NOT NULL);
            """)
            existing = db.execute("SELECT value FROM meta WHERE key='project'").fetchone()
            if existing:
                if json.loads(existing[0])["root"] != str(project_root):
                    raise ValueError("This store belongs to a different project directory")
            else:
                db.execute("INSERT INTO meta VALUES('project',?)", (encode({"name": name, "root": str(project_root)}),))
        return cls(path)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=15)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        try:
            with db:
                yield db
        finally:
            db.close()

    @staticmethod
    def _node(db, node_id):
        row = db.execute("SELECT * FROM nodes WHERE id=?", (node_id,)).fetchone()
        if row is None:
            raise ValueError(f"Unknown node: {node_id}")
        return dict(row)

    def node(self, node_id):
        with self.connect() as db:
            return self._node(db, node_id)

    def add_canvas(self, title):
        title = text_field(title, "title", 200, True)
        canvas = dict(id="canvas-" + uuid.uuid4().hex[:12], title=title, created_at=now())
        with self.connect() as db:
            db.execute("INSERT INTO canvases(id,title,created_at) VALUES(:id,:title,:created_at)", canvas)
        return canvas

    def add_node(self, *, kind, title, body="", status=None, source_ids=None, reason="", idea_id=None, canvas_id=None):
        return self._add_node(kind=kind, title=title, body=body, status=status, source_ids=source_ids,
                              reason=reason, idea_id=idea_id, canvas_id=canvas_id)

    def _add_node(self, *, kind, title, body="", status=None, source_ids=None, reason="", idea_id=None, canvas_id=None,
                  then=None):
        """Create a node; `then(db, node)` runs in the same transaction for records that must not be partial."""
        if kind not in KINDS:
            raise ValueError("kind must be idea, experiment, insight or next")
        title = text_field(title, "title", 200, True)
        body = text_field(body, "body", BODY_LIMIT)
        reason = text_field(reason, "reason", 4000)
        status = status or ("proposed" if kind == "next" else "active")
        if status not in STATUSES:
            raise ValueError("Invalid node status")
        source_ids = [] if source_ids is None else source_ids
        if not isinstance(source_ids, list) or any(not isinstance(s, str) for s in source_ids) or len(source_ids) > 32:
            raise ValueError("source_ids must be an array of at most 32 node IDs")
        source_ids = list(dict.fromkeys(source_ids))
        if canvas_id is not None:
            canvas_id = text_field(canvas_id, "canvas_id", 200, True)
        if idea_id is not None:
            idea_id = text_field(idea_id, "idea_id", 200, True)
        node_id = {"idea": "i", "experiment": "e", "insight": "s", "next": "g"}[kind] + "-" + uuid.uuid4().hex[:12]
        timestamp = now()
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            sources = [self._node(db, s) for s in source_ids]
            if canvas_id is None:
                canvas_id = sources[0]["canvas_id"] if sources else "canvas-main"
            if db.execute("SELECT 1 FROM canvases WHERE id=?", (canvas_id,)).fetchone() is None:
                raise ValueError(f"Unknown canvas: {canvas_id}")
            if any(s["canvas_id"] != canvas_id for s in sources):
                raise ValueError("All source nodes must belong to the same canvas as the new node")
            if idea_id is not None:
                idea = self._node(db, idea_id)
                if idea["kind"] != "idea":
                    raise ValueError("idea_id must identify an idea")
                if idea["canvas_id"] != canvas_id:
                    raise ValueError("idea_id must identify an idea in the same canvas as the new node")
            if kind == "idea" or not sources:
                # Standalone nodes anchor their own legacy lineage, regardless of kind.
                idea_id = node_id
            else:
                idea_id = idea_id or sources[0]["idea_id"]
            node = dict(id=node_id, kind=kind, title=title, body=body, status=status,
                        idea_id=idea_id, created_at=timestamp, updated_at=timestamp, canvas_id=canvas_id)
            db.execute("""INSERT INTO nodes(id,kind,title,body,status,idea_id,created_at,updated_at,canvas_id)
                VALUES(:id,:kind,:title,:body,:status,:idea_id,:created_at,:updated_at,:canvas_id)""", node)
            relation = "fork" if kind == "idea" else "synthesis" if len(sources) > 1 else "continues"
            # A newly created target has no outgoing edges, so these additions cannot form a cycle.
            db.executemany("INSERT INTO edges VALUES(?,?,?,?)", [(s, node_id, relation, reason) for s in source_ids])
            if then is not None:
                then(db, node)
        return node

    def add_edge(self, source, target, reason=""):
        source = text_field(source, "source", 200, True)
        target = text_field(target, "target", 200, True)
        reason = text_field(reason, "reason", 4000)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            source_node, target_node = self._node(db, source), self._node(db, target)
            if source == target:
                raise ValueError("A node cannot link to itself")
            if source_node["canvas_id"] != target_node["canvas_id"]:
                raise ValueError("Both nodes must belong to the same canvas")
            existing = db.execute("SELECT * FROM edges WHERE source=? AND target=?", (source, target)).fetchone()
            if existing is not None:
                return dict(existing)
            cycle = db.execute("""WITH RECURSIVE reachable(id) AS (
                SELECT ? UNION SELECT edges.target FROM edges JOIN reachable ON edges.source=reachable.id
            ) SELECT 1 FROM reachable WHERE id=? LIMIT 1""", (target, source)).fetchone()
            if cycle is not None:
                raise ValueError("This connection would create a cycle")
            edge = dict(source=source, target=target,
                        relation="fork" if target_node["kind"] == "idea" else "continues", reason=reason)
            db.execute("INSERT INTO edges(source,target,relation,reason) VALUES(:source,:target,:relation,:reason)", edge)
        return edge

    def remove_edge(self, source, target):
        source = text_field(source, "source", 200, True)
        target = text_field(target, "target", 200, True)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._node(db, source)
            self._node(db, target)
            db.execute("DELETE FROM edges WHERE source=? AND target=?", (source, target))
        return dict(source=source, target=target)

    def delete_selection(self, *, canvas_id, node_ids, edges):
        canvas_id = text_field(canvas_id, "canvas_id", 200, True)
        if not isinstance(node_ids, list) or len(node_ids) > 1000:
            raise ValueError("node_ids must be an array of at most 1000 node IDs")
        if not isinstance(edges, list) or len(edges) > 5000:
            raise ValueError("edges must be an array of at most 5000 edges")
        node_ids = list(dict.fromkeys(text_field(n, "node_id", 200, True) for n in node_ids))
        selected_edges = set()
        for edge in edges:
            if not isinstance(edge, dict) or set(edge) != {"source", "target"}:
                raise ValueError("Each edge must contain only source and target")
            source = text_field(edge["source"], "source", 200, True)
            target = text_field(edge["target"], "target", 200, True)
            if source == target:
                raise ValueError("A node cannot link to itself")
            selected_edges.add((source, target))
        if not node_ids and not selected_edges:
            raise ValueError("Select at least one node or edge to delete")

        counts = dict(nodes=0, edges=0, runs=0)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM canvases WHERE id=?", (canvas_id,)).fetchone() is None:
                raise ValueError(f"Unknown canvas: {canvas_id}")
            endpoints = set(node_ids) | {n for edge in selected_edges for n in edge}
            for node_id in endpoints:
                if self._node(db, node_id)["canvas_id"] != canvas_id:
                    raise ValueError("All selected nodes and edge endpoints must belong to the same canvas")
            placeholders = ",".join("?" for _ in node_ids)
            if node_ids:
                runs = db.execute(f"SELECT data FROM runs WHERE experiment_id IN ({placeholders})", node_ids)
                if any(json.loads(r["data"])["status"] in {"queued", "running"} for r in runs):
                    raise ValueError("Cannot delete an experiment with a queued or running run")

            counts["edges"] = db.executemany(
                "DELETE FROM edges WHERE source=? AND target=?", selected_edges).rowcount
            if node_ids:
                counts["edges"] += db.execute(
                    f"DELETE FROM edges WHERE source IN ({placeholders}) OR target IN ({placeholders})",
                    node_ids + node_ids).rowcount
                db.execute(f"DELETE FROM revisions WHERE node_id IN ({placeholders})", node_ids)
                counts["runs"] = db.execute(
                    f"DELETE FROM runs WHERE experiment_id IN ({placeholders})", node_ids).rowcount
                # Preserve downstream nodes when their legacy lineage anchor is deleted.
                db.execute(f"UPDATE nodes SET idea_id=id WHERE idea_id IN ({placeholders})", node_ids)
                counts["nodes"] = db.execute(f"DELETE FROM nodes WHERE id IN ({placeholders})", node_ids).rowcount
        return counts

    def edit_node(self, node_id, draft_session=None, **changes):
        """Edit a node, keeping its previous version. `draft_session` marks an app autosave."""
        if not changes or set(changes) - {"title", "body", "status", "kind"}:
            raise ValueError("Only title, body, status and kind can be edited")
        if draft_session is not None:
            draft_session = text_field(draft_session, "draft_session", 64, True)
        if "title" in changes:
            changes["title"] = text_field(changes["title"], "title", 200, True)
        if "body" in changes:
            changes["body"] = text_field(changes["body"], "body", BODY_LIMIT)
        if "status" in changes and changes["status"] not in STATUSES:
            raise ValueError("Invalid node status")
        if "kind" in changes and changes["kind"] not in KINDS:
            raise ValueError("kind must be idea, experiment, insight or next")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = self._node(db, node_id)
            if old["status"] == "proposed" and changes.get("status", "proposed") != "proposed" and self._undecided(db, node_id):
                raise ValueError("This proposal awaits the researcher's decision; record it with decide instead of a status edit")
            if changes.get("kind", old["kind"]) != old["kind"]:
                self._change_kind(db, old, changes["kind"])
            continued = self._continues_draft(old, draft_session, changes)
            node = self._revise(db, old, changes, snapshot=not continued)
        if draft_session is not None and set(changes) <= TEXT_FIELDS:
            started = self._drafts[node_id][2] if continued else self._clock()
            self._drafts[node_id] = (draft_session, node["updated_at"], started)
        else:
            self._drafts.pop(node_id, None)
        return node

    def _change_kind(self, db, old, kind):
        if self._undecided(db, old["id"]):
            raise ValueError("This proposal awaits the researcher's decision; its type cannot change before then")
        if kind != "experiment" and db.execute("SELECT 1 FROM runs WHERE experiment_id=? LIMIT 1", (old["id"],)).fetchone():
            raise ValueError("This experiment has recorded runs; runs must stay with an experiment")
        # Links into an idea read as forks; a synthesis of several sources keeps its label.
        previous, relation = ("continues", "fork") if kind == "idea" else ("fork", "continues")
        db.execute("UPDATE edges SET relation=? WHERE target=? AND relation=?", (relation, old["id"], previous))

    def _continues_draft(self, old, session, changes):
        """True when this autosave follows the same session's last save with nothing written in between."""
        last = self._drafts.get(old["id"])
        return (session is not None and set(changes) <= TEXT_FIELDS and last is not None
                and last[:2] == (session, old["updated_at"]) and self._clock() - last[2] < DRAFT_WINDOW)

    @staticmethod
    def _undecided(db, node_id):
        kinds = {r[0] for r in db.execute("SELECT kind FROM entries WHERE node_id=? AND kind IN ('proposal','decision')", (node_id,))}
        return kinds == {"proposal"}

    @staticmethod
    def _revise(db, old, changes, snapshot=True):
        node = old | changes | {"updated_at": now()}
        if snapshot:
            db.execute("INSERT INTO revisions(node_id,previous,changed_at) VALUES(?,?,?)", (old["id"], encode(old), node["updated_at"]))
        db.execute("UPDATE nodes SET kind=:kind,title=:title,body=:body,status=:status,updated_at=:updated_at WHERE id=:id", node)
        return node

    # Journal: append-only words. Graph edits never touch these rows.

    def add_entry(self, *, node_id, kind, text, author, via="cli", run_id=None):
        """Append a note, intent or expectation. Reactions, decisions and proposals have their own methods."""
        journal.choice(kind, journal.WRITABLE_KINDS, "kind")
        entry = journal.build_entry(node_id=node_id, kind=kind, author=author, text=text, run_id=run_id, via=via)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            self._node(db, entry["node_id"])
            if entry["run_id"] is not None:
                run = self._run(db, entry["run_id"])
                if run["experiment_id"] != entry["node_id"]:
                    raise ValueError("The run belongs to a different experiment")
                # A reason or expectation tied to a run is only meaningful before its result exists.
                if entry["kind"] in {"intent", "expectation"} and run["status"] not in journal.UNFINISHED_RUNS:
                    raise ValueError("This run has finished; add later thoughts as a note instead of an intent or expectation")
            return journal.insert_entry(db, entry)

    def entries(self, node_id=None):
        with self.connect() as db:
            if node_id is None:
                rows = db.execute("SELECT * FROM entries ORDER BY created_at,rowid")
            else:
                rows = db.execute("SELECT * FROM entries WHERE node_id=? ORDER BY created_at,rowid", (node_id,))
            return [dict(r) for r in rows]

    def propose(self, *, title, rationale, body="", source_ids=None, reason="", canvas_id=None, via="cli"):
        """An agent's proposed experiment. It waits in the frontier until the researcher decides."""
        created = {}

        def record(db, node):
            created["entry"] = journal.insert_entry(db, journal.build_entry(
                node_id=node["id"], kind="proposal", author="agent", text=rationale, via=via))

        # `record` runs inside the node's transaction, so an invalid rationale leaves no node behind.
        node = self._add_node(kind="experiment", title=title, body=body, status="proposed", source_ids=source_ids,
                              reason=reason, canvas_id=canvas_id, then=record)
        return {"node": node, "entry": created["entry"]}

    def decide(self, node_id, *, decision, text="", expectation="", via="cli"):
        """Record the researcher's own reason for approving or declining a proposed experiment."""
        made = journal.build_entry(node_id=node_id, kind="decision", author="human", text=text, decision=decision, via=via)
        expected = None
        if text_field(expectation, "expectation", journal.TEXT_LIMIT):
            if decision != "approved":
                raise ValueError("Only an approved experiment records an expectation")
            expected = journal.build_entry(node_id=node_id, kind="expectation", author="human", text=expectation, via=via)
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            node = self._node(db, made["node_id"])
            if node["kind"] != "experiment" or node["status"] != "proposed":
                raise ValueError("Only a proposed experiment awaits a decision")
            entries = [journal.insert_entry(db, e) for e in (made, expected) if e is not None]
            updated = self._revise(db, node, {"status": "active" if decision == "approved" else "paused"})
        return {"node": updated, "entries": entries}

    def react(self, run_id=None, *, node_id=None, outcome, text="", via="cli"):
        """The researcher's reaction to a finished run, or to the experiment as a whole.

        A reaction is their judgement of the result, so it also marks the experiment done.
        Agent interpretations are notes.
        """
        if (run_id is None) == (node_id is None):
            raise ValueError("Give either run_id or node_id")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if run_id is not None:
                run = self._run(db, text_field(run_id, "run_id", 200, True))
                if run["status"] in journal.UNFINISHED_RUNS:
                    raise ValueError("Record a reaction after the run finishes")
                node = self._node(db, run["experiment_id"])
            else:
                node = self._node(db, text_field(node_id, "node_id", 200, True))
                if node["kind"] not in {"experiment", "next"}:
                    raise ValueError("Only an experiment has an outcome")
                if self._undecided(db, node["id"]):
                    raise ValueError("This proposal awaits the researcher's decision")
                runs = [json.loads(r[0]) for r in db.execute("SELECT data FROM runs WHERE experiment_id=?", (node["id"],))]
                if any(r["status"] in journal.UNFINISHED_RUNS for r in runs):
                    raise ValueError("A run has not finished yet; record the outcome after it does")
            entry = journal.build_entry(node_id=node["id"], kind="reaction", author="human", text=text,
                                        run_id=run_id and run["id"], outcome=outcome, via=via)
            journal.insert_entry(db, entry)
            if node["status"] != "done":
                self._revise(db, node, {"status": "done"})
            return entry

    @staticmethod
    def _run(db, run_id):
        row = db.execute("SELECT data FROM runs WHERE id=?", (run_id,)).fetchone()
        if row is None:
            raise ValueError(f"Unknown run: {run_id}")
        return json.loads(row[0])

    def state(self):
        with self.connect() as db:
            db.execute("BEGIN")
            return {
                "project": json.loads(db.execute("SELECT value FROM meta WHERE key='project'").fetchone()[0]),
                "canvases": [dict(r) for r in db.execute("SELECT * FROM canvases ORDER BY created_at,id")],
                "nodes": [dict(r) for r in db.execute("SELECT * FROM nodes ORDER BY created_at,id")],
                "edges": [dict(r) for r in db.execute("SELECT * FROM edges ORDER BY rowid")],
                "runs": [json.loads(r[0]) for r in db.execute("SELECT data FROM runs ORDER BY rowid")],
                "entries": [dict(r) for r in db.execute("SELECT * FROM entries ORDER BY created_at,rowid")],
            }

    def export(self):
        data = self.state()
        with self.connect() as db:
            data["revisions"] = [dict(r) | {"previous": json.loads(r["previous"])} for r in db.execute("SELECT * FROM revisions ORDER BY id")]
        return {"schema_version": 1, "exported_at": now(), **data}

    def add_run(self, run, entries=()):
        """Register a run together with the intent and expectation recorded before it executes."""
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if self._node(db, run["experiment_id"])["kind"] != "experiment":
                raise ValueError("Runs must belong to an experiment")
            db.execute("INSERT INTO runs VALUES(?,?,?)", (run["id"], run["experiment_id"], encode(run)))
            for entry in entries:
                if (entry["node_id"], entry["run_id"]) != (run["experiment_id"], run["id"]):
                    raise ValueError("Run entries must belong to the new run")
                journal.insert_entry(db, entry)
        return run

    def run(self, run_id):
        with self.connect() as db:
            row = db.execute("SELECT data FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise ValueError(f"Unknown run: {run_id}")
            return json.loads(row[0])

    def update_run(self, run_id, **updates):
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT data FROM runs WHERE id=?", (run_id,)).fetchone()
            if row is None:
                raise ValueError(f"Unknown run: {run_id}")
            run = json.loads(row[0]) | updates
            db.execute("UPDATE runs SET data=? WHERE id=?", (encode(run), run_id))
        return run

    def context(self, node_id):
        data = self.state()
        nodes = {n["id"]: n for n in data["nodes"]}
        if node_id not in nodes:
            raise ValueError(f"Unknown node: {node_id}")
        selected = nodes[node_id]
        ancestors = {n["id"] for n in data["nodes"] if n["idea_id"] == selected["idea_id"]}
        pending = list(ancestors)
        while pending:
            current = pending.pop()
            for edge in data["edges"]:
                if edge["target"] == current and edge["source"] not in ancestors:
                    ancestors.add(edge["source"])
                    pending.append(edge["source"])
        history = [n for n in data["nodes"] if n["id"] in ancestors]
        history_ids = {n["id"] for n in history}
        runs = [r for r in data["runs"] if r["experiment_id"] in history_ids]
        next_steps = [n for n in history if n["kind"] == "next" and n["status"] in {"active", "proposed"}]
        lines = [f"项目：{data['project']['name']}", f"当前节点：{selected['id']} · {selected['title']}",
                 f"研究支线：{nodes[selected['idea_id']]['title']}", "", "研究记录（解释仍需依据实验判断）："]
        for n in history:
            lines.extend([f"[{n['id']}] {n['kind']} / {n['status']} · {n['title']}", n["body"]])
        lines.append("\n来源关系：")
        lines.extend(f"{e['source']} → {e['target']}：{e['reason']}" for e in data["edges"] if e["source"] in history_ids and e["target"] in history_ids)
        lines.append("\n实际运行：")
        for r in runs:
            lines.append(f"{r['id']} / {r['experiment_id']} / {r['status']} / 指标={encode(r['metrics'])}")
        entries = [e for e in data["entries"] if e["node_id"] in history_ids]
        lines.append("\n原话记录（只追加，当时写下；引用时不要改写，也不要把 Agent 的话当成研究者的意图）：")
        lines.extend(journal.journal_lines(entries) or ["（尚无当时记录的原话）"])
        if any("](assets/" in n["body"] for n in history):
            lines.extend(["", f"正文是 Markdown；其中的图片 assets/文件名 位于 {self.path / 'assets'}，可直接读取查看。"])
        lines.extend(["", "继续研究时保留来源节点；结果、解释与候选下一步分别记录。未知的历史参数或代码状态不要补造。"])
        return {"node": selected, "history": history, "runs": runs, "next_steps": next_steps, "entries": entries,
                "text": "\n".join(lines)}

    def compare(self, left_id, right_id):
        left, right = self.run(left_id), self.run(right_id)

        def differences(a, b):
            def flatten(value, prefix=""):
                result = {}
                for key, val in value.items():
                    path = f"{prefix}.{key}" if prefix else key
                    if isinstance(val, dict) and val:
                        result.update(flatten(val, path))
                    else:
                        result[path] = val
                return result
            a, b = flatten(a or {}), flatten(b or {})
            return [{"key": k, "left": a.get(k), "right": b.get(k),
                     "left_present": k in a, "right_present": k in b}
                    for k in sorted(a.keys() | b.keys()) if k not in a or k not in b or a[k] != b[k]]

        sa, sb = left["snapshot"], right["snapshot"]
        a = {f["path"]: f["sha256"] for f in sa["files"]} if sa else {}
        b = {f["path"]: f["sha256"] for f in sb["files"]} if sb else {}
        return {"left": left, "right": right,
                "parameters": differences(left["actual_params"] if left["actual_params"] is not None else left["params"],
                                          right["actual_params"] if right["actual_params"] is not None else right["params"]),
                "metrics": differences(left["metrics"], right["metrics"]),
                "code": {"comparable": bool(sa and sb), "changed": sorted(k for k in a.keys() & b.keys() if a[k] != b[k]),
                         "only_left": sorted(a.keys() - b.keys()), "only_right": sorted(b.keys() - a.keys())}}
