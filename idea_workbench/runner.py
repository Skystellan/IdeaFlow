"""Capture selected source files and run in that snapshot, independently of the UI."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import uuid
from pathlib import Path

from .store import Store, encode, now

SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", ".ssh", ".aws", ".codex", ".agents", ".idea-workbench", "runs", "models"}
ARTIFACTS = {"stdout.log", "stderr.log", "metrics.json", "config.json", "snapshot.json", "git.patch", "worker.log"}
JSON_LIMIT = 1024 * 1024


def write_json(path, data):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(encode(data) + "\n", encoding="utf-8")
    temporary.replace(path)


def read_object(path):
    if path.stat().st_size > JSON_LIMIT:
        raise ValueError("JSON artifact exceeds 1 MiB")
    def reject_constant(value):
        raise ValueError(f"Non-finite JSON value: {value}")
    data = json.loads(path.read_text(encoding="utf-8"), parse_constant=reject_constant)
    if not isinstance(data, dict):
        raise ValueError("Expected a JSON object")
    return data


def safe_source(relative):
    return not (set(relative.parts) & SKIP_DIRS or any(p.startswith(".env") for p in relative.parts)
                or relative.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}
                or relative.name.lower() in {"credentials", "credentials.json", "id_rsa", "id_ed25519"})


def snapshot(project, destination, includes, store_path):
    if not includes:
        raise ValueError("Select source files with --include (repeatable; paths or globs relative to project)")
    selected = set()
    for pattern in includes:
        if not isinstance(pattern, str) or not pattern or Path(pattern).is_absolute() or ".." in Path(pattern).parts:
            raise ValueError("Snapshot includes must be relative paths within the project")
        matches = list(project.glob(pattern))
        if not matches:
            raise ValueError(f"No source matches: {pattern}")
        for match in matches:
            for file in (match.rglob("*") if match.is_dir() else [match]):
                relative = file.relative_to(project)
                if not safe_source(relative) or file.resolve().is_relative_to(store_path):
                    continue
                if file.is_symlink() or any(p.is_symlink() for p in file.parents if p != project and p.is_relative_to(project)):
                    raise ValueError(f"Symlinks are not copied into snapshots: {relative}")
                if file.is_file():
                    selected.add(relative)
    if not selected:
        raise ValueError("No eligible source files selected (private/runtime paths are excluded)")
    if len(selected) > 2000:
        raise ValueError("Snapshot exceeds 2000 files; narrow --include to source files")
    destination.mkdir(parents=True, exist_ok=False)
    files = []
    total = 0
    for relative in sorted(selected):
        source = project / relative
        if source.stat().st_size > 20 * 1024 * 1024:
            raise ValueError(f"Source exceeds 20 MiB: {relative}; reference large data separately")
        content = source.read_bytes()
        total += len(content)
        if total > 100 * 1024 * 1024:
            raise ValueError("Snapshot exceeds 100 MiB")
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        target.chmod(0o555 if os.access(source, os.X_OK) else 0o444)
        files.append({"path": relative.as_posix(), "size": len(content), "sha256": hashlib.sha256(content).hexdigest()})

    def git(*args):
        try:
            result = subprocess.run(["git", "-C", str(project), *args], capture_output=True, timeout=15)
            return result.stdout.decode("utf-8", errors="replace").strip() if result.returncode == 0 else None
        except (OSError, subprocess.TimeoutExpired):
            return None

    paths = [f["path"] for f in files]
    commit = git("rev-parse", "--verify", "HEAD")
    status = git("status", "--porcelain", "--untracked-files=all", "--", *paths)
    patch = git("diff", "--no-ext-diff", "--no-textconv", "--binary", *(["HEAD"] if commit else []), "--", *paths)
    (destination.parent / "git.patch").write_text(patch or "", encoding="utf-8")
    return {"method": "selected-source-snapshot", "git_commit": commit,
            "git_branch": git("branch", "--show-current"), "dirty": bool(status) if status is not None else None,
            "git_scope": "included files only; source snapshot is authoritative", "files": files,
            "captured_at": now(), "environment": {"platform": platform.platform(), "recorder_python": sys.version.split()[0]},
            "limitations": "External data, installed packages and services are referenced, not frozen. This is not a process sandbox."}


def new_run(experiment_id, *, command=None, params=None, origin="managed"):
    return dict(id="r-" + uuid.uuid4().hex[:12], experiment_id=experiment_id, status="queued",
                created_at=now(), started_at=None, finished_at=None, command=command or [], params=params or {},
                actual_params=None, metrics=None, snapshot=None, exit_code=None, error=None, origin=origin, pid=None)


def prepare_run(store, experiment_id, command, includes, params):
    if store.node(experiment_id)["kind"] != "experiment":
        raise ValueError("Choose an experiment node to run")
    if not isinstance(params, dict):
        raise ValueError("params must be a JSON object")
    encode(params)
    if not command or not all(isinstance(x, str) and x for x in command):
        raise ValueError("Supply an executable and arguments after --")
    project = Path(store.state()["project"]["root"])
    run = new_run(experiment_id, command=command, params=params)
    directory = store.path / "runs" / run["id"]
    directory.mkdir(mode=0o700, parents=True)
    try:
        run["snapshot"] = snapshot(project, directory / "source", includes, store.path)
        execution_command = []
        for i, arg in enumerate(command):
            # Absolute code paths within the project must point to the captured copy.
            candidate = Path(arg)
            if i > 0 and candidate.is_absolute() and candidate.resolve().is_relative_to(project):
                relative = candidate.resolve().relative_to(project)
                copied = directory / "source" / relative
                if not copied.exists():
                    raise ValueError(f"Argument points to uncaptured project file: {relative}")
                arg = str(copied)
            execution_command.append(arg)
        # A project-local executable also needs to run from its snapshot.
        executable = Path(command[0])
        if executable.is_absolute() and executable.resolve().is_relative_to(project):
            relative = executable.resolve().relative_to(project)
            copied = directory / "source" / relative
            if not copied.exists():
                # Virtual-environment interpreters are environment dependencies, not source files.
                if ".venv" not in executable.parts and "venv" not in executable.parts:
                    raise ValueError("Include the project executable in the source snapshot")
            else:
                execution_command[0] = str(copied)
        run["execution_command"] = execution_command
        write_json(directory / "snapshot.json", run["snapshot"])
        write_json(directory / "requested-params.json", params)
        store.add_run(run)
    except Exception:
        # Only discard this newly allocated, unregistered snapshot on preparation failure.
        shutil.rmtree(directory)
        raise
    return run


def start_run(store, experiment_id, command, includes, params, wait=False):
    run = prepare_run(store, experiment_id, command, includes, params)
    directory = store.path / "runs" / run["id"]
    env = os.environ.copy()
    env["PYTHONPATH"] = str(Path(__file__).resolve().parent.parent)
    try:
        with (directory / "worker.log").open("ab") as output:
            worker = subprocess.Popen([sys.executable, "-m", "idea_workbench", "--store", str(store.path), "_worker", run["id"]],
                                      cwd=Path(__file__).resolve().parent.parent, env=env, stdin=subprocess.DEVNULL,
                                      stdout=output, stderr=output, start_new_session=True)
        store.update_run(run["id"], pid=worker.pid)
    except OSError as exc:
        store.update_run(run["id"], status="failed", error=str(exc), finished_at=now())
        raise
    if wait:
        worker.wait()
    return store.run(run["id"])


def execute_run(store, run_id):
    run = store.run(run_id)
    if run["status"] != "queued":
        raise ValueError("This run has already started; create a new run to retry")
    directory = store.path / "runs" / run_id
    env = os.environ.copy()
    env.pop("PYTHONPATH", None)
    env.update(IDEA_RUN_ID=run_id, IDEA_RESULTS_DIR=str(directory),
               IDEA_CONFIG_PATH=str(directory / "config.json"), IDEA_METRICS_PATH=str(directory / "metrics.json"))
    store.update_run(run_id, status="running", started_at=now(), pid=os.getpid())
    child = None

    def stop(signum, frame):
        if child is not None and child.poll() is None:
            child.terminate()
        raise InterruptedError("Run interrupted")

    previous_handlers = {sig: signal.signal(sig, stop) for sig in (signal.SIGTERM, signal.SIGINT)}
    try:
        with (directory / "stdout.log").open("wb") as out, (directory / "stderr.log").open("wb") as err:
            child = subprocess.Popen(run["execution_command"], cwd=directory / "source", env=env, stdout=out, stderr=err,
                                     stdin=subprocess.DEVNULL)
            code = child.wait()
        updates = {"exit_code": code, "status": "succeeded" if code == 0 else "failed",
                   "error": None if code == 0 else f"Process exited with code {code}"}
        for name, field in (("config.json", "actual_params"), ("metrics.json", "metrics")):
            path = directory / name
            if path.exists():
                try:
                    if path.is_symlink():
                        raise ValueError("Result files must not be symlinks")
                    updates[field] = read_object(path)
                except (ValueError, OSError) as exc:
                    updates.update(status="failed", error=f"Invalid {name}: {exc}")
        store.update_run(run_id, **updates, finished_at=now())
    except (OSError, InterruptedError) as exc:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        store.update_run(run_id, status="interrupted" if isinstance(exc, InterruptedError) else "failed",
                         error=str(exc), finished_at=now())
    finally:
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
    return store.run(run_id)


def import_run(store, experiment_id, metrics_path, params):
    if store.node(experiment_id)["kind"] != "experiment":
        raise ValueError("Choose an experiment node")
    metrics = read_object(Path(metrics_path))
    if not isinstance(params, dict):
        raise ValueError("params must be an object")
    run = new_run(experiment_id, params=params, origin="imported")
    directory = store.path / "runs" / run["id"]
    directory.mkdir(mode=0o700, parents=True)
    write_json(directory / "metrics.json", metrics)
    run.update(status="imported", metrics=metrics, finished_at=now(),
               import_note="Imported observations; historical execution time, actual parameters and code were not captured.")
    return store.add_run(run)


def artifact(store, run_id, name):
    store.run(run_id)
    if name not in ARTIFACTS:
        raise ValueError("Unknown artifact")
    directory = store.path / "runs" / run_id
    path = directory / name
    if directory.resolve() != directory or path.is_symlink() or not path.resolve().is_relative_to(directory):
        raise ValueError("Artifact links outside the run are not readable")
    with path.open("rb") as stream:
        data = stream.read(JSON_LIMIT + 1)
    return data[:JSON_LIMIT].decode("utf-8", errors="replace") + ("\n[truncated at 1 MiB]" if len(data) > JSON_LIMIT else "")
