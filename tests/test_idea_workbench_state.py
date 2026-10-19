"""Picking an experiment's state: outcomes are the researcher's reactions and mark it done."""
import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from idea_workbench.journal import frontier
from idea_workbench.store import Store

ROOT = Path(__file__).resolve().parents[1]


class StateTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        root = Path(temporary.name).resolve()
        (root / "project").mkdir()
        self.store = Store.initialize(root / "workbench", "Research", root / "project")
        self.experiment = self.store.add_node(kind="experiment", title="Trial", status="active")

    def finished_run(self, run_id, finished_at, status="succeeded", origin="managed"):
        return self.store.add_run(dict(id=run_id, experiment_id=self.experiment["id"], status=status, origin=origin,
                                       created_at=finished_at, finished_at=finished_at, metrics=None))


class OutcomeTests(StateTestCase):
    def test_an_experiment_without_runs_can_get_an_outcome(self):
        entry = self.store.react(node_id=self.experiment["id"], outcome="expected", text="和想的一样")
        self.assertEqual((entry["kind"], entry["run_id"], entry["author"], entry["text"]), ("reaction", None, "human", "和想的一样"))
        self.assertEqual(self.store.node(self.experiment["id"])["status"], "done")
        previous = [r["previous"]["status"] for r in self.store.export()["revisions"]]
        self.assertEqual(previous, ["active"], "Marking it done keeps the earlier status in history")

    def test_a_reaction_to_a_run_marks_the_experiment_done(self):
        self.finished_run("r-1", "2026-10-01T00:00:00+00:00")
        self.store.react("r-1", outcome="surprised")
        self.assertEqual(self.store.node(self.experiment["id"])["status"], "done")
        self.store.react("r-1", outcome="mixed")
        self.assertEqual(len(self.store.export()["revisions"]), 1, "An experiment already done is not revised again")

    def test_an_outcome_for_the_experiment_answers_runs_that_finished_before_it(self):
        self.finished_run("r-old", "2000-01-01T00:00:00+00:00")
        self.store.react(node_id=self.experiment["id"], outcome="mixed")
        self.finished_run("r-new", "2999-01-01T00:00:00+00:00")
        self.assertEqual([r["run_id"] for r in frontier(self.store.state())["awaiting_reaction"]], ["r-new"])

    def test_outcomes_need_a_finished_experiment_the_researcher_decided_on(self):
        thought = self.store.add_node(kind="idea", title="Thought")
        proposal = self.store.propose(title="Agent idea", rationale="Might help")["node"]
        self.store.add_run(dict(id="r-live", experiment_id=self.experiment["id"], status="running", metrics=None))
        before = self.store.export()
        for options, message in (({"node_id": thought["id"]}, "experiment"), ({"node_id": proposal["id"]}, "decision"),
                                 ({"node_id": self.experiment["id"]}, "finish"), ({}, "run_id or node_id"),
                                 ({"node_id": self.experiment["id"], "run_id": "r-live"}, "run_id or node_id")):
            with self.subTest(options=options), self.assertRaisesRegex(ValueError, message):
                self.store.react(outcome="expected", **options)
        self.assertEqual(self.store.export()["entries"], before["entries"])
        self.assertEqual(self.store.export()["nodes"], before["nodes"])

    def test_cli_records_an_outcome_for_an_experiment(self):
        result = subprocess.run([sys.executable, "-m", "idea_workbench", "--store", str(self.store.path), "react",
                                 "--node", self.experiment["id"], "--outcome", "surprised", "--text", "出乎意料"],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["outcome"], "surprised")
        self.assertEqual(self.store.node(self.experiment["id"])["status"], "done")


class OutcomeHTTPTests(StateTestCase):
    def test_the_app_records_an_outcome_for_an_experiment(self):
        from idea_workbench.server import create_server

        server = create_server(self.store, port=0)
        self.addCleanup(server.server_close)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.shutdown)

        def request(method, path, body=None, headers=None):
            connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
            try:
                connection.request(method, path, body=None if body is None else json.dumps(body),
                                   headers={"Content-Type": "application/json", **(headers or {})})
                response = connection.getresponse()
                return response.status, json.loads(response.read())
            finally:
                connection.close()

        token = request("GET", "/api/state")[1]["csrf_token"]
        headers = {"Origin": f"http://127.0.0.1:{server.server_port}", "X-Idea-Token": token}
        status, entry = request("POST", "/api/reactions", {"node_id": self.experiment["id"], "outcome": "expected"}, headers)
        self.assertEqual((status, entry["via"], entry["run_id"]), (201, "app", None))
        self.assertEqual(request("GET", "/api/state")[1]["nodes"][0]["status"], "done")


if __name__ == "__main__":
    unittest.main()
