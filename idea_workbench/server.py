"""Loopback-only UI API. Experiment execution is deliberately a CLI operation."""
from __future__ import annotations

import json
import secrets
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import TCPServer
from urllib.parse import parse_qs, urlsplit

from . import assets
from .journal import frontier
from .runner import artifact
from .store import encode

STATIC = Path(__file__).parent / "static"
STATIC_FILES = {
    "/": ("index.html", "text/html"),
    "/static/style.css": ("style.css", "text/css"),
    **{f"/static/{name}": (name, "text/javascript") for name in (
        "app.js", "graph-layout.js", "thread-layout.js", "journal-model.js",
        "threads-view.js", "journal-view.js", "frontier-view.js",
        "note-markdown.js", "note-dom.js", "note-editor.js", "note-menus.js", "note-outbox.js", "node-page.js")},
}


def only(data, allowed):
    """App writes are always the researcher's own words; clients cannot choose an author or source."""
    unknown = set(data) - allowed
    if unknown:
        raise ValueError(f"Unexpected fields: {', '.join(sorted(unknown))}")
    return data


class LoopbackHTTPServer(ThreadingHTTPServer):
    def server_bind(self):
        # HTTPServer resolves its address to a hostname, which can stall startup
        # on macOS. A loopback-only service already knows its hostname.
        TCPServer.server_bind(self)
        self.server_name = "localhost"
        self.server_port = self.server_address[1]


def create_server(store, port=8770):
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, data, status=200, content_type="application/json; charset=utf-8", cache="no-store"):
            body = data if isinstance(data, bytes) else encode(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", cache)
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'")
            self.end_headers()
            self.wfile.write(body)

        def authorized(self, mutation=False):
            hosts = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
            host = self.headers.get("Host")
            origin = self.headers.get("Origin")
            if host not in hosts or (origin and origin != f"http://{host}"):
                self.reply({"error": "Only same-origin loopback requests are allowed"}, 403)
                return False
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.reply({"error": "Cross-site requests are not allowed"}, 403)
                return False
            if mutation and not secrets.compare_digest(self.headers.get("X-Idea-Token", ""), token):
                self.reply({"error": "Reload the workbench before saving"}, 403)
                return False
            return True

        def dispatch(self):
            mutation = self.command != "GET"
            if not self.authorized(mutation):
                return
            url = urlsplit(self.path)
            query = parse_qs(url.query)

            def param(name):
                values = query.get(name)
                if not values or len(values) != 1:
                    raise ValueError(f"Missing or repeated query parameter: {name}")
                return values[0]

            try:
                if mutation and self.command == "POST" and url.path == "/api/assets":
                    self.upload()
                elif mutation:
                    if self.headers.get_content_type() != "application/json":
                        self.reply({"error": "Expected application/json"}, 415)
                        return
                    length = int(self.headers.get("Content-Length", "0"))
                    if length < 1 or length > 1024 * 1024:
                        self.reply({"error": "Request body must be 1 byte to 1 MiB"}, 413)
                        return
                    data = json.loads(self.rfile.read(length))
                    if not isinstance(data, dict):
                        raise ValueError("Expected a JSON object")
                    if self.command == "POST" and url.path == "/api/nodes":
                        self.reply(store.add_node(**data), 201)
                    elif self.command == "POST" and url.path == "/api/canvases":
                        self.reply(store.add_canvas(**data), 201)
                    elif self.command == "POST" and url.path == "/api/edges":
                        self.reply(store.add_edge(**data), 201)
                    elif self.command == "DELETE" and url.path == "/api/edges":
                        self.reply(store.remove_edge(**data))
                    elif self.command == "DELETE" and url.path == "/api/selection":
                        self.reply(store.delete_selection(**data))
                    elif self.command == "PATCH" and url.path.startswith("/api/nodes/"):
                        self.reply(store.edit_node(url.path.removeprefix("/api/nodes/"), **data))
                    elif self.command == "POST" and url.path == "/api/entries":
                        entry = only(data, {"node_id", "kind", "text", "run_id"})
                        self.reply(store.add_entry(**entry, author="human", via="app"), 201)
                    elif self.command == "POST" and url.path == "/api/decisions":
                        decision = only(data, {"node_id", "decision", "text", "expectation"})
                        self.reply(store.decide(**decision, via="app"))
                    elif self.command == "POST" and url.path == "/api/reactions":
                        reaction = only(data, {"run_id", "outcome", "text"})
                        self.reply(store.react(**reaction, via="app"), 201)
                    else:
                        self.reply({"error": "Unknown endpoint"}, 404)
                elif url.path in STATIC_FILES:
                    name, mime = STATIC_FILES[url.path]
                    self.reply((STATIC / name).read_bytes(), content_type=mime + "; charset=utf-8")
                elif url.path.startswith("/assets/"):
                    self.image(url.path.removeprefix("/assets/"))
                elif url.path == "/api/state":
                    state = store.state()
                    self.reply(state | {"frontier": frontier(state), "csrf_token": token})
                elif url.path == "/api/context":
                    self.reply(store.context(param("node")))
                elif url.path == "/api/run":
                    self.reply(store.run(param("id")))
                elif url.path == "/api/compare":
                    self.reply(store.compare(param("left"), param("right")))
                elif url.path == "/api/export":
                    self.reply(store.export())
                elif url.path == "/api/artifact":
                    self.reply(artifact(store, param("run"), param("name")).encode("utf-8"), content_type="text/plain; charset=utf-8")
                else:
                    self.reply({"error": "Not found"}, 404)
            except FileNotFoundError:
                self.reply({"error": "Artifact not recorded or file unavailable"}, 404)
            except (ValueError, TypeError) as exc:
                self.reply({"error": str(exc)}, 400)
            except (sqlite3.Error, OSError):
                self.reply({"error": "Local storage is temporarily unavailable"}, 503)

        def upload(self):
            mime = self.headers.get_content_type()
            if mime not in assets.TYPES:
                self.reply({"error": "Images must be PNG, JPEG, GIF or WebP"}, 415)
                return
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > assets.LIMIT:
                self.reply({"error": "Images must be 1 byte to 20 MiB"}, 413)
                return
            self.reply(assets.save(store.path, self.rfile.read(length), mime), 201)

        def image(self, name):
            try:
                data, mime = assets.read(store.path, name)
            except (ValueError, FileNotFoundError):
                self.reply({"error": "Image not found"}, 404)
                return
            # Names are content hashes, so a stored image never changes.
            self.reply(data, content_type=mime, cache="private, max-age=31536000, immutable")

        do_GET = dispatch
        do_POST = dispatch
        do_PATCH = dispatch
        do_DELETE = dispatch

        def log_message(self, format, *args):
            pass

    return LoopbackHTTPServer(("127.0.0.1", port), Handler)
