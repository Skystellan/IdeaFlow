"""Behavior regressions for research history, captured runs and the local API."""
import http.client
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from pathlib import Path

from idea_workbench.runner import artifact, execute_run, import_run, prepare_run
from idea_workbench.store import Store


REPORTING_SCRIPT = '''import json
import os
import sys
from pathlib import Path

params = {"epochs": int(sys.argv[1]), "optimizer": {"lr": 0.1}}
metrics = {"score": 0.25, "loss": 1.0}
Path(os.environ["IDEA_CONFIG_PATH"]).write_text(json.dumps(params))
Path(os.environ["IDEA_METRICS_PATH"]).write_text(json.dumps(metrics))
print("captured-v1")
'''


class WorkbenchTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.project = self.root / "project"
        self.project.mkdir()
        self.store = Store.initialize(self.root / "workbench", "Research", self.project)


class GraphTests(WorkbenchTestCase):
    def test_legacy_migration_keeps_all_45_nodes_and_seven_ideas_on_one_canvas(self):
        legacy_path = self.root / "legacy"
        legacy_path.mkdir()
        database = legacy_path / "research.sqlite3"
        with closing(sqlite3.connect(database)) as db, db:
            db.executescript("""
                PRAGMA foreign_keys=ON;
                CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE nodes(
                    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL,
                    body TEXT NOT NULL, status TEXT NOT NULL,
                    idea_id TEXT NOT NULL REFERENCES nodes(id),
                    created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
                CREATE TABLE edges(
                    source TEXT NOT NULL REFERENCES nodes(id), target TEXT NOT NULL REFERENCES nodes(id),
                    relation TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(source,target));
                CREATE TABLE revisions(
                    id INTEGER PRIMARY KEY, node_id TEXT NOT NULL REFERENCES nodes(id),
                    previous TEXT NOT NULL, changed_at TEXT NOT NULL);
                CREATE TABLE runs(
                    id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL REFERENCES nodes(id), data TEXT NOT NULL);
            """)
            project = {"name": "Existing research", "root": str(self.project)}
            db.execute("INSERT INTO meta VALUES('project',?)", (json.dumps(project),))
            nodes = [dict(id=f"old-{i}", kind="idea" if i < 7 else "experiment", title=f"Record {i}",
                          body="Original evidence", status="paused", idea_id=f"old-{i if i < 7 else i % 7}",
                          created_at="2025-01-01", updated_at="2025-02-01") for i in range(45)]
            db.executemany("INSERT INTO nodes VALUES(:id,:kind,:title,:body,:status,:idea_id,:created_at,:updated_at)", nodes)
            edges = [dict(source=n["idea_id"], target=n["id"], relation="continues", reason="Recorded source")
                     for n in nodes[7:]]
            db.executemany("INSERT INTO edges VALUES(:source,:target,:relation,:reason)", edges)
            run = {"id": "old-run", "experiment_id": "old-7", "status": "imported", "metrics": {"score": 0.5}}
            db.execute("INSERT INTO runs VALUES(?,?,?)", (run["id"], run["experiment_id"], json.dumps(run, indent=2)))
            previous = json.dumps(nodes[7] | {"body": "Earlier explanation"}, indent=2)
            db.execute("INSERT INTO revisions VALUES(9,?,?,?)", ("old-7", previous, "2025-02-01"))
            preserved = {table: db.execute(f"SELECT * FROM {table}").fetchall()
                         for table in ("meta", "edges", "runs", "revisions")}

        # Independent constructors may encounter the old schema at the same time.
        with ThreadPoolExecutor(max_workers=2) as pool:
            stores = list(pool.map(Store, [legacy_path, legacy_path]))
        migrated = stores[0]
        state = migrated.state()
        self.assertEqual(state, stores[1].state())
        self.assertEqual(state["project"], project)
        self.assertEqual(len(state["canvases"]), 1)
        self.assertEqual(state["canvases"][0]["id"], "canvas-main")
        self.assertEqual(state["canvases"][0]["title"], project["name"])
        self.assertTrue(state["canvases"][0]["created_at"])
        self.assertEqual({n["id"]: n for n in state["nodes"]},
                         {n["id"]: n | {"canvas_id": "canvas-main"} for n in nodes})
        self.assertEqual(state["edges"], edges)
        self.assertEqual(state["runs"], [run])
        self.assertEqual(migrated.export()["revisions"][0]["previous"], json.loads(previous))
        with migrated.connect() as db:
            for table, rows in preserved.items():
                self.assertEqual([tuple(r) for r in db.execute(f"SELECT * FROM {table}")], rows)
            self.assertEqual(list(db.execute("PRAGMA foreign_key_check")), [])
        self.assertEqual(Store(legacy_path).state(), state)
        fresh = migrated.add_node(kind="insight", title="Continue migrated evidence", source_ids=["old-7"])
        self.assertEqual(fresh["canvas_id"], "canvas-main")
        self.assertEqual(migrated.edit_node("old-7", status="done")["canvas_id"], "canvas-main")
        revisions = migrated.export()["revisions"]
        self.assertNotIn("canvas_id", revisions[0]["previous"])
        self.assertEqual(revisions[1]["previous"]["canvas_id"], "canvas-main")

    def test_empty_canvases_and_standalone_nodes_persist_with_editable_status(self):
        initial = self.store.state()
        self.assertEqual(initial["nodes"], [])
        self.assertEqual(initial["edges"], [])
        self.assertEqual([(c["id"], c["title"]) for c in initial["canvases"]], [("canvas-main", "Research")])
        canvas = self.store.add_canvas("  Independent canvas  ")
        self.assertEqual(canvas["title"], "Independent canvas")
        self.assertEqual(self.store.state()["nodes"], [])
        for kind in ("idea", "experiment", "insight", "next"):
            node = self.store.add_node(kind=kind, title=kind, canvas_id=canvas["id"])
            self.assertEqual(node["idea_id"], node["id"])
            self.assertEqual(node["canvas_id"], canvas["id"])
            self.assertEqual(self.store.context(node["id"])["history"], [node])
            edited = self.store.edit_node(node["id"], status="done")
            self.assertEqual(edited["canvas_id"], canvas["id"])
            self.assertEqual(Store(self.store.path).node(node["id"]), edited)
        self.assertEqual(self.store.state()["edges"], [])
        self.assertEqual(self.store.state()["canvases"], initial["canvases"] + [canvas])
        default = self.store.add_node(kind="insight", title="Default canvas thought")
        self.assertEqual(default["canvas_id"], "canvas-main")

    def test_sources_inherit_canvas_and_standalone_lineage_but_validate_explicit_idea(self):
        canvas = self.store.add_canvas("Another canvas")
        source = self.store.add_node(kind="experiment", title="Standalone trial", canvas_id=canvas["id"])
        child = self.store.add_node(kind="insight", title="Observation", source_ids=[source["id"]])
        self.assertEqual((child["canvas_id"], child["idea_id"]), (canvas["id"], source["id"]))
        fork = self.store.add_node(kind="idea", title="Fork", source_ids=[child["id"]])
        self.assertEqual((fork["canvas_id"], fork["idea_id"]), (canvas["id"], fork["id"]))
        merged = self.store.add_node(kind="next", title="Next step", source_ids=[source["id"], child["id"]],
                                     canvas_id=canvas["id"], idea_id=fork["id"])
        self.assertEqual(merged["idea_id"], fork["id"])
        main = self.store.add_node(kind="idea", title="Main")
        before = self.store.state()
        for options in ({"source_ids": [source["id"]], "idea_id": source["id"]},
                        {"source_ids": [source["id"]], "idea_id": "missing"},
                        {"source_ids": [source["id"]], "canvas_id": "canvas-main"},
                        {"source_ids": [source["id"], main["id"]]},
                        {"source_ids": [main["id"], source["id"]], "canvas_id": "canvas-main"},
                        {"canvas_id": "missing"}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.store.add_node(kind="insight", title="Invalid", **options)
            self.assertEqual(self.store.state(), before)

    def test_explicit_idea_must_belong_to_the_chosen_canvas(self):
        other_idea = self.store.add_node(kind="idea", title="Other canvas idea")
        canvas = self.store.add_canvas("Chosen canvas")
        source = self.store.add_node(kind="experiment", title="Valid source", canvas_id=canvas["id"])
        local_idea = self.store.add_node(kind="idea", title="Local idea", canvas_id=canvas["id"])
        before = self.store.state()
        for options in ({}, {"canvas_id": canvas["id"]}):
            with self.subTest(options=options):
                with self.assertRaisesRegex(ValueError, "idea_id.*same canvas"):
                    self.store.add_node(kind="insight", title="Invalid lineage", source_ids=[source["id"]],
                                        idea_id=other_idea["id"], **options)
                self.assertEqual(self.store.state(), before)
                self.assertEqual(self.store.context(other_idea["id"])["history"], [other_idea])
        child = self.store.add_node(kind="insight", title="Valid lineage", source_ids=[source["id"]],
                                    idea_id=local_idea["id"])
        self.assertEqual(child["idea_id"], local_idea["id"])
        self.assertEqual({n["canvas_id"] for n in self.store.context(child["id"])["history"]}, {canvas["id"]})
        standalone = self.store.add_node(kind="insight", title="Standalone", canvas_id=canvas["id"],
                                         idea_id=local_idea["id"])
        self.assertEqual(standalone["idea_id"], standalone["id"])

    def test_manual_links_ignore_creation_order_are_idempotent_and_can_be_removed(self):
        older = self.store.add_node(kind="experiment", title="Older target")
        newer = self.store.add_node(kind="insight", title="Newer source")
        idea = self.store.add_node(kind="idea", title="Idea target")
        edge = self.store.add_edge(newer["id"], older["id"], "Connect later")
        self.assertEqual(edge, {"source": newer["id"], "target": older["id"],
                                "relation": "continues", "reason": "Connect later"})
        self.assertEqual(self.store.add_edge(newer["id"], older["id"], "Do not overwrite"), edge)
        fork = self.store.add_edge(older["id"], idea["id"])
        self.assertEqual(fork["relation"], "fork")
        reopened = Store(self.store.path)
        self.assertEqual(reopened.state()["edges"], [edge, fork])
        self.assertEqual({n["id"] for n in reopened.context(older["id"])["history"]}, {older["id"], newer["id"]})
        before = reopened.state()
        with self.assertRaisesRegex(ValueError, "cycle"):
            reopened.add_edge(idea["id"], newer["id"])
        self.assertEqual(reopened.state(), before)
        for _ in range(2):
            self.assertEqual(reopened.remove_edge(newer["id"], older["id"]),
                             {"source": newer["id"], "target": older["id"]})
        self.assertEqual(reopened.state()["nodes"], before["nodes"])
        self.assertEqual(Store(self.store.path).state()["edges"], [fork])
        self.assertEqual(reopened.context(older["id"])["history"], [older])

    def test_links_reject_self_cross_canvas_and_missing_endpoints_without_writes(self):
        left = self.store.add_node(kind="insight", title="Left")
        canvas = self.store.add_canvas("Other")
        right = self.store.add_node(kind="experiment", title="Right", canvas_id=canvas["id"])
        before = self.store.state()
        for source, target in ((left["id"], left["id"]), (left["id"], right["id"]),
                               (left["id"], "missing"), ("missing", left["id"])):
            with self.subTest(source=source, target=target), self.assertRaises(ValueError):
                self.store.add_edge(source, target)
            self.assertEqual(self.store.state(), before)

    def test_concurrent_opposite_connections_cannot_create_a_cycle(self):
        left = self.store.add_node(kind="experiment", title="Left")["id"]
        right = self.store.add_node(kind="experiment", title="Right")["id"]
        ready = threading.Barrier(2)

        def connect(pair):
            ready.wait(timeout=5)
            try:
                return self.store.add_edge(*pair)
            except ValueError as exc:
                self.assertIn("cycle", str(exc))
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(connect, [(left, right), (right, left)]))
        self.assertEqual(sum(r is not None for r in results), 1)
        self.assertEqual(self.store.state()["edges"], [r for r in results if r is not None])

    def test_sources_fork_synthesis_and_revisions_survive_pause_resume_and_reopen(self):
        idea = self.store.add_node(kind="idea", title="Original hypothesis")
        experiment = self.store.add_node(
            kind="experiment", title="Baseline", source_ids=[idea["id"]], reason="Test hypothesis")
        insight = self.store.add_node(
            kind="insight", title="Observed limitation", source_ids=[experiment["id"]], reason="Read result")
        fork = self.store.add_node(
            kind="idea", title="Alternative", body="Original explanation",
            source_ids=[insight["id"]], reason="Explore limitation")
        branch_experiment = self.store.add_node(
            kind="experiment", title="Alternative trial", source_ids=[fork["id"]])
        synthesis = self.store.add_node(
            kind="insight", title="Combined evidence", idea_id=fork["id"],
            source_ids=[insight["id"], branch_experiment["id"]], reason="Compare both branches")
        next_step = self.store.add_node(
            kind="next", title="Follow up", source_ids=[synthesis["id"]])
        unrelated = self.store.add_node(kind="idea", title="Unrelated research")

        self.assertEqual(idea["idea_id"], idea["id"])
        self.assertEqual(experiment["idea_id"], idea["id"])
        self.assertEqual(fork["idea_id"], fork["id"])
        self.assertEqual(branch_experiment["idea_id"], fork["id"])
        self.assertEqual(synthesis["idea_id"], fork["id"])
        self.assertEqual(next_step["status"], "proposed")
        expected_edges = {
            (idea["id"], experiment["id"], "continues", "Test hypothesis"),
            (experiment["id"], insight["id"], "continues", "Read result"),
            (insight["id"], fork["id"], "fork", "Explore limitation"),
            (fork["id"], branch_experiment["id"], "continues", ""),
            (insight["id"], synthesis["id"], "synthesis", "Compare both branches"),
            (branch_experiment["id"], synthesis["id"], "synthesis", "Compare both branches"),
            (synthesis["id"], next_step["id"], "continues", ""),
        }
        paused = self.store.edit_node(fork["id"], status="paused")
        self.assertEqual(self.store.context(fork["id"])["node"]["status"], "paused")
        resumed = self.store.edit_node(fork["id"], status="active", body="Revised explanation")

        reopened = Store(self.store.path)
        self.assertEqual(reopened.state(), self.store.state())
        self.assertEqual(reopened.node(fork["id"]), resumed)
        self.assertEqual(resumed["body"], "Revised explanation")
        self.assertEqual(resumed["status"], "active")
        self.assertEqual(resumed["created_at"], fork["created_at"])
        self.assertEqual(
            {(e["source"], e["target"], e["relation"], e["reason"]) for e in reopened.state()["edges"]},
            expected_edges)
        revisions = reopened.export()["revisions"]
        self.assertEqual([r["node_id"] for r in revisions], [fork["id"], fork["id"]])
        self.assertEqual([r["previous"] for r in revisions], [fork, paused])
        context = reopened.context(next_step["id"])
        self.assertEqual(
            {n["id"] for n in context["history"]},
            {n["id"] for n in (idea, experiment, insight, fork, branch_experiment, synthesis, next_step)})
        self.assertNotIn(unrelated["id"], context["text"])
        self.assertEqual(context["next_steps"], [next_step])

    def test_root_context_includes_upstream_evidence_of_cross_branch_next_step(self):
        root = self.store.add_node(kind="idea", title="Root research")
        base = self.store.add_node(kind="experiment", title="Baseline", source_ids=[root["id"]])
        insight = self.store.add_node(kind="insight", title="Baseline evidence", source_ids=[base["id"]])
        fork = self.store.add_node(kind="idea", title="Fork", source_ids=[insight["id"]])
        experiment = self.store.add_node(kind="experiment", title="Branch trial", source_ids=[fork["id"]])
        branch_insight = self.store.add_node(
            kind="insight", title="Branch evidence", source_ids=[experiment["id"]])
        next_step = self.store.add_node(
            kind="next", title="Apply branch evidence", idea_id=root["id"], source_ids=[branch_insight["id"]])
        unrelated = self.store.add_node(kind="idea", title="Unrelated research")

        context = self.store.context(root["id"])
        self.assertEqual(context["node"], root)
        history_ids = {n["id"] for n in context["history"]}
        self.assertEqual(history_ids, {
            n["id"] for n in (root, base, insight, fork, experiment, branch_insight, next_step)})
        self.assertNotIn(unrelated["id"], history_ids)
        self.assertEqual(context["next_steps"], [next_step])

    def test_unknown_sources_do_not_create_partial_nodes(self):
        idea = self.store.add_node(kind="idea", title="Root")
        before = self.store.state()
        for kind in ("experiment", "insight", "next"):
            for sources in (["missing"], [idea["id"], "missing"]):
                with self.subTest(kind=kind, sources=sources):
                    with self.assertRaises(ValueError):
                        self.store.add_node(kind=kind, title="Invalid", source_ids=sources)
                    self.assertEqual(self.store.state(), before)


class SelectionDeletionTests(WorkbenchTestCase):
    def test_mixed_deletion_preserves_downstream_lineage_runs_revisions_and_artifacts(self):
        idea = self.store.add_node(kind="idea", title="Delete root")
        experiment = self.store.add_node(kind="experiment", title="Delete trial", source_ids=[idea["id"]])
        insight = self.store.add_node(kind="insight", title="Keep evidence", source_ids=[experiment["id"]])
        next_step = self.store.add_node(kind="next", title="Keep next step", source_ids=[insight["id"]])
        fork = self.store.add_node(kind="idea", title="Keep fork", source_ids=[next_step["id"]])
        ongoing = self.store.add_node(kind="experiment", title="Keep active trial", source_ids=[idea["id"]])
        canvas = self.store.add_canvas("Unrelated canvas")
        unrelated = self.store.add_node(kind="idea", title="Unrelated", canvas_id=canvas["id"])
        self.store.edit_node(experiment["id"], status="done")
        insight = self.store.edit_node(insight["id"], body="Preserve this revision")
        metrics = self.root / "metrics.json"
        metrics.write_text('{"score": 0.5}', encoding="utf-8")
        imported = import_run(self.store, experiment["id"], metrics, {})
        self.store.add_run(dict(id="failed-run", experiment_id=experiment["id"], status="failed", metrics=None))
        active = self.store.add_run(dict(id="active-run", experiment_id=ongoing["id"], status="running", metrics=None))
        artifact_path = self.store.path / "runs" / imported["id"] / "metrics.json"
        artifact_contents = artifact_path.read_bytes()
        before = self.store.export()
        selected_edge = {"source": insight["id"], "target": next_step["id"]}

        result = self.store.delete_selection(
            canvas_id="canvas-main", node_ids=[idea["id"], experiment["id"], idea["id"]],
            edges=[selected_edge, selected_edge, {"source": idea["id"], "target": experiment["id"]}])

        self.assertEqual(result, {"nodes": 2, "edges": 4, "runs": 2})
        reopened = Store(self.store.path)
        state = reopened.state()
        survivors = (insight, next_step, fork, ongoing, unrelated)
        expected = {n["id"]: n | {"idea_id": n["id"]} for n in survivors}
        self.assertEqual({n["id"]: n for n in state["nodes"]}, expected)
        self.assertEqual(state["edges"], [e for e in before["edges"] if e["source"] == next_step["id"]])
        self.assertEqual(state["runs"], [active])
        self.assertEqual(state["canvases"], before["canvases"])
        self.assertEqual(reopened.export()["revisions"],
                         [r for r in before["revisions"] if r["node_id"] == insight["id"]])
        self.assertEqual(artifact_path.read_bytes(), artifact_contents)
        for node in survivors:
            context = reopened.context(node["id"])
            self.assertEqual(context["node"], expected[node["id"]])
            self.assertTrue({n["id"] for n in context["history"]} <= expected.keys())
        self.assertEqual({n["id"] for n in reopened.context(fork["id"])["history"]},
                         {next_step["id"], fork["id"]})
        child = reopened.add_node(kind="next", title="Continue surviving evidence", source_ids=[insight["id"]])
        self.assertEqual(child["idea_id"], insight["id"])
        self.assertIn(insight["id"], {n["id"] for n in reopened.context(child["id"])["history"]})
        with reopened.connect() as db:
            self.assertEqual(list(db.execute("PRAGMA foreign_key_check")), [])

    def test_edge_only_deletion_deduplicates_and_preserves_active_runs_and_nodes(self):
        idea = self.store.add_node(kind="idea", title="Keep root")
        experiment = self.store.add_node(kind="experiment", title="Keep trial", source_ids=[idea["id"]])
        self.store.add_node(kind="insight", title="Keep downstream", source_ids=[experiment["id"]])
        self.store.edit_node(experiment["id"], body="Keep revision")
        self.store.add_run(dict(id="running", experiment_id=experiment["id"], status="running", metrics=None))
        before = self.store.export()
        edge = {"source": idea["id"], "target": experiment["id"]}
        self.assertEqual(self.store.delete_selection(canvas_id="canvas-main", node_ids=[], edges=[edge] * 5000),
                         {"nodes": 0, "edges": 1, "runs": 0})
        self.assertEqual(self.store.delete_selection(canvas_id="canvas-main", node_ids=[], edges=[edge]),
                         {"nodes": 0, "edges": 0, "runs": 0})
        after = self.store.export()
        self.assertEqual(after["edges"], before["edges"][1:])
        for key in ("nodes", "runs", "revisions", "canvases"):
            self.assertEqual(after[key], before[key])

    def test_queued_and_running_runs_reject_the_entire_selection(self):
        for status in ("queued", "running"):
            with self.subTest(status=status):
                idea = self.store.add_node(kind="idea", title=status)
                experiment = self.store.add_node(kind="experiment", title="Active", source_ids=[idea["id"]])
                self.store.add_node(kind="insight", title="Keep lineage", source_ids=[experiment["id"]])
                self.store.edit_node(idea["id"], body="Keep revision")
                self.store.add_run(dict(id=f"finished-{status}", experiment_id=experiment["id"],
                                        status="succeeded", metrics=None))
                self.store.add_run(dict(id=status, experiment_id=experiment["id"], status=status, metrics=None))
                before = self.store.state()
                revisions = self.store.export()["revisions"]
                with self.assertRaisesRegex(ValueError, "queued or running"):
                    self.store.delete_selection(
                        canvas_id="canvas-main", node_ids=[idea["id"], experiment["id"]],
                        edges=[{"source": idea["id"], "target": experiment["id"]}])
                self.assertEqual(self.store.state(), before)
                self.assertEqual(self.store.export()["revisions"], revisions)

    def test_invalid_selection_fields_and_cross_canvas_endpoints_do_not_write(self):
        idea = self.store.add_node(kind="idea", title="Keep root")
        child = self.store.add_node(kind="insight", title="Keep child", source_ids=[idea["id"]])
        canvas = self.store.add_canvas("Other")
        other = self.store.add_node(kind="idea", title="Other", canvas_id=canvas["id"])
        edge = {"source": idea["id"], "target": child["id"]}
        valid = dict(canvas_id="canvas-main", node_ids=[idea["id"]], edges=[edge])
        invalid = [
            {"canvas_id": value} for value in (None, [], 42, " ", "x" * 201, "missing", canvas["id"])
        ] + [
            {"node_ids": value} for value in (None, idea["id"], {}, [None], [[]], [42], [" "],
                                              ["x" * 201], ["missing"], [idea["id"], other["id"]],
                                              [idea["id"]] * 1001)
        ] + [
            {"edges": value} for value in (None, {}, "edges", [None], [[]], [{}], [edge | {"extra": True}],
                                           [{"source": idea["id"]}], [edge | {"source": None}],
                                           [edge | {"source": []}], [edge | {"source": " "}],
                                           [edge | {"source": "x" * 201}], [edge | {"target": 42}],
                                           [edge | {"target": {}}], [edge | {"target": " "}],
                                           [edge | {"target": "x" * 201}], [edge | {"target": "missing"}],
                                           [edge | {"source": "missing"}], [edge | {"target": idea["id"]}],
                                           [edge | {"target": other["id"]}], [edge | {"source": other["id"]}],
                                           [edge] * 5001)
        ] + [{"node_ids": [], "edges": []}]
        before = self.store.state()
        for index, changes in enumerate(invalid):
            with self.subTest(case=index), self.assertRaises(ValueError):
                self.store.delete_selection(**(valid | changes))
            self.assertEqual(self.store.state(), before)
        self.assertEqual(self.store.delete_selection(**(valid | {"node_ids": [idea["id"]] * 1000})),
                         {"nodes": 1, "edges": 1, "runs": 0})
        self.assertEqual(self.store.node(child["id"])["idea_id"], child["id"])


class CLITests(WorkbenchTestCase):
    def test_canvas_node_link_unlink_commands_persist(self):
        def cli(*args):
            result = subprocess.run(
                [sys.executable, "-m", "idea_workbench", "--store", str(self.store.path), *args],
                cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

        canvas = cli("canvas", "--title", "CLI canvas")
        target = cli("node", "--kind", "experiment", "--title", "Trial", "--canvas", canvas["id"])
        source = cli("node", "--kind", "insight", "--title", "Thought", "--canvas", canvas["id"])
        self.assertEqual(target["canvas_id"], canvas["id"])
        edge = cli("link", "--source", source["id"], "--target", target["id"], "--reason", "Later connection")
        self.assertEqual(self.store.state()["edges"], [edge])
        removed = cli("unlink", "--source", source["id"], "--target", target["id"])
        self.assertEqual(removed, {"source": source["id"], "target": target["id"]})
        self.assertEqual(self.store.state()["edges"], [])
        self.assertEqual(len(self.store.state()["nodes"]), 2)


class RunnerTests(WorkbenchTestCase):
    def setUp(self):
        super().setUp()
        idea = self.store.add_node(kind="idea", title="Hypothesis")
        self.experiment = self.store.add_node(
            kind="experiment", title="Trial", source_ids=[idea["id"]])
        self.script = self.project / "train.py"
        self.script.write_text(REPORTING_SCRIPT, encoding="utf-8")

    def prepare(self, includes=("train.py",), epochs=3):
        return prepare_run(self.store, self.experiment["id"],
                           [sys.executable, "train.py", str(epochs)], list(includes), {"epochs": 99})

    def test_standalone_experiment_can_run_and_return_context(self):
        self.experiment = self.store.add_node(kind="experiment", title="Independent trial")
        run = execute_run(self.store, self.prepare()["id"])
        self.assertEqual(run["status"], "succeeded", run["error"])
        context = self.store.context(self.experiment["id"])
        self.assertEqual(context["history"], [self.experiment])
        self.assertEqual(context["runs"], [run])

    def test_execution_uses_captured_relative_and_absolute_code_paths(self):
        for script_path in ("train.py", str(self.script)):
            with self.subTest(script_path=script_path):
                self.script.write_text(REPORTING_SCRIPT, encoding="utf-8")
                command = [sys.executable, script_path, "3"]
                prepared = prepare_run(
                    self.store, self.experiment["id"], command, ["train.py"], {"epochs": 99})
                self.assertEqual(prepared["status"], "queued")
                self.assertIsNone(prepared["actual_params"])
                self.assertIsNone(prepared["metrics"])
                self.script.write_text('raise SystemExit("original file was changed")\n', encoding="utf-8")

                # execute_run installs signal handlers and must stay on the main thread.
                completed = execute_run(self.store, prepared["id"])
                self.assertEqual(completed["status"], "succeeded", completed["error"])
                self.assertEqual(completed["exit_code"], 0)
                self.assertEqual(completed["command"], command)
                self.assertEqual(completed["params"], {"epochs": 99})
                self.assertEqual(completed["actual_params"], {"epochs": 3, "optimizer": {"lr": 0.1}})
                self.assertEqual(completed["metrics"], {"score": 0.25, "loss": 1.0})
                self.assertIsNotNone(completed["started_at"])
                self.assertIsNotNone(completed["finished_at"])
                self.assertEqual(artifact(self.store, prepared["id"], "stdout.log"), "captured-v1\n")
                self.assertEqual(Store(self.store.path).run(prepared["id"]), completed)

    def test_exit_status_without_artifacts_does_not_invent_parameters_or_metrics(self):
        for exit_code, status in ((0, "succeeded"), (7, "failed")):
            with self.subTest(exit_code=exit_code):
                self.script.write_text(
                    f'import sys\nprint("no measurements", file=sys.stderr)\nsys.exit({exit_code})\n',
                    encoding="utf-8")
                run = execute_run(self.store, self.prepare()["id"])
                self.assertEqual(run["status"], status)
                self.assertEqual(run["exit_code"], exit_code)
                self.assertIsNone(run["actual_params"])
                self.assertIsNone(run["metrics"])
                self.assertEqual(run["params"], {"epochs": 99})
                self.assertEqual(artifact(self.store, run["id"], "stderr.log"), "no measurements\n")
                if exit_code:
                    self.assertIn(str(exit_code), run["error"])
                else:
                    self.assertIsNone(run["error"])

    def test_nonzero_exit_preserves_reported_observations_but_is_failed(self):
        self.script.write_text(REPORTING_SCRIPT + "sys.exit(7)\n", encoding="utf-8")
        run = execute_run(self.store, self.prepare()["id"])
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["exit_code"], 7)
        self.assertEqual(run["metrics"], {"score": 0.25, "loss": 1.0})
        self.assertEqual(run["actual_params"], {"epochs": 3, "optimizer": {"lr": 0.1}})

    def test_invalid_metrics_fail_a_zero_exit_run_without_inventing_observations(self):
        invalid_metrics = '{"score":'
        self.script.write_text(
            REPORTING_SCRIPT.replace("json.dumps(metrics)", repr(invalid_metrics)), encoding="utf-8")
        run = execute_run(self.store, self.prepare()["id"])
        self.assertEqual(run["exit_code"], 0)
        self.assertEqual(run["status"], "failed")
        self.assertIn("Invalid metrics.json:", run["error"])
        self.assertIsNone(run["metrics"])
        self.assertEqual(run["actual_params"], {"epochs": 3, "optimizer": {"lr": 0.1}})
        self.assertIsNotNone(run["finished_at"])
        self.assertEqual(artifact(self.store, run["id"], "metrics.json"), invalid_metrics)

    def test_compare_reports_actual_parameters_metrics_and_source_changes(self):
        for name in ("common.py", "old.py", "new.py"):
            (self.project / name).write_text("# source file\n", encoding="utf-8")
        left = execute_run(self.store, self.prepare(["train.py", "common.py", "old.py"])["id"])
        self.script.write_text(
            REPORTING_SCRIPT.replace('"lr": 0.1', '"lr": 0.2, "clip": None')
            .replace('"score": 0.25, "loss": 1.0', '"score": 0.5, "auc": 0.9'), encoding="utf-8")
        right = execute_run(self.store, self.prepare(["train.py", "common.py", "new.py"], epochs=7)["id"])
        self.assertEqual((left["status"], right["status"]), ("succeeded", "succeeded"))
        comparison = Store(self.store.path).compare(left["id"], right["id"])
        self.assertEqual(comparison["left"], left)
        self.assertEqual(comparison["right"], right)
        self.assertEqual(comparison["parameters"], [
            {"key": "epochs", "left": 3, "right": 7, "left_present": True, "right_present": True},
            {"key": "optimizer.clip", "left": None, "right": None, "left_present": False, "right_present": True},
            {"key": "optimizer.lr", "left": 0.1, "right": 0.2, "left_present": True, "right_present": True},
        ])
        self.assertEqual(comparison["metrics"], [
            {"key": "auc", "left": None, "right": 0.9, "left_present": False, "right_present": True},
            {"key": "loss", "left": 1.0, "right": None, "left_present": True, "right_present": False},
            {"key": "score", "left": 0.25, "right": 0.5, "left_present": True, "right_present": True},
        ])
        self.assertEqual(comparison["code"], {
            "comparable": True, "changed": ["train.py"], "only_left": ["old.py"], "only_right": ["new.py"]})

    def test_import_keeps_historical_code_and_actual_parameters_unknown(self):
        metrics_path = self.root / "historical-metrics.json"
        metrics_path.write_text('{"score": 0.75}', encoding="utf-8")
        run = import_run(self.store, self.experiment["id"], metrics_path, {"epochs": 99})
        metrics_path.unlink()
        self.assertEqual(run["origin"], "imported")
        self.assertEqual(run["status"], "imported")
        self.assertEqual(run["params"], {"epochs": 99})
        self.assertEqual(run["metrics"], {"score": 0.75})
        for field in ("snapshot", "actual_params", "exit_code", "started_at"):
            self.assertIsNone(run[field], field)
        self.assertEqual(run["command"], [])
        self.assertIn("actual parameters", run["import_note"])
        self.assertIn("code", run["import_note"])
        self.assertIn("not captured", run["import_note"])
        self.assertEqual(json.loads(artifact(self.store, run["id"], "metrics.json")), {"score": 0.75})
        reopened = Store(self.store.path)
        self.assertEqual(reopened.run(run["id"]), run)
        managed = self.prepare()
        self.assertFalse(reopened.compare(run["id"], managed["id"])["code"]["comparable"])

    def test_git_snapshot_captures_dirty_and_untracked_sources_without_changing_index(self):
        def git(*args):
            return subprocess.run(
                ["git", "-C", str(self.project), "-c", "core.hooksPath=/dev/null", *args],
                check=True, capture_output=True, text=True, timeout=10).stdout

        git("init", "--quiet")
        git("add", "train.py")
        git("-c", "user.name=Idea Workbench Test", "-c", "user.email=idea-workbench-test@example.invalid",
            "-c", "commit.gpgsign=false", "commit", "-qm", "Initial test source")
        head = git("rev-parse", "HEAD").strip()
        self.script.write_text(REPORTING_SCRIPT.replace("captured-v1", "staged-v2"), encoding="utf-8")
        git("add", "train.py")
        working_source = REPORTING_SCRIPT.replace("captured-v1", "working-v3")
        self.script.write_text(working_source, encoding="utf-8")
        helper_source = 'VALUE = "untracked-helper"\n'
        (self.project / "helper.py").write_text(helper_source, encoding="utf-8")
        before_status = git("status", "--porcelain", "--untracked-files=all")
        before_staged = git("diff", "--cached", "--no-ext-diff", "--no-textconv")
        self.assertIn("MM train.py", before_status)
        self.assertIn("?? helper.py", before_status)
        self.assertIn('+print("staged-v2")', before_staged)

        run = self.prepare(["train.py", "helper.py"])
        self.assertEqual(run["snapshot"]["git_commit"], head)
        self.assertIs(run["snapshot"]["dirty"], True)
        self.assertEqual({f["path"] for f in run["snapshot"]["files"]}, {"train.py", "helper.py"})
        patch = artifact(self.store, run["id"], "git.patch")
        self.assertIn('-print("captured-v1")', patch)
        self.assertIn('+print("working-v3")', patch)
        source = self.store.path / "runs" / run["id"] / "source"
        self.assertEqual((source / "train.py").read_text(encoding="utf-8"), working_source)
        self.assertEqual((source / "helper.py").read_text(encoding="utf-8"), helper_source)
        self.assertEqual(git("rev-parse", "HEAD").strip(), head)
        self.assertEqual(git("status", "--porcelain", "--untracked-files=all"), before_status)
        self.assertEqual(git("diff", "--cached", "--no-ext-diff", "--no-textconv"), before_staged)

    def test_snapshot_rejects_absolute_paths_and_parent_traversal(self):
        outside = self.root / "outside.py"
        outside.write_text("# outside project\n", encoding="utf-8")
        for pattern in (str(outside), "../outside.py", "sub/../../outside.py"):
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(ValueError, "relative paths within the project"):
                    self.prepare([pattern])
                self.assertEqual(self.store.state()["runs"], [])

    def test_snapshot_excludes_private_files_even_when_explicitly_selected(self):
        private_paths = (".env", ".env.local", ".aws/credentials", "credentials.json", "identity.pem", ".ssh/id_rsa")
        for name in private_paths:
            path = self.project / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic-private-content", encoding="utf-8")
        run = self.prepare(["**/*"])
        self.assertEqual([f["path"] for f in run["snapshot"]["files"]], ["train.py"])
        source = self.store.path / "runs" / run["id"] / "source"
        self.assertEqual([p.relative_to(source).as_posix() for p in source.rglob("*") if p.is_file()], ["train.py"])
        for name in private_paths:
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "No eligible source"):
                self.prepare([name])

    def test_snapshot_rejects_symlink_files_and_symlink_parent_directories(self):
        external = self.root / "external"
        external.mkdir()
        (external / "outside.py").write_text("# outside project\n", encoding="utf-8")
        (self.project / "linked.py").symlink_to(external / "outside.py")
        (self.project / "linked_directory").symlink_to(external, target_is_directory=True)
        for pattern in ("linked.py", "linked_directory", "linked_directory/outside.py"):
            with self.subTest(pattern=pattern):
                with self.assertRaisesRegex(ValueError, "Symlinks"):
                    self.prepare([pattern])
                self.assertEqual(self.store.state()["runs"], [])

    def test_artifact_allows_recorded_names_but_rejects_paths_and_file_symlinks(self):
        run = execute_run(self.store, self.prepare()["id"])
        self.assertEqual(json.loads(artifact(self.store, run["id"], "metrics.json")), run["metrics"])
        outside = self.root / "outside.txt"
        outside.write_text("synthetic-private-content", encoding="utf-8")
        for name in (str(outside), "../outside.txt", "source/train.py", "../metrics.json"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                artifact(self.store, run["id"], name)
        with self.assertRaises(ValueError):
            artifact(self.store, "../../outside", "metrics.json")
        path = self.store.path / "runs" / run["id"] / "metrics.json"
        path.unlink()
        path.symlink_to(outside)
        with self.assertRaises(ValueError):
            artifact(self.store, run["id"], "metrics.json")

    def test_artifact_rejects_a_run_directory_symlink_to_external_files(self):
        run = self.prepare()
        directory = self.store.path / "runs" / run["id"]
        directory.rename(self.root / "saved-run")
        external = self.root / "external-artifacts"
        external.mkdir()
        (external / "metrics.json").write_text('{"private": "outside-run"}', encoding="utf-8")
        directory.symlink_to(external, target_is_directory=True)
        with self.assertRaises(ValueError):
            artifact(self.store, run["id"], "metrics.json")


class HTTPTests(WorkbenchTestCase):
    def setUp(self):
        super().setUp()
        from idea_workbench.server import create_server

        self.server = create_server(self.store, port=0)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)
        self.origin = f"http://127.0.0.1:{self.server.server_port}"
        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertTrue(state["csrf_token"])
        self.headers = {"Origin": self.origin, "X-Idea-Token": state["csrf_token"], "Sec-Fetch-Site": "same-origin"}

    def request(self, method, path, body=None, headers=None, raw=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body if raw or body is None else json.dumps(body),
                               headers={"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_canvas_scripts_are_served_with_same_origin_policy(self):
        for path in ("/static/app.js", "/static/graph-layout.js"):
            with self.subTest(path=path):
                connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
                try:
                    connection.request("GET", path)
                    response = connection.getresponse()
                    self.assertEqual(response.status, 200)
                    self.assertIn("text/javascript", response.getheader("Content-Type"))
                    self.assertIn("script-src 'self'", response.getheader("Content-Security-Policy"))
                    self.assertTrue(response.read())
                finally:
                    connection.close()
        self.assertEqual(self.request("GET", "/static/../store.py")[0], 404)

    def test_same_origin_create_read_update_preserves_sources_and_history(self):
        status, idea = self.request("POST", "/api/nodes", {"kind": "idea", "title": "HTTP idea"}, self.headers)
        self.assertEqual(status, 201)
        status, experiment = self.request("POST", "/api/nodes", {
            "kind": "experiment", "title": "HTTP trial", "source_ids": [idea["id"]], "reason": "Test idea"}, self.headers)
        self.assertEqual(status, 201)
        status, edited = self.request("PATCH", f"/api/nodes/{idea['id']}", {
            "title": "Edited idea", "body": "Keep this explanation", "status": "paused"}, self.headers)
        self.assertEqual(status, 200)
        self.assertEqual((edited["title"], edited["body"], edited["status"]),
                         ("Edited idea", "Keep this explanation", "paused"))
        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertEqual({n["id"]: n for n in state["nodes"]}, {idea["id"]: edited, experiment["id"]: experiment})
        self.assertEqual(state["edges"], [{"source": idea["id"], "target": experiment["id"],
                                           "relation": "continues", "reason": "Test idea"}])
        status, context = self.request("GET", f"/api/context?node={experiment['id']}")
        self.assertEqual(status, 200)
        self.assertEqual({n["id"] for n in context["history"]}, {idea["id"], experiment["id"]})
        status, exported = self.request("GET", "/api/export")
        self.assertEqual(status, 200)
        self.assertEqual([r["previous"] for r in exported["revisions"]], [idea])
        self.assertEqual(Store(self.store.path).node(idea["id"]), edited)

    def test_create_canvas_and_disconnected_nodes_then_link_edit_and_unlink(self):
        status, canvas = self.request("POST", "/api/canvases", {"title": "HTTP canvas"}, self.headers)
        self.assertEqual(status, 201)
        self.assertEqual(set(canvas), {"id", "title", "created_at"})
        status, empty = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.assertIn(canvas, empty["canvases"])
        self.assertEqual(empty["nodes"], [])
        nodes = []
        for kind in ("experiment", "insight"):
            status, node = self.request("POST", "/api/nodes", {
                "kind": kind, "title": kind, "canvas_id": canvas["id"]}, self.headers)
            self.assertEqual(status, 201)
            self.assertEqual(node["canvas_id"], canvas["id"])
            nodes.append(node)
        endpoints = {"source": nodes[1]["id"], "target": nodes[0]["id"]}
        status, edge = self.request("POST", "/api/edges", endpoints | {"reason": "Connect later"}, self.headers)
        self.assertEqual(status, 201)
        self.assertEqual(self.request("POST", "/api/edges", endpoints, self.headers), (201, edge))
        self.assertEqual(self.request("POST", "/api/edges", {
            "source": nodes[0]["id"], "target": nodes[1]["id"]}, self.headers)[0], 400)
        status, edited = self.request("PATCH", f"/api/nodes/{nodes[0]['id']}", {"status": "done"}, self.headers)
        self.assertEqual(status, 200)
        self.assertEqual((edited["status"], edited["canvas_id"]), ("done", canvas["id"]))
        self.assertEqual(self.request("GET", "/api/state")[1]["edges"], [edge])
        self.assertEqual(self.request("DELETE", "/api/edges", endpoints, self.headers), (200, endpoints))
        self.assertEqual(self.request("DELETE", "/api/edges", endpoints, self.headers), (200, endpoints))
        state = self.request("GET", "/api/state")[1]
        self.assertEqual(state["edges"], [])
        self.assertEqual(state["nodes"], [edited, nodes[1]])
        self.assertEqual(Store(self.store.path).state()["canvases"], state["canvases"])

    def test_delete_selection_rejects_invalid_targets_and_active_runs_then_returns_counts(self):
        idea = self.store.add_node(kind="idea", title="Root")
        experiment = self.store.add_node(kind="experiment", title="Trial", source_ids=[idea["id"]])
        insight = self.store.add_node(kind="insight", title="Evidence", source_ids=[experiment["id"]])
        canvas = self.store.add_canvas("Other")
        other = self.store.add_node(kind="idea", title="Keep other canvas", canvas_id=canvas["id"])
        self.store.add_run(dict(id="active", experiment_id=experiment["id"], status="queued", metrics=None))
        selection = dict(canvas_id="canvas-main", node_ids=[idea["id"]], edges=[])
        before = self.store.state()
        for changes in ({"node_ids": [idea["id"], experiment["id"]]}, {"node_ids": [other["id"]]},
                        {"node_ids": ["missing"]}, {"canvas_id": "missing"}, {"node_ids": []},
                        {"node_ids": None}, {"edges": None}, {"canvas_id": []},
                        {"edges": [{"source": idea["id"], "target": other["id"]}]},
                        {"edges": [{"source": idea["id"]}]},
                        {"edges": [{"source": idea["id"], "target": []}]}):
            with self.subTest(changes=changes):
                status, response = self.request("DELETE", "/api/selection", selection | changes, self.headers)
                self.assertEqual(status, 400)
                self.assertIn("error", response)
                self.assertEqual(self.store.state(), before)

        self.assertEqual(self.request("DELETE", "/api/selection", selection, self.headers),
                         (200, {"nodes": 1, "edges": 1, "runs": 0}))
        status, context = self.request("GET", f"/api/context?node={insight['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(context["node"]["idea_id"], insight["id"])
        self.assertEqual({n["id"] for n in context["history"]}, {experiment["id"], insight["id"]})
        self.store.update_run("active", status="succeeded")
        self.assertEqual(self.request("DELETE", "/api/selection",
                                      selection | {"node_ids": [experiment["id"]]}, self.headers),
                         (200, {"nodes": 1, "edges": 1, "runs": 1}))
        state = self.request("GET", "/api/state")[1]
        self.assertEqual({n["id"] for n in state["nodes"]}, {insight["id"], other["id"]})
        self.assertEqual(state["edges"], [])
        self.assertEqual(state["runs"], [])

    def test_untrusted_host_or_origin_cannot_read_state_or_csrf_token(self):
        for headers in ({"Host": "attacker.example"}, {"Host": "127.0.0.1:1"},
                        {"Origin": "https://attacker.example"}, {"Origin": "null"},
                        {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, response = self.request("GET", "/api/state", headers=headers)
                self.assertEqual(status, 403)
                self.assertNotIn("csrf_token", response)

    def test_mutations_require_token_and_same_origin_without_changing_store(self):
        idea = self.store.add_node(kind="idea", title="Keep unchanged")
        child = self.store.add_node(kind="experiment", title="Keep connection", source_ids=[idea["id"]])
        before = self.store.state()
        invalid_headers = [
            {"Origin": self.origin},
            self.headers | {"X-Idea-Token": "incorrect-token"},
            self.headers | {"Origin": "https://attacker.example"},
            self.headers | {"Host": "attacker.example", "Origin": "http://attacker.example"},
            self.headers | {"Sec-Fetch-Site": "cross-site"},
        ]
        for method, path, body in (("POST", "/api/nodes", {"kind": "idea", "title": "Unauthorized"}),
                                   ("PATCH", f"/api/nodes/{idea['id']}", {"title": "Unauthorized"}),
                                   ("POST", "/api/canvases", {"title": "Unauthorized"}),
                                   ("POST", "/api/edges", {"source": child["id"], "target": idea["id"]}),
                                   ("DELETE", "/api/edges", {"source": idea["id"], "target": child["id"]}),
                                   ("DELETE", "/api/selection", {
                                       "canvas_id": "canvas-main", "node_ids": [idea["id"]], "edges": []})):
            for headers in invalid_headers:
                with self.subTest(method=method, headers=headers):
                    self.assertEqual(self.request(method, path, body, headers)[0], 403)
                    self.assertEqual(self.store.state(), before)
        self.assertEqual(self.store.export()["revisions"], [])

    def test_new_routes_keep_json_body_boundaries_and_validate_inputs(self):
        source = self.store.add_node(kind="insight", title="Source")
        target = self.store.add_node(kind="experiment", title="Target")
        self.store.add_edge(source["id"], target["id"])
        endpoints = {"source": source["id"], "target": target["id"]}
        before = self.store.state()
        for method, path, valid in (("POST", "/api/canvases", {"title": "Canvas"}),
                                    ("POST", "/api/edges", endpoints), ("DELETE", "/api/edges", endpoints),
                                    ("DELETE", "/api/selection", {
                                        "canvas_id": "canvas-main", "node_ids": [source["id"]], "edges": [endpoints]})):
            cases = [(valid, {"Content-Type": "text/plain"}, False, 415),
                     (valid, {"Content-Length": "1048577"}, False, 413),
                     (None, {}, False, 413), ([], {}, False, 400),
                     ("{", {}, True, 400), ({}, {}, False, 400),
                     (valid | {"unexpected": True}, {}, False, 400)]
            for body, headers, raw, expected in cases:
                with self.subTest(method=method, path=path, body=body, headers=headers):
                    self.assertEqual(self.request(method, path, body, self.headers | headers, raw=raw)[0], expected)
                    self.assertEqual(self.store.state(), before)
        for method, path, body in (
                ("POST", "/api/canvases", {"title": " "}),
                ("POST", "/api/canvases", {"title": 42}),
                ("POST", "/api/canvases", {"title": "x" * 201}),
                ("POST", "/api/edges", endpoints | {"reason": "x" * 4001}),
                ("POST", "/api/edges", endpoints | {"source": []}),
                ("POST", "/api/edges", endpoints | {"target": "missing"}),
                ("DELETE", "/api/edges", endpoints | {"target": None}),
                ("POST", "/api/nodes", {"kind": "insight", "title": "Invalid", "canvas_id": []}),
                ("POST", "/api/nodes", {"kind": "insight", "title": "Invalid", "canvas_id": "missing"})):
            with self.subTest(method=method, path=path, body=body):
                self.assertEqual(self.request(method, path, body, self.headers)[0], 400)
                self.assertEqual(self.store.state(), before)

    def test_api_cannot_run_commands_even_with_valid_authorization(self):
        idea = self.store.add_node(kind="idea", title="Research")
        experiment = self.store.add_node(kind="experiment", title="Trial", source_ids=[idea["id"]])
        before = self.store.state()
        marker = self.root / "command-executed"
        command = [sys.executable, "-c", f"from pathlib import Path; Path({str(marker)!r}).write_text('executed')"]
        requests = [
            ("POST", "/api/run", {"experiment_id": experiment["id"], "command": command}, 404),
            ("POST", "/api/nodes", {"kind": "idea", "title": "Command", "command": command}, 400),
            ("PATCH", f"/api/nodes/{experiment['id']}", {"command": command}, 400),
        ]
        for method, path, body, expected_status in requests:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.request(method, path, body, self.headers)[0], expected_status)
                self.assertEqual(self.store.state(), before)
                self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
