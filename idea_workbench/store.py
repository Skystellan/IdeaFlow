"""SQLite research graph shared by the CLI, web UI and experiment worker."""
from __future__ import annotations

import json
import sqlite3
import uuid
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path

KINDS = {"idea", "experiment", "insight", "next"}
STATUSES = {"active", "paused", "done", "proposed"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


def text_field(value, label, limit, required=False):
    if not isinstance(value, str) or len(value) > limit or (required and not value.strip()):
        raise ValueError(f"{label} must be {'non-empty ' if required else ''}text, at most {limit} characters")
    return value.strip()


class Store:
    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        self.db = self.path / "research.sqlite3"
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
        if kind not in KINDS:
            raise ValueError("kind must be idea, experiment, insight or next")
        title = text_field(title, "title", 200, True)
        body = text_field(body, "body", 20000)
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

    def edit_node(self, node_id, **changes):
        if not changes or set(changes) - {"title", "body", "status"}:
            raise ValueError("Only title, body and status can be edited")
        if "title" in changes:
            changes["title"] = text_field(changes["title"], "title", 200, True)
        if "body" in changes:
            changes["body"] = text_field(changes["body"], "body", 20000)
        if "status" in changes and changes["status"] not in STATUSES:
            raise ValueError("Invalid node status")
        with self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            old = self._node(db, node_id)
            node = old | changes | {"updated_at": now()}
            db.execute("INSERT INTO revisions(node_id,previous,changed_at) VALUES(?,?,?)", (node_id, encode(old), node["updated_at"]))
            db.execute("UPDATE nodes SET title=:title,body=:body,status=:status,updated_at=:updated_at WHERE id=:id", node)
        return node

    def state(self):
        with self.connect() as db:
            db.execute("BEGIN")
            return {
                "project": json.loads(db.execute("SELECT value FROM meta WHERE key='project'").fetchone()[0]),
                "canvases": [dict(r) for r in db.execute("SELECT * FROM canvases ORDER BY created_at,id")],
                "nodes": [dict(r) for r in db.execute("SELECT * FROM nodes ORDER BY created_at,id")],
                "edges": [dict(r) for r in db.execute("SELECT * FROM edges ORDER BY rowid")],
                "runs": [json.loads(r[0]) for r in db.execute("SELECT data FROM runs ORDER BY rowid")],
            }

    def export(self):
        data = self.state()
        with self.connect() as db:
            data["revisions"] = [dict(r) | {"previous": json.loads(r["previous"])} for r in db.execute("SELECT * FROM revisions ORDER BY id")]
        return {"schema_version": 1, "exported_at": now(), **data}

    def add_run(self, run):
        with self.connect() as db:
            if self._node(db, run["experiment_id"])["kind"] != "experiment":
                raise ValueError("Runs must belong to an experiment")
            db.execute("INSERT INTO runs VALUES(?,?,?)", (run["id"], run["experiment_id"], encode(run)))
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
        lines.extend(["", "继续研究时保留来源节点；结果、解释与候选下一步分别记录。未知的历史参数或代码状态不要补造。"])
        return {"node": selected, "history": history, "runs": runs, "next_steps": next_steps, "text": "\n".join(lines)}

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
