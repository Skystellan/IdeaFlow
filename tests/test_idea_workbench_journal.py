"""Append-only journal: verbatim intent, expectations, decisions and reactions."""
import http.client
import json
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import closing
from pathlib import Path

from idea_workbench.journal import frontier
from idea_workbench.runner import execute_run, import_run, prepare_run
from idea_workbench.store import Store

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = '''import json
import os
from pathlib import Path

Path(os.environ["IDEA_METRICS_PATH"]).write_text(json.dumps({"loss": 0.5}))
'''
WHY = "先试一下 A，看看会不会好一些。暂时没想清楚为什么。"


class JournalTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.project = self.root / "project"
        self.project.mkdir()
        (self.project / "train.py").write_text(SCRIPT, encoding="utf-8")
        self.store = Store.initialize(self.root / "workbench", "Research", self.project)
        self.idea = self.store.add_node(kind="idea", title="经验内化后会怎样？")
        self.experiment = self.store.add_node(kind="experiment", title="最小对照", source_ids=[self.idea["id"]])

    def prepare(self, **journal):
        return prepare_run(self.store, self.experiment["id"], [sys.executable, "train.py"], ["train.py"], {}, **journal)

    def raw(self, sql, *args):
        with closing(sqlite3.connect(self.store.db)) as db, db:
            return db.execute(sql, args).fetchall()


class JournalStoreTests(JournalTestCase):
    def test_entries_keep_the_words_and_appear_in_state_and_export(self):
        entry = self.store.add_entry(node_id=self.experiment["id"], kind="note", author="human", text=f"  {WHY}\n")
        self.assertTrue(entry["id"].startswith("j-"))
        self.assertEqual((entry["text"], entry["author"], entry["kind"], entry["via"]), (WHY, "human", "note", "cli"))
        self.assertIsNone(entry["run_id"])
        self.assertEqual(self.store.state()["entries"], [entry])
        self.assertEqual(self.store.export()["entries"], [entry])
        self.assertEqual(self.store.entries(self.experiment["id"]), [entry])
        self.assertEqual(self.store.entries(self.idea["id"]), [])

    def test_invalid_entries_are_rejected_without_writing(self):
        other = self.store.add_node(kind="experiment", title="另一个实验")
        foreign_run = prepare_run(self.store, other["id"], [sys.executable, "train.py"], ["train.py"], {})
        valid = dict(node_id=self.experiment["id"], kind="note", author="human", text=WHY)
        invalid = [
            {"kind": "reaction"}, {"kind": "decision"}, {"kind": "proposal"}, {"kind": "story"},
            {"author": "codex"}, {"via": "email"}, {"text": "   "}, {"text": "x" * 4001}, {"text": 3},
            {"node_id": "missing"}, {"run_id": "r-missing"}, {"run_id": foreign_run["id"]},
        ]
        for changes in invalid:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.store.add_entry(**(valid | changes))
        self.assertEqual(self.store.state()["entries"], [])

    def test_database_refuses_to_rewrite_or_delete_entries(self):
        entry = self.store.add_entry(node_id=self.experiment["id"], kind="intent", author="human", text=WHY)
        for statement in ("UPDATE entries SET text='改写后的动机' WHERE id=?", "DELETE FROM entries WHERE id=?"):
            with self.subTest(statement=statement), self.assertRaises(sqlite3.DatabaseError):
                self.raw(statement, entry["id"])
        self.assertEqual(self.store.entries(), [entry])

    def test_entries_survive_editing_and_deleting_their_node(self):
        entry = self.store.add_entry(node_id=self.experiment["id"], kind="intent", author="human", text=WHY)
        self.store.edit_node(self.experiment["id"], title="为了验证机制 H 开展的 A 实验")
        self.store.delete_selection(canvas_id="canvas-main", node_ids=[self.experiment["id"]], edges=[])
        self.assertNotIn(self.experiment["id"], {n["id"] for n in self.store.state()["nodes"]})
        self.assertEqual(self.store.entries(), [entry])

    def test_existing_store_gains_the_journal_on_open_without_touching_records(self):
        before = self.store.state()
        self.raw("DROP TABLE entries")
        reopened = Store(self.store.path)
        self.assertEqual(reopened.state(), before)
        reopened.add_entry(node_id=self.idea["id"], kind="note", author="agent", text="Agent 的初步解释")
        self.assertEqual(len(reopened.entries()), 1)


class ProposalTests(JournalTestCase):
    def propose(self, **changes):
        return self.store.propose(**({"title": "拆开旧规则的提及、否定与位置", "source_ids": [self.idea["id"]],
                                      "rationale": "09-28 的意外指向“提及旧规则”本身"} | changes))

    def test_proposal_waits_for_a_human_reason_before_it_becomes_active(self):
        proposal = self.propose()
        node = proposal["node"]
        self.assertEqual((node["kind"], node["status"]), ("experiment", "proposed"))
        self.assertEqual((proposal["entry"]["kind"], proposal["entry"]["author"]), ("proposal", "agent"))
        self.assertEqual(self.store.state()["edges"][-1]["target"], node["id"])
        self.assertEqual([i["node_id"] for i in frontier(self.store.state())["awaiting_decision"]], [node["id"]])

        reason = "我怀疑是提到旧规则本身在诱发旧行为"
        expectation = "如果去掉提及后旧行为消失，我会转向研究否定词"
        result = self.store.decide(node["id"], decision="approved", text=reason, expectation=expectation, via="app")
        self.assertEqual(result["node"]["status"], "active")
        recorded = [(e["kind"], e["author"], e["text"], e["decision"], e["via"]) for e in result["entries"]]
        self.assertEqual(recorded, [("decision", "human", reason, "approved", "app"),
                                    ("expectation", "human", expectation, None, "app")])
        self.assertEqual(frontier(self.store.state())["awaiting_decision"], [])
        self.assertEqual([r["previous"]["status"] for r in self.store.export()["revisions"]], ["proposed"])

    def test_declined_proposal_is_kept_as_a_considered_alternative(self):
        node = self.propose()["node"]
        result = self.store.decide(node["id"], decision="declined")
        self.assertEqual(result["node"]["status"], "paused")
        self.assertEqual([(e["kind"], e["decision"], e["text"]) for e in result["entries"]], [("decision", "declined", "")])
        state = frontier(self.store.state())
        self.assertEqual((state["awaiting_decision"], state["planned"]), ([], []))

    def test_decisions_require_a_pending_experiment_and_a_reason_to_approve(self):
        node = self.propose()["node"]
        cases = [
            (node["id"], dict(decision="approved", text="  ")),
            (node["id"], dict(decision="maybe", text="理由")),
            (node["id"], dict(decision="declined", expectation="不该有预期")),
            (self.idea["id"], dict(decision="approved", text="理由")),
            (self.experiment["id"], dict(decision="approved", text="理由")),
            ("missing", dict(decision="approved", text="理由")),
        ]
        before = self.store.state()
        for node_id, arguments in cases:
            with self.subTest(node=node_id, arguments=arguments), self.assertRaises(ValueError):
                self.store.decide(node_id, **arguments)
        self.assertEqual(self.store.state(), before)
        self.store.decide(node["id"], decision="approved", text="就做这个")
        with self.assertRaises(ValueError):
            self.store.decide(node["id"], decision="approved", text="再批准一次")

    def test_status_edits_cannot_stand_in_for_a_decision(self):
        node = self.propose()["node"]
        for status in ("active", "paused", "done"):
            with self.subTest(status=status), self.assertRaises(ValueError):
                self.store.edit_node(node["id"], status=status)
        self.assertEqual(self.store.edit_node(node["id"], title="重新命名的提议")["status"], "proposed")
        self.assertEqual([i["node_id"] for i in frontier(self.store.state())["awaiting_decision"]], [node["id"]])
        self.store.decide(node["id"], decision="approved", text="可以做")
        self.assertEqual(self.store.edit_node(node["id"], status="done")["status"], "done")

    def test_invalid_proposals_create_nothing(self):
        before = self.store.state()
        for changes in ({"rationale": " "}, {"source_ids": ["missing"]}, {"title": ""}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.propose(**changes)
        self.assertEqual(self.store.state(), before)


class RunJournalTests(JournalTestCase):
    def test_run_freezes_intent_and_expectation_before_the_result_exists(self):
        run = self.prepare(intent=WHY, expectation="loss 会先降后升", author="human")
        entries = self.store.entries(self.experiment["id"])
        self.assertEqual([(e["kind"], e["text"], e["run_id"], e["author"]) for e in entries],
                         [("intent", WHY, run["id"], "human"), ("expectation", "loss 会先降后升", run["id"], "human")])
        self.assertTrue(all(e["created_at"] <= run["created_at"] for e in entries))
        self.assertEqual([r["run_id"] for r in frontier(self.store.state())["running"]], [run["id"]])
        with self.assertRaises(ValueError):
            self.store.react(run["id"], outcome="expected")

        finished = execute_run(self.store, run["id"])
        self.assertEqual(finished["status"], "succeeded", finished["error"])
        self.assertEqual([r["run_id"] for r in frontier(self.store.state())["awaiting_reaction"]], [run["id"]])
        reaction = self.store.react(run["id"], outcome="surprised", text="没有过拟合，反而更稳")
        self.assertEqual((reaction["kind"], reaction["outcome"], reaction["node_id"]), ("reaction", "surprised", self.experiment["id"]))
        state = frontier(self.store.state())
        self.assertEqual(state["awaiting_reaction"], [])
        self.assertEqual([s["entry_id"] for s in state["recent_surprises"]], [reaction["id"]])

    def test_run_text_needs_an_author_and_bad_input_creates_no_run(self):
        for journal in ({"intent": WHY}, {"expectation": "会更好"}, {"intent": WHY, "author": "codex"}, {"intent": " ", "author": "human"}):
            with self.subTest(journal=journal), self.assertRaises(ValueError):
                self.prepare(**journal)
        self.assertEqual((self.store.state()["runs"], self.store.entries()), ([], []))
        self.assertFalse((self.store.path / "runs").exists() and any((self.store.path / "runs").iterdir()))
        self.assertEqual(self.prepare(author="human")["status"], "queued")

    def test_reactions_validate_outcome_and_imported_runs_are_not_pending(self):
        metrics = self.root / "metrics.json"
        metrics.write_text('{"loss": 1}', encoding="utf-8")
        imported = import_run(self.store, self.experiment["id"], metrics, {})
        self.assertEqual(frontier(self.store.state())["awaiting_reaction"], [])
        with self.assertRaises(ValueError):
            self.store.react(imported["id"], outcome="great")
        with self.assertRaises(TypeError):
            self.store.react(imported["id"], outcome="mixed", author="agent")
        with self.assertRaises(ValueError):
            self.store.react("r-missing", outcome="mixed")
        reaction = self.store.react(imported["id"], outcome="mixed")
        self.assertEqual((reaction["text"], reaction["author"]), ("", "human"))

    def test_run_linked_intent_and_expectation_cannot_be_added_after_the_result(self):
        run = self.prepare(author="human")
        early = self.store.add_entry(node_id=self.experiment["id"], kind="expectation", author="human", text="应该更好", run_id=run["id"])
        execute_run(self.store, run["id"])
        for kind in ("intent", "expectation"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                self.store.add_entry(node_id=self.experiment["id"], kind=kind, author="human", text="我早就料到", run_id=run["id"])
        note = self.store.add_entry(node_id=self.experiment["id"], kind="note", author="agent", text="事后解释", run_id=run["id"])
        self.assertEqual([e["id"] for e in self.store.entries()], [early["id"], note["id"]])

    def test_context_quotes_the_journal_with_authors(self):
        self.prepare(intent=WHY, author="human")
        self.store.add_entry(node_id=self.experiment["id"], kind="note", author="agent", text="可能与机制 H 有关")
        text = self.store.context(self.experiment["id"])["text"]
        self.assertIn(WHY, text)
        self.assertIn("可能与机制 H 有关", text)
        self.assertIn("原话", text)
        self.assertEqual(len(self.store.context(self.experiment["id"])["entries"]), 2)


class FrontierTests(JournalTestCase):
    def test_frontier_separates_canvases_and_lists_planned_steps(self):
        other = self.store.add_canvas("另一主题")
        planned = self.store.add_node(kind="next", title="候选：换个数据集", source_ids=[self.idea["id"]])
        self.store.edit_node(planned["id"], status="proposed")
        elsewhere = self.store.propose(title="别处的提议", rationale="理由", canvas_id=other["id"])["node"]
        everywhere = frontier(self.store.state())
        self.assertEqual([i["node_id"] for i in everywhere["planned"]], [planned["id"]])
        self.assertEqual([i["node_id"] for i in everywhere["awaiting_decision"]], [elsewhere["id"]])
        main = frontier(self.store.state(), canvas_id="canvas-main")
        self.assertEqual((main["awaiting_decision"], [i["node_id"] for i in main["planned"]]), ([], [planned["id"]]))


class JournalCLITests(JournalTestCase):
    def cli(self, *args, ok=True):
        result = subprocess.run([sys.executable, "-m", "idea_workbench", "--store", str(self.store.path), *args],
                                cwd=ROOT, capture_output=True, text=True, timeout=30)
        if not ok:
            self.assertNotEqual(result.returncode, 0)
            return result.stderr
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_propose_decide_note_run_react_round_trip(self):
        proposal = self.cli("propose", "--title", "逐条加入经验", "--source", self.idea["id"], "--why", "Agent 认为可以先排除顺序效应")
        node_id = proposal["node"]["id"]
        self.assertEqual(self.cli("frontier")["awaiting_decision"][0]["node_id"], node_id)
        decided = self.cli("decide", node_id, "--approve", "--text", "我想先看顺序有没有影响", "--expect", "应该没影响")
        self.assertEqual(decided["node"]["status"], "active")
        note = self.cli("note", node_id, "--text", WHY, "--by", "human")
        self.assertEqual((note["kind"], note["author"]), ("note", "human"))
        run = self.cli("run", "--experiment", node_id, "--include", "train.py", "--why", "用户原话：跑一下看看",
                       "--expect", "loss 低于 1", "--by", "human", "--wait", "--", sys.executable, "train.py")
        self.assertEqual(run["status"], "succeeded")
        reaction = self.cli("react", run["id"], "--outcome", "expected", "--text", "和想的一样")
        self.assertEqual((reaction["outcome"], reaction["run_id"]), ("expected", run["id"]))
        kinds = [e["kind"] for e in self.cli("journal", node_id)]
        self.assertEqual(kinds, ["proposal", "decision", "expectation", "note", "intent", "expectation", "reaction"])
        self.assertEqual(self.cli("frontier", "--canvas", "canvas-main")["awaiting_reaction"], [])

    def test_recorded_words_always_name_their_author(self):
        self.assertIn("--by", self.cli("run", "--experiment", self.experiment["id"], "--include", "train.py",
                                      "--why", "原话", "--", sys.executable, "train.py", ok=False))
        self.assertIn("--by", self.cli("note", self.experiment["id"], "--text", "原话", ok=False))
        self.assertIn("--approve", self.cli("decide", self.experiment["id"], "--text", "原话", ok=False))
        self.assertEqual((self.store.state()["runs"], self.store.entries()), ([], []))


class JournalAPITests(JournalTestCase):
    def setUp(self):
        super().setUp()
        from idea_workbench.server import create_server

        self.server = create_server(self.store, port=0)
        self.addCleanup(self.server.server_close)
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(self.server.shutdown)
        status, state = self.request("GET", "/api/state")
        self.assertEqual(status, 200)
        self.headers = {"Origin": f"http://127.0.0.1:{self.server.server_port}",
                        "X-Idea-Token": state["csrf_token"], "Sec-Fetch-Site": "same-origin"}

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=None if body is None else json.dumps(body),
                               headers={"Content-Type": "application/json", **(headers or {})})
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def test_app_writes_are_human_authored_and_cannot_be_changed(self):
        status, entry = self.request("POST", "/api/entries", {"node_id": self.experiment["id"], "kind": "note", "text": WHY}, self.headers)
        self.assertEqual(status, 201)
        self.assertEqual((entry["author"], entry["via"], entry["text"]), ("human", "app", WHY))
        for body in ({"node_id": self.experiment["id"], "kind": "note", "text": "伪装", "author": "agent"},
                     {"node_id": self.experiment["id"], "kind": "reaction", "text": "x"},
                     {"node_id": self.experiment["id"], "kind": "note", "text": ""}):
            with self.subTest(body=body):
                self.assertEqual(self.request("POST", "/api/entries", body, self.headers)[0], 400)
        self.assertEqual(self.request("POST", "/api/entries", {"node_id": self.experiment["id"], "kind": "note", "text": "无令牌"},
                                      {"Origin": self.headers["Origin"]})[0], 403)
        for method in ("PATCH", "DELETE"):
            self.assertEqual(self.request(method, f"/api/entries/{entry['id']}", {"text": "改写"}, self.headers)[0], 404)
        self.assertEqual(self.store.entries(), [entry])

    def test_decisions_and_reactions_from_the_app(self):
        node = self.store.propose(title="提议", rationale="Agent 理由")["node"]
        status, result = self.request("POST", "/api/decisions", {"node_id": node["id"], "decision": "approved",
                                                                  "text": "我想知道顺序是否重要", "expectation": ""}, self.headers)
        self.assertEqual(status, 200)
        self.assertEqual(result["node"]["status"], "active")
        self.assertEqual(self.request("POST", "/api/decisions", {"node_id": node["id"], "decision": "approved", "text": "再来"},
                                      self.headers)[0], 400)
        run = execute_run(self.store, prepare_run(self.store, node["id"], [sys.executable, "train.py"], ["train.py"], {})["id"])
        status, state = self.request("GET", "/api/state")
        self.assertEqual([r["run_id"] for r in state["frontier"]["awaiting_reaction"]], [run["id"]])
        status, reaction = self.request("POST", "/api/reactions", {"run_id": run["id"], "outcome": "mixed", "text": "说不清"}, self.headers)
        self.assertEqual((status, reaction["author"], reaction["via"]), (201, "human", "app"))
        self.assertEqual(self.request("POST", "/api/reactions", {"run_id": run["id"], "outcome": "mixed", "author": "agent"},
                                      self.headers)[0], 400)
        status, state = self.request("GET", "/api/state")
        self.assertEqual(state["frontier"]["awaiting_reaction"], [])
        self.assertEqual(len(state["entries"]), 3)


if __name__ == "__main__":
    unittest.main()
