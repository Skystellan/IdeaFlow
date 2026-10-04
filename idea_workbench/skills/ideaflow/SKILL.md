---
name: ideaflow
description: Continue an idea branch, record experiments and evidence, and preserve insights and next steps in the local IdeaFlow. Use when the user asks to run or review research experiments with this workbench; not for unrelated coding tasks.
---

# IdeaFlow

Use the project's durable research graph to continue the user's research across Codex chats. The desktop app, web application and CLI share one SQLite store; a chat is not the source of truth.

Run `python3 -m idea_workbench --help` from the checkout containing the `idea_workbench` package. Determine the target research project from the request and original working directory before changing directories. Always pass its absolute `--store` path before the subcommand, including when the skill is installed in another project. Do not silently write another project's experiments into the tool checkout's default store. See `idea_workbench/README.md` in that checkout for the command reference.

## Continue a branch

- Use the store, canvas and node IDs supplied by the user. Otherwise inspect `python3 -m idea_workbench --store PATH status`, including `canvases` and each node's `canvas_id`, and select the existing records matching the request. Do not silently choose between genuinely ambiguous research projects or canvases.
- Retrieve `context NODE_ID` before planning. Preserve the current question, actual observations, unresolved explanations, and proposed next steps.
- A research branch is not a separate canvas. Keep related questions, findings and experiments on their existing canvas. Use `canvas --title TITLE` only when the user wants a separate canvas; it creates an empty canvas.
- Prefer two node kinds for new records: `idea` for questions, hypotheses and insights; `experiment` for planned tests and their execution. Reuse an existing planned experiment when starting it. Parameter variants or repeated seeds are runs of the same experiment.
- Read legacy `insight` as a thought and `next` as a planned test; do not bulk rewrite historical nodes. Runs require kind `experiment`, so executing a legacy `next` requires a linked experiment node (reuse one if it already exists).
- Pass IDs explicitly; do not rely on the app's current selection across parallel chats. Use `node --canvas CANVAS_ID --kind KIND ...` to place a new node, especially a disconnected one. Without `--canvas`, a node inherits its sources' canvas or defaults to `canvas-main`.

## Connect records and update status

Use `--source NODE_ID` when creating a node to connect it to its exact source; repeat it for a synthesis of multiple sources on the same canvas. Nodes may also be created without connections, then connected with `link --source SOURCE_ID --target TARGET_ID --reason TEXT`. `unlink --source SOURCE_ID --target TARGET_ID` removes only that connection. Links express provenance or a proposed direction, not proof; self-links, cycles and cross-canvas links are not allowed. `--idea IDEA_ID` sets legacy branch ownership when needed for a synthesis; it does not select a canvas.

Use `edit NODE_ID --status STATUS` to change a node's state:

- `proposed`: a question or test awaiting validation; explicitly pass `--status proposed` when recording a planned experiment.
- `active`: currently being pursued; set it when starting an experiment.
- `done`: the recorded scope is completed and its results have been reviewed. Negative results can complete an experiment; completion does not mean the hypothesis is true.
- `paused`: intentionally suspended; record the reason and resumption condition in the body.

Node state and run state are independent. Finishing a run does not automatically change its node's state; inspect the results and update the node as appropriate. The CLI defaults most new nodes to `active`, unlike the app's planned-experiment default, so set the intended status explicitly. Do not leave a known completed experiment `proposed`, mark an unperformed test `done`, or infer historical completion from a suggestive title alone. Status lights are presentation only; no UI interaction is needed to change the stored status.

## Capture a real experiment

Use `run --experiment ID --include SOURCE --params-file PARAMETERS.json -- COMMAND...`. Include the script and local modules it needs; paths are relative to the registered project root. The runner executes the selected source snapshot and stores logs, Git metadata, and source files without committing or staging the user's code.

Runs detach by default; `--wait` waits for small experiments. Keep the returned run ID and inspect `status RUN_ID`. Closing the web page does not stop the worker. A process running successfully does not establish that a hypothesis is correct.

Have cooperative scripts write JSON objects to:

- `IDEA_CONFIG_PATH`: the actual parsed configuration, including defaults.
- `IDEA_METRICS_PATH`: observed metrics.
- `IDEA_RESULTS_DIR`: additional local outputs.

`--params` describes intended settings; it is not proof of actual settings. The snapshot does not freeze external datasets, installed dependencies, services or randomness; record their versions and seeds when relevant. A required uncaptured local dependency is a reason to correct the snapshot selection, not to claim full reproducibility.

Keep secrets in the environment, not command arguments, parameters, source or logs. Snapshot selection excludes common secret and runtime paths, but is not a secret scanner or execution sandbox. Run only experiments within the user's existing authorization and resource budget.

For an already completed experiment, use `import-run` with its metrics. Imported historical code, start time and actual parameters remain unknown; never substitute today's Git state as the historical snapshot.

## Close the research loop

Read the actual run records and relevant logs. Use `compare LEFT_RUN RIGHT_RUN` when conditions are meaningfully comparable. Missing metrics, execution failures and scientific negative results are different outcomes.

Record observations, tentative explanations and alternatives separately in the body, cite the run IDs, and identify agent-authored interpretations as drafts. Update the relevant existing record when the result refines it. Add an `idea` linked to its experiment(s) when a distinct finding or branch deserves its own node; add a proposed `experiment` for a concrete next test, explaining why it helps and how outcomes would change the direction. Do not mechanically create two more nodes after every run. Use `--body-file` for substantial prose.

The researcher can revise drafts, pause a branch or continue immediately; this workflow adds no approval gate to already authorized work. `edit` preserves prior text. Do not delete historical evidence merely to tidy the graph.

Report the affected canvas, node and run IDs as relevant, the observed outcome, and the next unresolved question. Do not invent metrics, infer unobserved settings from chat, or treat illustrative/demo findings as general research conclusions.
