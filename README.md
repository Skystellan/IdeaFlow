# IdeaFlow

A local research canvas for turning ideas into experiments, evidence, and the next question.

**Idea → experiment → result → insight → next experiment.** Keep the branches and their evidence connected, with a human guiding the research loop.

[中文使用指南](idea_workbench/README.md) · [Agent skill](idea_workbench/skills/ideaflow/SKILL.md) · [MIT license](LICENSE)

## What it does

- **Map research as a graph.** Separate canvases for independent topics; branching and merging within each canvas.
- **Work directly on the canvas.** Create and connect nodes, pan and pinch to zoom, drag nodes or a selected group, and resize the detail panel. Thoughts and experiments use different shapes; small status lights keep the canvas readable.
- **Keep evidence with each experiment.** Record declared and actual parameters, metrics, logs, source snapshots, Git metadata, and multiple runs per experiment. Compare runs and preserve edits as revisions.
- **Work with Codex.** A bundled skill and JSON CLI let an agent read existing context, run experiments, and write findings and next steps into the same store as the app.
- **Own your data.** SQLite and experiment files stay in your project. No account, hosted database, or model API key is required by IdeaFlow itself.

Early, single-user MVP. The UI is currently in Chinese. Browser mode and a macOS Electron app share the same Python backend. MCP, remote execution sync, and an autonomous research agent are not implemented yet; other agents can use the CLI, but dedicated integrations are not included.

## Quick start

Requires Python 3.10+. Browser mode uses only the Python standard library.

```sh
git clone https://github.com/Skystellan/ideaflow.git
cd ideaflow
python3 -m idea_workbench --store runs/demo demo
python3 -m idea_workbench --store runs/demo serve
```

Open <http://127.0.0.1:8770/>. The demo runs four small CPU polynomial-fitting experiments and builds a graph from their actual results. It uses synthetic data and makes no general research claims. To reopen it, run only the `serve` command; `demo` intentionally refuses a nonempty graph.

## Use it with your research

Run these commands from the IdeaFlow checkout. Replace `/absolute/path/to/research` with your existing research project directory:

```sh
python3 -m idea_workbench --store /absolute/path/to/research/.idea-workbench \
  init --name "My research" --project /absolute/path/to/research
python3 -m idea_workbench install-skill --project /absolute/path/to/research
python3 -m idea_workbench --store /absolute/path/to/research/.idea-workbench serve
```

The skill is installed into that project's `.agents/skills/ideaflow/`. In Codex, invoke `$ideaflow` and provide the IdeaFlow checkout path and research store path. Ask it to read an existing branch, test one small idea, and record the observed result and next question. The skill does not automatically record unrelated chats or shell commands.

Useful entry points:

```sh
python3 -m idea_workbench --help
python3 -m idea_workbench --store /absolute/path/to/research/.idea-workbench status
python3 -m idea_workbench --store /absolute/path/to/research/.idea-workbench context NODE_ID
```

See the [full guide](idea_workbench/README.md) for creating nodes and canvases, connecting branches, capturing experiment runs, importing existing metrics, and comparing results.

## macOS app

Build on macOS with Python, Node.js 22+, and Xcode Command Line Tools installed:

```sh
python3 -m venv .venv-desktop
.venv-desktop/bin/python -m pip install -r idea_workbench/desktop/requirements-build.txt
npm --prefix idea_workbench/desktop ci
node idea_workbench/desktop/package.mjs --python .venv-desktop/bin/python
```

The build prints the path to `IdeaFlow.app`. Copy it to Applications. The packaged app contains its Python runtime and opens the same project stores used by the CLI. This builds for the current Mac's architecture with an ad-hoc signature; it is not a notarized distribution. For development, run `npm --prefix idea_workbench/desktop start` after installing dependencies.

## Data and execution boundaries

The service binds to localhost. It is designed for one person on one machine, not a public or multi-user server. Experiment execution happens through the local CLI, not the web API.

A captured source snapshot is not an execution sandbox or a complete environment snapshot. External datasets, dependencies, and randomness still need to be recorded. Keep credentials out of included source, parameters, and logs. Research stores and generated outputs are ignored by Git; export JSON or back up the entire store separately.

## Development

No Python dependencies are required for the tests. Node.js is used for the canvas regression checks.

```sh
python3 -m unittest discover -s tests -p 'test_idea_workbench*.py' -v
node --check idea_workbench/static/app.js
node tests/test_idea_workbench_layout.cjs
node tests/test_idea_workbench_gestures.cjs
```

The repository contains the Python package, static canvas, Electron shell, agent skill, synthetic example, and focused regression tests. Issues and pull requests are welcome; include steps to reproduce with a synthetic graph rather than private research data.

## License

[MIT](LICENSE) © 2026 Skystellan.
