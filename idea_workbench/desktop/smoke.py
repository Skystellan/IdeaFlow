"""Check the shipped runtime, bundled assets, writes and parent-owned lifetime."""
import argparse
import json
import os
from pathlib import Path
import select
import subprocess
import tempfile
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("app", type=Path)
    app = parser.parse_args().app.resolve()
    for directory, folders, files in os.walk(app):
        for name in folders + files:
            file = Path(directory) / name
            if file.is_symlink():
                assert file.resolve(strict=True).is_relative_to(app), f"Bundle link escapes app: {file}"
    executable = app / "Contents/Resources/workbench-backend/workbench-backend"
    with tempfile.TemporaryDirectory(prefix="workbench-packaged-") as temporary:
        environment = {key: value for key, value in os.environ.items() if key not in {"PYTHONPATH", "PYTHONHOME"}}
        environment["PATH"] = "/usr/bin:/bin"
        child = subprocess.Popen([str(executable), "--project", temporary, "--create"],
                                 cwd=temporary, env=environment, stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            assert select.select([child.stdout], [], [], 10)[0], "Backend did not start"
            line = child.stdout.readline()
            assert line, f"Backend failed: {child.stderr.read().decode()}"
            ready = json.loads(line)

            def read(route):
                with urlopen(ready["url"] + route, timeout=5) as response:
                    return response.read()

            state = json.loads(read("/api/state"))
            assert state["nodes"] == []
            assert len(state["canvases"]) == 1
            assert b"workbenchDesktop" in read("/static/app.js")
            assert b' id="node-status"' in read("/")
            assert b' id="selection-box"' in read("/")

            def write(route, payload, method="POST"):
                request = Request(ready["url"] + route, method=method, data=json.dumps(payload).encode(),
                                  headers={"Content-Type": "application/json", "X-Idea-Token": state["csrf_token"]})
                with urlopen(request, timeout=5) as response:
                    assert response.status == (201 if method == "POST" else 200)
                    return json.loads(response.read())

            canvas = write("/api/canvases", {"title": "Packaged canvas"})
            idea = write("/api/nodes", {"kind": "idea", "title": "Packaged idea", "canvas_id": canvas["id"]})
            experiment = write("/api/nodes", {"kind": "experiment", "title": "Standalone experiment", "canvas_id": canvas["id"]})
            assert json.loads(read("/api/state"))["edges"] == []
            edge = {"source": idea["id"], "target": experiment["id"]}
            write("/api/edges", edge)
            assert len(json.loads(read("/api/state"))["edges"]) == 1
            assert write(f"/api/nodes/{experiment['id']}", {"status": "done"}, "PATCH")["status"] == "done"
            write("/api/edges", edge, "DELETE")
            final = json.loads(read("/api/state"))
            assert len(final["nodes"]) == 2 and final["edges"] == []
            write("/api/edges", edge)
            removed = write("/api/selection", {"canvas_id": canvas["id"], "node_ids": [idea["id"]], "edges": []}, "DELETE")
            assert removed == {"nodes": 1, "edges": 1, "runs": 0}
            final = json.loads(read("/api/state"))
            assert [n["id"] for n in final["nodes"]] == [experiment["id"]] and final["edges"] == []
            child.stdin.close()
            assert child.wait(timeout=5) == 0
            assert not child.stderr.read()
            print("Packaged app passed: contained links, runtime, canvas assets, create/link/status/unlink/batch-delete, EOF shutdown.")
        finally:
            if child.poll() is None:
                child.kill()
                child.wait()
            for pipe in (child.stdin, child.stdout, child.stderr):
                pipe.close()


if __name__ == "__main__":
    main()
