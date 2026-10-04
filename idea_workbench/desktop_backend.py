"""Loopback backend owned by the desktop parent's stdin pipe."""
from __future__ import annotations

import argparse
import json
import os
import signal
import sqlite3
import sys
import threading
from pathlib import Path

# Support direct source execution as well as PyInstaller's script entry point.
if not __package__ and not getattr(sys, "frozen", False):
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from idea_workbench.server import create_server
from idea_workbench.store import Store


def open_store(project, create=False):
    project = Path(project).expanduser().resolve()
    if not project.is_dir():
        raise ValueError(f"Project directory does not exist: {project}")

    for path in (project, project / ".idea-workbench"):
        database = path / "research.sqlite3"
        if database.exists() or database.is_symlink():
            return Store(path)

    path = project / ".idea-workbench"
    if not create:
        raise ValueError(f"No research database found in {project}; use --create to initialize it")
    return Store.initialize(path, project.name, project)


def watch_parent(server, stdin_fd):
    # An unbuffered read lets this daemon exit safely even while stdin stays open.
    try:
        while os.read(stdin_fd, 4096):
            pass
    except OSError:
        pass
    server.shutdown()


def stop(signum, frame):
    raise KeyboardInterrupt


def main(argv=None):
    parser = argparse.ArgumentParser(description="Desktop-owned IdeaFlow backend")
    parser.add_argument("--project", type=Path, required=True,
                        help="Project root or existing research store directory")
    parser.add_argument("--create", action="store_true",
                        help="Initialize a missing .idea-workbench store in the project")
    args = parser.parse_args(argv)

    try:
        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        store = open_store(args.project, args.create)
        project = store.state()["project"]
        stdin_fd = sys.stdin.fileno()
        with create_server(store, 0) as server:
            print(json.dumps({
                "url": f"http://127.0.0.1:{server.server_port}",
                "store": str(store.path),
                "project": project,
            }), flush=True)
            threading.Thread(target=watch_parent, args=(server, stdin_fd), daemon=True).start()
            server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    except (OSError, ValueError, sqlite3.Error, TypeError) as exc:
        print(f"IdeaFlow backend: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
