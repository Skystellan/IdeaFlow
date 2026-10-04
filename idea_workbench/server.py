"""Loopback-only UI API. Experiment execution is deliberately a CLI operation."""
from __future__ import annotations

import json
import secrets
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

from .runner import artifact
from .store import encode

STATIC = Path(__file__).parent / "static"


def create_server(store, port=8770):
    token = secrets.token_urlsafe(32)

    class Handler(BaseHTTPRequestHandler):
        def reply(self, data, status=200, content_type="application/json; charset=utf-8"):
            body = data if isinstance(data, bytes) else encode(data).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
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
                if mutation:
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
                    else:
                        self.reply({"error": "Unknown endpoint"}, 404)
                elif url.path in {"/", "/static/app.js", "/static/graph-layout.js", "/static/style.css"}:
                    name, mime = {"/": ("index.html", "text/html"), "/static/app.js": ("app.js", "text/javascript"), "/static/graph-layout.js": ("graph-layout.js", "text/javascript"), "/static/style.css": ("style.css", "text/css")}[url.path]
                    self.reply((STATIC / name).read_bytes(), content_type=mime + "; charset=utf-8")
                elif url.path == "/api/state":
                    self.reply(store.state() | {"csrf_token": token})
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

        do_GET = dispatch
        do_POST = dispatch
        do_PATCH = dispatch
        do_DELETE = dispatch

        def log_message(self, format, *args):
            pass

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
