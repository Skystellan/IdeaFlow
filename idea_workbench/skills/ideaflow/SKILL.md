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

## Keep the researcher's words when they are said

The journal is append-only and separate from the graph. Titles, bodies, grouping and links may be reorganized at any time; journal entries cannot be edited or deleted. Record there only what cannot be reconstructed afterwards: why something is tried, what was expected, the first reaction to a result, and decisions on proposals. Everything derivable (what ran, parameters, code, metrics, titles) belongs to runs and nodes.

- Every recorded text names its author with `--by human` or `--by agent`. `human` means the researcher's own words copied from their message. Quote them verbatim; you may drop unrelated surrounding sentences but never paraphrase, translate, tidy or complete them. Your own explanations are always `--by agent`.
- When the researcher asks you to run something, pass their stated reason as `run --why TEXT --by human` and any stated expectation as `--expect TEXT`. If they gave no reason or expectation, leave the flag out. Do not infer one, and do not attribute your rationale to them. A run you start on your own initiative uses `--by agent`.
- Propose next experiments with `propose --title TITLE --source NODE_ID --why RATIONALE` instead of creating and starting them; the rationale is recorded as yours. A proposal waits in the app's frontier; a status edit cannot approve it, only `decide` can. When the researcher approves or declines in chat, record it with `decide NODE_ID --approve --text "THEIR WORDS"` (optionally `--expect "THEIR WORDS"`) or `--decline`. Never decide on their behalf. Start the run only after an approval.
- After a run finishes, show the observed result and ask for the researcher's first reaction before interpreting it. Record it with `react RUN_ID --outcome expected|surprised|mixed --text "THEIR WORDS"`, or `react --node EXPERIMENT_ID ...` when they judge the experiment as a whole (for example one with no recorded runs). A reaction marks the experiment `done`; set it back to `active` if more runs are planned. Reactions are always the researcher's, so never react on your own judgement. Add your interpretation separately with `note NODE_ID --by agent --text ...`. A surprise is a good place to propose a forked question.
- `note NODE_ID --text TEXT --by human|agent [--kind intent|expectation|note] [--run RUN_ID]` appends anything else worth keeping verbatim. An intent or expectation tied to `--run` is accepted only before that run finishes; later thoughts are notes. `journal [NODE_ID]` reads entries; `frontier [--canvas ID]` lists proposals awaiting a decision, finished runs awaiting a reaction, running work, recent surprises and planned steps.
- When reconstructing history after the fact, create nodes and runs, but write no `--by human` intents or expectations unless you are quoting what the researcher wrote at the time. Missing intent stays missing; the app shows that gap honestly.

## Connect records and update status

Use `--source NODE_ID` when creating a node to connect it to its exact source; repeat it for a synthesis of multiple sources on the same canvas. Nodes may also be created without connections, then connected with `link --source SOURCE_ID --target TARGET_ID --reason TEXT`. `unlink --source SOURCE_ID --target TARGET_ID` removes only that connection. Links express provenance or a proposed direction, not proof; self-links, cycles and cross-canvas links are not allowed. `--idea IDEA_ID` sets legacy branch ownership when needed for a synthesis; it does not select a canvas.

Use `edit NODE_ID --kind idea|experiment` to change a node's type when the researcher asks; an experiment with runs stays an experiment, and a proposal awaiting a decision keeps its type. Use `edit NODE_ID --status STATUS` to change a node's state:

- `proposed`: a question or test awaiting validation; explicitly pass `--status proposed` when recording a planned experiment.
- `active`: currently being pursued; set it when starting an experiment.
- `done`: the recorded scope is completed and its results have been reviewed. Negative results can complete an experiment; completion does not mean the hypothesis is true.
- `paused`: intentionally suspended; record the reason and resumption condition in the body.

Node state and run state are independent. Finishing a run does not automatically change its node's state; inspect the results and update the node as appropriate. The CLI defaults most new nodes to `active`, unlike the app's planned-experiment default, so set the intended status explicitly. Do not leave a known completed experiment `proposed`, mark an unperformed test `done`, or infer historical completion from a suggestive title alone. In the app, an experiment's thread-map state is its status, plus the latest reaction once it is `done`; an `active` experiment shows as in progress.

## Capture a real experiment

Use `run --experiment ID --include SOURCE --params-file PARAMETERS.json [--why TEXT --expect TEXT --by human|agent] -- COMMAND...`. Include the script and local modules it needs; paths are relative to the registered project root. The runner executes the selected source snapshot and stores logs, Git metadata, and source files without committing or staging the user's code.

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

Bodies are Markdown; the app renders headings, lists, task lists (`- [ ]`), code blocks, links and images, and the researcher edits them there as notes. Images appear as `![](assets/NAME)`; the file is in the store's `assets/` directory, so open it when it matters. Keep image references when rewriting a body. Record observations, tentative explanations and alternatives separately in the body, cite the run IDs, and identify agent-authored interpretations as drafts. Update the relevant existing record when the result refines it. Add an `idea` linked to its experiment(s) when a distinct finding or branch deserves its own node; use `propose` for a concrete next test, explaining in `--why` why it helps and how outcomes would change the direction. Do not mechanically create two more nodes after every run. Use `--body-file` for substantial prose.

The researcher can revise drafts, pause a branch or continue immediately; this workflow adds no approval gate to already authorized work. `edit` preserves prior text. Do not delete historical evidence merely to tidy the graph.

Report the affected canvas, node and run IDs as relevant, the observed outcome, and the next unresolved question. Do not invent metrics, infer unobserved settings from chat, or treat illustrative/demo findings as general research conclusions.
