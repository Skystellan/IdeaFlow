"""Desktop entry point behavior, including the parent's process lifetime contract."""
import http.client
import json
import os
import queue
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from urllib.parse import urlsplit

from idea_workbench.desktop_backend import open_store
from idea_workbench.store import Store


ENTRY = Path(__file__).resolve().parents[1] / "idea_workbench" / "desktop_backend.py"


class DesktopTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.project = self.root / "Research project"
        self.project.mkdir()

    def start(self, project=None, *args):
        # Direct execution from outside the repo also exercises the frozen entry's
        # absolute imports without relying on the parent's working directory.
        environment = os.environ.copy()
        environment.pop("PYTHONPATH", None)
        process = subprocess.Popen(
            [sys.executable, str(ENTRY), "--project", str(project or self.project), *args],
            cwd=self.root, env=environment, stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding="utf-8")

        def cleanup():
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for pipe in (process.stdin, process.stdout, process.stderr):
                if pipe is not None:
                    pipe.close()

        self.addCleanup(cleanup)
        return process

    def ready(self, process):
        lines = queue.Queue()
        threading.Thread(target=lambda: lines.put(process.stdout.readline()), daemon=True).start()
        try:
            line = lines.get(timeout=5)
        except queue.Empty:
            self.fail("Backend did not flush a ready line within five seconds")
        if not line:
            process.wait(timeout=5)
            self.fail(f"Backend exited before ready: {process.stderr.read()}")
        ready = json.loads(line)
        self.assertEqual(set(ready), {"url", "store", "project"})
        url = urlsplit(ready["url"])
        self.assertEqual((url.scheme, url.hostname, url.path), ("http", "127.0.0.1", ""))
        self.assertGreater(url.port, 0)
        self.assertIsNone(process.poll())
        return ready

    def state(self, ready):
        connection = http.client.HTTPConnection("127.0.0.1", urlsplit(ready["url"]).port, timeout=5)
        try:
            connection.request("GET", "/api/state")
            response = connection.getresponse()
            self.assertEqual(response.status, 200)
            return json.loads(response.read())
        finally:
            connection.close()

    def assert_stopped(self, process, ready):
        self.assertEqual(process.wait(timeout=5), 0)
        self.assertEqual(process.stdout.read(), "", "Only one ready line should be emitted")
        self.assertEqual(process.stderr.read(), "")
        with socket.socket() as connection:
            connection.settimeout(1)
            self.assertNotEqual(connection.connect_ex(("127.0.0.1", urlsplit(ready["url"]).port)), 0)

    def test_missing_store_requires_create_and_missing_project_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "--create"):
            open_store(self.project)
        self.assertFalse((self.project / ".idea-workbench").exists())
        for args, expected in (((), "--create"), (("--create",), "does not exist")):
            project = self.project if not args else self.root / "missing-project"
            with self.subTest(args=args):
                process = self.start(project, *args)
                stdout, stderr = process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(stdout, "")
                self.assertIn(expected, stderr)
                self.assertNotIn("Traceback", stderr)
        self.assertFalse((self.project / ".idea-workbench").exists())
        self.assertFalse((self.root / "missing-project").exists())

    def test_create_uses_project_name_and_resolves_project_and_store_aliases(self):
        alias = self.root / "project-alias"
        alias.symlink_to(self.project, target_is_directory=True)
        store = open_store(alias, create=True)
        self.assertEqual(store.path, self.project / ".idea-workbench")
        self.assertEqual(store.state()["project"], {"name": self.project.name, "root": str(self.project)})
        node = store.add_node(kind="idea", title="Keep this research")
        store_alias = self.root / "store-alias"
        store_alias.symlink_to(store.path, target_is_directory=True)
        for path in (self.project, alias, store.path, store_alias):
            with self.subTest(path=path):
                reopened = open_store(path, create=True)
                self.assertEqual(reopened.path, store.path)
                self.assertEqual(reopened.state()["nodes"], [node])
        self.assertFalse((store.path / ".idea-workbench").exists())

    def test_existing_store_keeps_its_name_root_and_records_with_create(self):
        store = Store.initialize(self.root / "separate-store", "Saved research name", self.project)
        store.add_node(kind="idea", title="Existing research")
        process = self.start(store.path, "--create")
        ready = self.ready(process)
        self.assertEqual(ready["store"], str(store.path))
        self.assertEqual(ready["project"], store.state()["project"])
        state = self.state(ready)
        self.assertTrue(state.pop("csrf_token"))
        self.assertEqual(state, store.state())
        process.stdin.close()
        self.assert_stopped(process, ready)

    def test_create_never_initializes_an_existing_unrecognized_database(self):
        for direct in (False, True):
            with self.subTest(direct=direct):
                project = self.root / str(direct)
                project.mkdir()
                path = project if direct else project / ".idea-workbench"
                path.mkdir(exist_ok=True)
                database = path / "research.sqlite3"
                with sqlite3.connect(database) as connection:
                    connection.execute("CREATE TABLE unrelated(value TEXT)")
                    connection.execute("INSERT INTO unrelated VALUES ('preserve me')")
                process = self.start(project, "--create")
                stdout, stderr = process.communicate(timeout=5)
                self.assertNotEqual(process.returncode, 0)
                self.assertEqual(stdout, "")
                self.assertIn("no such table: meta", stderr)
                self.assertNotIn("Traceback", stderr)
                with sqlite3.connect(database) as connection:
                    self.assertEqual(connection.execute("SELECT name FROM sqlite_master").fetchall(), [("unrelated",)])
                    self.assertEqual(connection.execute("SELECT value FROM unrelated").fetchone(), ("preserve me",))

    def test_ready_api_and_stdin_eof_terminate_server(self):
        process = self.start(self.project, "--create")
        ready = self.ready(process)
        self.assertEqual(ready["store"], str(self.project / ".idea-workbench"))
        self.assertEqual(ready["project"], {"name": self.project.name, "root": str(self.project)})
        state = self.state(ready)
        self.assertEqual(state["project"], ready["project"])
        self.assertEqual(state["nodes"], [])
        self.assertTrue(state["csrf_token"])
        # Parent data must not be mistaken for EOF, even without a newline.
        process.stdin.write("still here")
        process.stdin.flush()
        self.assertEqual(self.state(ready), state)
        process.stdin.close()
        self.assert_stopped(process, ready)

    def test_eof_before_startup_does_not_leave_a_server(self):
        process = self.start(self.project, "--create")
        process.stdin.close()
        self.assertEqual(process.wait(timeout=5), 0)
        ready = json.loads(process.stdout.readline())
        self.assert_stopped(process, ready)

    def test_sigterm_and_sigint_stop_with_parent_pipe_still_open(self):
        Store.initialize(self.project / ".idea-workbench", "Existing", self.project)
        for signum in (signal.SIGTERM, signal.SIGINT):
            with self.subTest(signal=signum):
                process = self.start()
                ready = self.ready(process)
                self.assertEqual(self.state(ready)["project"], ready["project"])
                process.send_signal(signum)
                self.assert_stopped(process, ready)
                self.assertFalse(process.stdin.closed)


if __name__ == "__main__":
    unittest.main()
