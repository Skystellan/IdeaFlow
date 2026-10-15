"""Node pages: changing a node's type, autosaved notes and pasted images."""
import http.client
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from idea_workbench import assets
from idea_workbench.store import Store

ROOT = Path(__file__).resolve().parents[1]
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


class NotesTestCase(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        project = self.root / "project"
        project.mkdir()
        self.store = Store.initialize(self.root / "workbench", "Research", project)

    def revisions(self, node_id):
        return [r for r in self.store.export()["revisions"] if r["node_id"] == node_id]


class KindTests(NotesTestCase):
    def test_kind_changes_keep_history_and_relabel_incoming_links(self):
        root = self.store.add_node(kind="idea", title="Root")
        other = self.store.add_node(kind="idea", title="Other")
        thought = self.store.add_node(kind="idea", title="Fork", source_ids=[root["id"]])
        merged = self.store.add_node(kind="experiment", title="Merge", source_ids=[root["id"], other["id"]])

        changed = self.store.edit_node(thought["id"], kind="experiment")
        self.assertEqual((changed["kind"], changed["title"]), ("experiment", "Fork"))
        self.assertEqual(self.store.node(thought["id"])["kind"], "experiment")
        self.assertEqual(self.revisions(thought["id"])[0]["previous"]["kind"], "idea")
        relation = {(e["source"], e["target"]): e["relation"] for e in self.store.state()["edges"]}
        self.assertEqual(relation[(root["id"], thought["id"])], "continues")

        self.store.edit_node(thought["id"], kind="idea")
        self.store.edit_node(merged["id"], kind="idea")
        self.store.edit_node(merged["id"], kind="experiment")
        relation = {(e["source"], e["target"]): e["relation"] for e in self.store.state()["edges"]}
        self.assertEqual(relation[(root["id"], thought["id"])], "fork")
        self.assertEqual(relation[(other["id"], merged["id"])], "synthesis", "A synthesis stays a synthesis")

    def test_invalid_kind_changes_do_not_write(self):
        experiment = self.store.add_node(kind="experiment", title="Trial")
        self.store.add_run(dict(id="r-1", experiment_id=experiment["id"], status="succeeded", metrics=None))
        proposal = self.store.propose(title="Agent idea", rationale="Might help")["node"]
        before = self.store.export()
        for node, kind, message in ((experiment, "idea", "runs"), (experiment, "theory", "kind"),
                                    (experiment, None, "kind"), (proposal, "idea", "decision")):
            with self.subTest(kind=kind), self.assertRaisesRegex(ValueError, message):
                self.store.edit_node(node["id"], kind=kind)
        self.assertEqual(self.store.export()["revisions"], before["revisions"])
        self.assertEqual(self.store.state(), {k: before[k] for k in self.store.state()})

    def test_cli_edit_changes_kind(self):
        idea = self.store.add_node(kind="idea", title="Turn into a test")
        result = subprocess.run([sys.executable, "-m", "idea_workbench", "--store", str(self.store.path),
                                 "edit", idea["id"], "--kind", "experiment"],
                                cwd=ROOT, capture_output=True, text=True, check=True)
        self.assertEqual(json.loads(result.stdout)["kind"], "experiment")


class AutosaveTests(NotesTestCase):
    def test_one_editing_session_keeps_one_snapshot_until_the_window_passes(self):
        node = self.store.add_node(kind="idea", title="Draft", body="Original")
        for text in ("Typing", "Typing more", "Typing even more"):
            self.store.edit_node(node["id"], body=text, draft_session="s-1")
        self.assertEqual([r["previous"]["body"] for r in self.revisions(node["id"])], ["Original"])
        later = self.store._clock() + 11 * 60
        with patch.object(self.store, "_clock", return_value=later):
            self.store.edit_node(node["id"], body="After a pause", draft_session="s-1")
        self.assertEqual([r["previous"]["body"] for r in self.revisions(node["id"])], ["Original", "Typing even more"])

    def test_other_writers_and_sessions_are_never_overwritten_without_a_snapshot(self):
        node = self.store.add_node(kind="idea", title="Shared", body="Original")
        self.store.edit_node(node["id"], body="Mine", draft_session="s-1")
        self.store.edit_node(node["id"], body="Codex rewrite")
        self.store.edit_node(node["id"], body="Mine again", draft_session="s-1")
        self.store.edit_node(node["id"], body="Other window", draft_session="s-2")
        self.store.edit_node(node["id"], status="done", draft_session="s-2")
        self.assertEqual([r["previous"]["body"] for r in self.revisions(node["id"])],
                         ["Original", "Mine", "Codex rewrite", "Mine again", "Other window"])

    def test_long_notes_fit_but_invalid_sessions_are_rejected(self):
        node = self.store.add_node(kind="idea", title="Long")
        self.assertEqual(len(self.store.edit_node(node["id"], body="长" * 100000)["body"]), 100000)
        for session in ("", 7, "x" * 65):
            with self.subTest(session=session), self.assertRaises(ValueError):
                self.store.edit_node(node["id"], body="x", draft_session=session)
        with self.assertRaises(ValueError):
            self.store.edit_node(node["id"], body="长" * 100001)


class AssetTests(NotesTestCase):
    def test_images_are_content_addressed_and_validated(self):
        saved = assets.save(self.store.path, PNG, "image/png")
        self.assertRegex(saved["name"], r"^[0-9a-f]{24}\.png$")
        self.assertEqual(saved["path"], f"assets/{saved['name']}")
        self.assertEqual(assets.save(self.store.path, PNG, "image/png"), saved)
        self.assertEqual(assets.read(self.store.path, saved["name"]), (PNG, "image/png"))
        self.assertTrue(assets.save(self.store.path, JPEG, "image/jpeg")["name"].endswith(".jpg"))
        for data, kind in ((JPEG, "image/png"), (b"<svg onload=alert(1)>", "image/svg+xml"),
                           (b"", "image/png"), (PNG, "text/html")):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                assets.save(self.store.path, data, kind)

    def test_context_tells_agents_where_note_images_live(self):
        saved = assets.save(self.store.path, PNG, "image/png")
        plain = self.store.add_node(kind="idea", title="Plain")
        node = self.store.add_node(kind="idea", title="Figure", body=f"Loss curve:\n\n![curve]({saved['path']})")
        self.assertNotIn("assets", self.store.context(plain["id"])["text"])
        self.assertIn(str(self.store.path / "assets"), self.store.context(node["id"])["text"])

    def test_reading_rejects_paths_and_symlinks(self):
        saved = assets.save(self.store.path, PNG, "image/png")
        outside = self.root / "outside.png"
        outside.write_bytes(PNG)
        for name in ("../research.sqlite3", "x.png", saved["name"] + "/", str(outside), saved["name"].upper()):
            with self.subTest(name=name), self.assertRaises(ValueError):
                assets.read(self.store.path, name)
        target = self.store.path / "assets" / saved["name"]
        target.unlink()
        target.symlink_to(outside)
        with self.assertRaises(ValueError):
            assets.read(self.store.path, saved["name"])


class NotesHTTPTests(NotesTestCase):
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
        token = self.request("GET", "/api/state")[2]["csrf_token"]
        self.headers = {"Origin": self.origin, "X-Idea-Token": token, "Sec-Fetch-Site": "same-origin"}

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            data = response.read()
            if "json" in (response.getheader("Content-Type") or ""):
                data = json.loads(data)
            return response.status, response.getheader("Content-Type"), data
        finally:
            connection.close()

    def test_uploaded_images_are_served_from_the_same_origin(self):
        status, _, saved = self.request("POST", "/api/assets", PNG, self.headers | {"Content-Type": "image/png"})
        self.assertEqual(status, 201)
        status, content_type, data = self.request("GET", f"/{saved['path']}")
        self.assertEqual((status, content_type, data), (200, "image/png", PNG))
        self.assertEqual(self.request("GET", "/assets/../research.sqlite3")[0], 404)
        self.assertEqual(self.request("GET", "/assets/0123456789abcdef01234567.png")[0], 404)

    def test_uploads_need_the_token_an_image_type_and_a_size_limit(self):
        image = {"Content-Type": "image/png"}
        self.assertEqual(self.request("POST", "/api/assets", PNG, {"Origin": self.origin} | image)[0], 403)
        self.assertEqual(self.request("POST", "/api/assets", PNG, self.headers | {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/assets", b"<svg/>", self.headers | {"Content-Type": "image/svg+xml"})[0], 415)
        self.assertEqual(self.request("POST", "/api/assets", JPEG, self.headers | image)[0], 400)
        too_large = self.headers | image | {"Content-Length": str(assets.LIMIT + 1)}
        self.assertEqual(self.request("POST", "/api/assets", PNG, too_large)[0], 413)
        self.assertFalse((self.store.path / "assets").exists())

    def test_patch_changes_kind_and_coalesces_one_editing_session(self):
        node = self.store.add_node(kind="idea", title="Page", body="Original")
        json_headers = self.headers | {"Content-Type": "application/json"}
        for body in ({"kind": "experiment"}, {"body": "a", "draft_session": "s-1"}, {"body": "ab", "draft_session": "s-1"}):
            status, _, edited = self.request("PATCH", f"/api/nodes/{node['id']}", json.dumps(body), json_headers)
            self.assertEqual(status, 200)
        self.assertEqual((edited["kind"], edited["body"]), ("experiment", "ab"))
        self.assertEqual(len(self.revisions(node["id"])), 2)
        status, _, error = self.request("PATCH", f"/api/nodes/{node['id']}", json.dumps({"canvas_id": "x"}), json_headers)
        self.assertEqual(status, 400)


if __name__ == "__main__":
    unittest.main()
