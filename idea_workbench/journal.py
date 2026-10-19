"""Append-only research journal: words recorded when they were said, never rewritten.

The graph (titles, bodies, layout) may be reorganized at any time. Journal entries keep
what could not be reconstructed later: why something was tried, what was expected, the
first reaction to a result, and decisions about proposals.
"""
from __future__ import annotations

import uuid

from .fields import now, text_field

ENTRY_KINDS = {"proposal", "decision", "intent", "expectation", "reaction", "note"}
WRITABLE_KINDS = {"intent", "expectation", "note"}
AUTHORS = {"human", "agent"}
OUTCOMES = {"expected", "surprised", "mixed"}
DECISIONS = {"approved", "declined"}
SOURCES = {"app", "cli"}
TEXT_LIMIT = 4000
UNFINISHED_RUNS = {"queued", "running"}

# Executed one statement at a time inside the store's opening transaction. node_id has no
# foreign key on purpose: deleting or reorganizing graph nodes never removes what was said.
SCHEMA = (
    """CREATE TABLE IF NOT EXISTS entries(
        id TEXT PRIMARY KEY, node_id TEXT NOT NULL, run_id TEXT,
        kind TEXT NOT NULL, author TEXT NOT NULL, text TEXT NOT NULL,
        outcome TEXT, decision TEXT, via TEXT NOT NULL, created_at TEXT NOT NULL)""",
    "CREATE INDEX IF NOT EXISTS entries_node ON entries(node_id, created_at)",
    """CREATE TRIGGER IF NOT EXISTS entries_append_only_update BEFORE UPDATE ON entries
        BEGIN SELECT RAISE(ABORT, 'Journal entries are append-only'); END""",
    """CREATE TRIGGER IF NOT EXISTS entries_append_only_delete BEFORE DELETE ON entries
        BEGIN SELECT RAISE(ABORT, 'Journal entries are append-only'); END""",
)

LABELS = {"proposal": "提议", "decision": "决定", "intent": "为什么", "expectation": "预期",
          "reaction": "结果反应", "note": "随记"}
AUTHOR_LABELS = {"human": "研究者原话", "agent": "Agent"}
OUTCOME_LABELS = {"expected": "符合预期", "surprised": "与预期不符", "mixed": "混合或说不清"}
DECISION_LABELS = {"approved": "批准", "declined": "暂不做"}


def choice(value, allowed, label):
    if value not in allowed:
        raise ValueError(f"{label} must be one of: {', '.join(sorted(allowed))}")
    return value


def build_entry(*, node_id, kind, author, text="", run_id=None, outcome=None, decision=None, via="cli"):
    """Validate one entry. Text is kept as written apart from surrounding whitespace."""
    choice(kind, ENTRY_KINDS, "kind")
    choice(author, AUTHORS, "author")
    choice(via, SOURCES, "via")
    optional_text = kind == "reaction" or (kind == "decision" and decision == "declined")
    text = text_field(text, "text", TEXT_LIMIT, required=not optional_text)
    if kind == "reaction":
        choice(outcome, OUTCOMES, "outcome")
    elif outcome is not None:
        raise ValueError("Only reactions record an outcome")
    if kind in {"decision", "reaction"} and author != "human":
        raise ValueError("Only the researcher decides on proposals and reacts to results; agents write notes")
    if kind == "decision":
        choice(decision, DECISIONS, "decision")
    elif decision is not None:
        raise ValueError("Only decisions record approved or declined")
    if kind == "proposal" and author != "agent":
        raise ValueError("Proposals are written by an agent")
    if run_id is not None:
        run_id = text_field(run_id, "run_id", 200, True)
    return dict(id="j-" + uuid.uuid4().hex[:12], node_id=text_field(node_id, "node_id", 200, True), run_id=run_id,
                kind=kind, author=author, text=text, outcome=outcome, decision=decision, via=via, created_at=now())


def insert_entry(db, entry):
    db.execute("""INSERT INTO entries(id,node_id,run_id,kind,author,text,outcome,decision,via,created_at)
        VALUES(:id,:node_id,:run_id,:kind,:author,:text,:outcome,:decision,:via,:created_at)""", entry)
    return entry


def journal_lines(entries):
    """Readable quotation of entries for agent context, labelled by author and time."""
    lines = []
    for e in entries:
        detail = OUTCOME_LABELS.get(e["outcome"]) or DECISION_LABELS.get(e["decision"]) or ""
        heading = " · ".join(filter(None, [e["created_at"][:16].replace("T", " "), AUTHOR_LABELS[e["author"]],
                                           LABELS[e["kind"]], detail, e["run_id"]]))
        lines.append(f"[{e['node_id']}] {heading}：{e['text'] or '（未写文字）'}")
    return lines


def frontier(state, canvas_id=None):
    """What waits on the researcher: decisions, reactions, running work, surprises and plans."""
    nodes = {n["id"]: n for n in state["nodes"] if canvas_id is None or n["canvas_id"] == canvas_id}
    entries = [e for e in state.get("entries", []) if e["node_id"] in nodes]
    proposed = {e["node_id"]: e["text"] for e in entries if e["kind"] == "proposal"}
    decided = {e["node_id"] for e in entries if e["kind"] == "decision"}
    reacted = {e["run_id"] for e in entries if e["kind"] == "reaction" and e["run_id"]}
    # An outcome given for the whole experiment answers every run that had finished by then.
    judged = {}
    for e in entries:
        if e["kind"] == "reaction" and not e["run_id"]:
            judged[e["node_id"]] = max(judged.get(e["node_id"], ""), e["created_at"])

    def node_item(node, **extra):
        return dict(node_id=node["id"], title=node["title"], canvas_id=node["canvas_id"], **extra)

    def run_item(run):
        node = nodes[run["experiment_id"]]
        return node_item(node, run_id=run["id"], status=run["status"], finished_at=run.get("finished_at"))

    pending = [n for n in nodes.values() if n["status"] == "proposed"]
    runs = [r for r in state["runs"] if r["experiment_id"] in nodes]
    finished = [r for r in runs if r["status"] not in UNFINISHED_RUNS and r.get("origin") != "imported" and r["id"] not in reacted
                and (r["experiment_id"] not in judged or (r.get("finished_at") or "") > judged[r["experiment_id"]])]
    surprises = sorted((e for e in entries if e["kind"] == "reaction" and e["outcome"] == "surprised"),
                       key=lambda e: e["created_at"], reverse=True)[:5]
    return {
        "awaiting_decision": [node_item(n, rationale=proposed[n["id"]]) for n in pending
                              if n["id"] in proposed and n["id"] not in decided],
        "awaiting_reaction": [run_item(r) for r in sorted(finished, key=lambda r: r.get("finished_at") or "", reverse=True)],
        "running": [run_item(r) for r in runs if r["status"] in UNFINISHED_RUNS],
        "recent_surprises": [node_item(nodes[e["node_id"]], entry_id=e["id"], run_id=e["run_id"], text=e["text"],
                                       created_at=e["created_at"]) for e in surprises],
        "planned": [node_item(n) for n in pending if n["kind"] in {"experiment", "next"}
                    and n["id"] not in proposed and n["id"] not in decided],
    }
