"""CLI entry point used by people and Codex."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

from .runner import execute_run, import_run, read_object, start_run
from .store import KINDS, STATUSES, Store, encode


def parser():
    p = argparse.ArgumentParser(description="IdeaFlow: local research graph and experiment recorder")
    p.add_argument("--store", type=Path, default=Path(".idea-workbench"), help="Persistent project records (put before subcommand)")
    sub = p.add_subparsers(dest="action", required=True)
    init = sub.add_parser("init", help="Initialize a project without modifying existing records")
    init.add_argument("--name", default="我的研究")
    init.add_argument("--project", type=Path, default=Path.cwd())
    serve = sub.add_parser("serve", help="Open the loopback web workbench")
    serve.add_argument("--port", type=int, default=8770)
    canvas = sub.add_parser("canvas", help="Create an empty canvas")
    canvas.add_argument("--title", required=True)
    node = sub.add_parser("node", help="Create an idea, experiment, insight or next step")
    node.add_argument("--kind", required=True, choices=sorted(KINDS))
    node.add_argument("--title", required=True)
    node.add_argument("--body", default="")
    node.add_argument("--body-file", type=Path)
    node.add_argument("--source", action="append", default=[])
    node.add_argument("--reason", default="")
    node.add_argument("--idea", help="Owning idea when synthesizing across branches")
    node.add_argument("--canvas", help="Canvas ID; defaults to the source canvas or canvas-main")
    node.add_argument("--status", choices=sorted(STATUSES))
    link = sub.add_parser("link", help="Connect two existing nodes on the same canvas")
    link.add_argument("--source", required=True)
    link.add_argument("--target", required=True)
    link.add_argument("--reason", default="")
    unlink = sub.add_parser("unlink", help="Remove a connection, keeping both nodes")
    unlink.add_argument("--source", required=True)
    unlink.add_argument("--target", required=True)
    edit = sub.add_parser("edit", help="Edit a record, preserving its previous version")
    edit.add_argument("id")
    edit.add_argument("--title")
    edit.add_argument("--body")
    edit.add_argument("--body-file", type=Path)
    edit.add_argument("--status", choices=sorted(STATUSES))
    context = sub.add_parser("context", help="Retrieve a research branch for a fresh Codex conversation")
    context.add_argument("id")
    context.add_argument("--json", action="store_true")
    run = sub.add_parser("run", help="Capture selected source and launch a detached experiment")
    run.add_argument("--experiment", required=True)
    run.add_argument("--include", action="append", required=True, help="Source path/glob relative to project (repeatable)")
    run.add_argument("--params", default="{}", help="Declared parameters, JSON object; not inferred actual configuration")
    run.add_argument("--params-file", type=Path)
    run.add_argument("--wait", action="store_true")
    run.add_argument("command", nargs=argparse.REMAINDER)
    imported = sub.add_parser("import-run", help="Import existing JSON metrics with explicit unknown provenance")
    imported.add_argument("--experiment", required=True)
    imported.add_argument("--metrics", type=Path, required=True)
    imported.add_argument("--params", default="{}")
    status = sub.add_parser("status", help="Read a run or all project records")
    status.add_argument("id", nargs="?")
    compare = sub.add_parser("compare", help="Compare recorded parameters, metrics and source files")
    compare.add_argument("left")
    compare.add_argument("right")
    sub.add_parser("export", help="Export graph, runs and revision history as JSON (artifacts remain on disk)")
    demo = sub.add_parser("demo", help="Run the real, small CPU example in an empty store; no API keys needed")
    demo.add_argument("--name", default="多项式拟合 · CPU 示例研究")
    skill = sub.add_parser("install-skill", help="Install the bundled skill in a project's .agents/skills directory")
    skill.add_argument("--project", type=Path, default=Path.cwd())
    worker = sub.add_parser("_worker", help=argparse.SUPPRESS)
    worker.add_argument("id")
    return p


def demo(path, name):
    project = Path(__file__).resolve().parent.parent
    store = Store.initialize(path, name, project)
    if store.state()["nodes"]:
        raise ValueError("Demo requires an empty store; choose a new --store directory to preserve existing research")
    root = store.add_node(kind="idea", title="更高阶的拟合一定更好吗？", body="CPU 教学实验：拟合带噪声的 sin(3x)，区分训练误差、区间内预测与外推。数值由真实运行产生，解释只适用于这个合成任务。")
    first = store.add_node(kind="experiment", title="同样的数据，比较 3 阶与 9 阶", source_ids=[root["id"]], body="固定 18 个训练样本与随机种子 7；改变多项式阶数。")

    def run_for(node, degree, samples):
        result = start_run(store, node["id"], [sys.executable, "idea_workbench/examples/polynomial.py", "--degree", str(degree), "--samples", str(samples), "--seed", "7"],
                           ["idea_workbench/examples/polynomial.py"], {"degree": degree, "samples": samples, "seed": 7}, wait=True)
        if result["status"] != "succeeded" or result["metrics"] is None:
            raise ValueError(f"CPU example failed: {result['id']} {result['error']}")
        return result

    low, high = run_for(first, 3, 18), run_for(first, 9, 18)
    store.edit_node(first["id"], status="done")
    observed = store.add_node(kind="insight", title="把训练拟合与外推能力分开检查", source_ids=[first["id"]],
        body=f"实际记录 {low['id']} / {high['id']}：3 阶训练 RMSE={low['metrics']['train_rmse']:.4g}，外推 RMSE={low['metrics']['extrapolation_rmse']:.4g}；9 阶训练 RMSE={high['metrics']['train_rmse']:.4g}，外推 RMSE={high['metrics']['extrapolation_rmse']:.4g}。这是单个种子的合成数据观察，还不能推广。")
    a = store.add_node(kind="idea", title="增加样本能否改善外推？", source_ids=[observed["id"]], reason="先固定阶数，单独检查数据量的作用。")
    b = store.add_node(kind="idea", title="中等阶数是否更稳？", source_ids=[observed["id"]], reason="固定数据量，探索模型复杂度的影响。")
    ea = store.add_node(kind="experiment", title="9 阶模型增加到 80 个样本", source_ids=[a["id"]])
    eb = store.add_node(kind="experiment", title="18 个样本改用 5 阶模型", source_ids=[b["id"]])
    ra, rb = run_for(ea, 9, 80), run_for(eb, 5, 18)
    insights = []
    for exp, result, label in ((ea, ra, "样本量"), (eb, rb, "模型阶数")):
        store.edit_node(exp["id"], status="done")
        insight = store.add_node(kind="insight", title=f"记录{label}实验的观察", source_ids=[exp["id"]],
            body=f"运行 {result['id']}：训练 RMSE={result['metrics']['train_rmse']:.4g}；区间内 RMSE={result['metrics']['interpolation_rmse']:.4g}；外推 RMSE={result['metrics']['extrapolation_rmse']:.4g}。与首轮运行比较；目前只有一个种子，需要重复验证。")
        insights.append(insight)
    store.add_node(kind="next", title="跨种子复核后，回到主线做联合对照", source_ids=[i["id"] for i in insights], idea_id=root["id"],
                   reason="综合两条支线的实际观察，保留来源。", body="先分别用多个种子复核，再比较阶数与样本量的组合；不将教学示例当作通用结论。")
    return {"store": str(store.path), "root": root["id"], "runs": [r["id"] for r in (low, high, ra, rb)], "status": "demo_complete"}


def install_skill(project):
    project = project.expanduser().resolve()
    if not project.is_dir():
        raise ValueError("Project directory must exist")
    source = Path(__file__).parent / "skills" / "research-workbench" / "SKILL.md"
    target = project / ".agents" / "skills" / "research-workbench" / "SKILL.md"
    if target.exists() and target.read_bytes() != source.read_bytes():
        raise ValueError(f"A different skill already exists at {target}; it was not overwritten")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
    return {"skill": str(target)}


def main():
    p = parser()
    args = p.parse_args()
    try:
        if args.action == "init":
            result = Store.initialize(args.store, args.name, args.project).state()["project"]
        elif args.action == "demo":
            result = demo(args.store, args.name)
        elif args.action == "install-skill":
            result = install_skill(args.project)
        else:
            store = Store(args.store)
            if args.action == "serve":
                from .server import create_server
                server = create_server(store, args.port)
                print(f"IdeaFlow: http://127.0.0.1:{server.server_port}/", flush=True)
                try:
                    server.serve_forever()
                except KeyboardInterrupt:
                    pass
                finally:
                    server.server_close()
                return
            elif args.action == "node":
                result = store.add_node(kind=args.kind, title=args.title, body=args.body_file.read_text() if args.body_file else args.body,
                                        source_ids=args.source, reason=args.reason, idea_id=args.idea, status=args.status, canvas_id=args.canvas)
            elif args.action == "canvas":
                result = store.add_canvas(args.title)
            elif args.action == "link":
                result = store.add_edge(args.source, args.target, args.reason)
            elif args.action == "unlink":
                result = store.remove_edge(args.source, args.target)
            elif args.action == "edit":
                changes = {k: getattr(args, k) for k in ("title", "body", "status") if getattr(args, k) is not None}
                if args.body_file:
                    changes["body"] = args.body_file.read_text()
                result = store.edit_node(args.id, **changes)
            elif args.action == "context":
                result = store.context(args.id)
                if not args.json:
                    print(result["text"])
                    return
            elif args.action == "run":
                command = args.command[1:] if args.command[:1] == ["--"] else args.command
                params = read_object(args.params_file) if args.params_file else json.loads(args.params)
                result = start_run(store, args.experiment, command, args.include, params, args.wait)
            elif args.action == "_worker":
                result = execute_run(store, args.id)
            elif args.action == "import-run":
                result = import_run(store, args.experiment, args.metrics, json.loads(args.params))
            elif args.action == "status":
                result = store.run(args.id) if args.id else store.state()
            elif args.action == "compare":
                result = store.compare(args.left, args.right)
            elif args.action == "export":
                result = store.export()
        print(encode(result))
        if args.action in {"run", "_worker"} and result["status"] in {"failed", "interrupted"}:
            sys.exit(1)
    except (ValueError, OSError) as exc:
        p.exit(2, f"Error: {exc}\n")


if __name__ == "__main__":
    main()
