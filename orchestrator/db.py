"""SQLite state. `transition()` is the ONLY function that changes a task's status."""

from __future__ import annotations

import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

from .redact import redact_obj
from .spec import TaskSpec
from .states import HUMAN_EXIT_ONLY, HUMAN_GATED, ORPHANABLE, TRANSITIONS, Status, is_human

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id           TEXT PRIMARY KEY,
    title        TEXT NOT NULL,
    owner        TEXT NOT NULL,
    reviewer     TEXT NOT NULL,
    spec_json    TEXT NOT NULL,
    status       TEXT NOT NULL,
    attempts     INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL,
    commit_sha   TEXT,
    branch       TEXT,
    worktree     TEXT,
    dispatches   INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS deps (
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    depends_on TEXT NOT NULL REFERENCES tasks(id),
    PRIMARY KEY (task_id, depends_on)
);
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ts          TEXT NOT NULL,
    task_id     TEXT,
    kind        TEXT NOT NULL,
    from_status TEXT,
    to_status   TEXT,
    actor       TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS approvals (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         TEXT NOT NULL,
    task_id    TEXT NOT NULL REFERENCES tasks(id),
    gate       TEXT NOT NULL,
    commit_sha TEXT NOT NULL,
    approver   TEXT NOT NULL,
    consumed   INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id     TEXT NOT NULL REFERENCES tasks(id),
    attempt     INTEGER NOT NULL,
    role        TEXT NOT NULL,
    agent       TEXT,
    argv_json   TEXT NOT NULL,
    cwd         TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    exit_code   INTEGER,
    dry_run     INTEGER NOT NULL,
    pgid        INTEGER,
    log_path    TEXT
);
"""


class TransitionError(RuntimeError):
    pass


class GateError(TransitionError):
    """A human gate was not satisfied."""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def connect(path: str | Path) -> sqlite3.Connection:
    if str(path) != ":memory:":
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    # isolation_level=None: we manage transactions explicitly with BEGIN IMMEDIATE.
    conn = sqlite3.connect(str(path), isolation_level=None)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


@contextmanager
def tx(conn: sqlite3.Connection) -> Iterator[sqlite3.Connection]:
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def _event(conn, task_id, kind, actor, frm=None, to=None, detail=None) -> None:
    conn.execute(
        "INSERT INTO events (ts, task_id, kind, from_status, to_status, actor, detail_json) VALUES (?,?,?,?,?,?,?)",
        (now(), task_id, kind, frm, to, actor, json.dumps(redact_obj(detail or {}), sort_keys=True)),
    )


def log_event(conn, task_id: str | None, kind: str, actor: str, detail: dict | None = None) -> None:
    with tx(conn):
        _event(conn, task_id, kind, actor, detail=detail)


def upsert_spec(conn, spec: TaskSpec, actor: str = "controller") -> bool:
    """Insert a new task as queued. Existing tasks keep their state; returns True if inserted."""
    with tx(conn):
        exists = conn.execute("SELECT 1 FROM tasks WHERE id = ?", (spec.id,)).fetchone()
        if exists:
            conn.execute("UPDATE tasks SET spec_json = ?, title = ? WHERE id = ?",
                         (json.dumps(spec.to_dict()), spec.title, spec.id))
            return False
        conn.execute(
            "INSERT INTO tasks (id, title, owner, reviewer, spec_json, status, max_attempts, updated_at)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (spec.id, spec.title, spec.owner, spec.reviewer, json.dumps(spec.to_dict()),
             Status.QUEUED, spec.max_attempts, now()),
        )
        for d in spec.depends_on:
            conn.execute("INSERT OR IGNORE INTO deps (task_id, depends_on) VALUES (?,?)", (spec.id, d))
        _event(conn, spec.id, "created", actor, to=Status.QUEUED)
        return True


def get_task(conn, task_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    if row is None:
        raise KeyError(task_id)
    return row


def tasks_in(conn, *statuses: Status) -> list[sqlite3.Row]:
    q = "SELECT * FROM tasks WHERE status IN (%s) ORDER BY id" % ",".join("?" * len(statuses))
    return conn.execute(q, [str(s) for s in statuses]).fetchall()


def orphaned_tasks(conn) -> list[sqlite3.Row]:
    """Tasks whose status says a subprocess is running. At startup nothing is running."""
    return tasks_in(conn, *ORPHANABLE)


def record_approval(conn, task_id: str, gate: Status, approver: str) -> int:
    if not is_human(approver):
        raise GateError(f"approver must be human:<name>, got {approver!r}")
    if gate not in HUMAN_GATED:
        raise GateError(f"{gate} is not a human-gated state")
    # An approval may only be recorded AT the gate; no pre-approving work still in review.
    required = {Status.MERGED: Status.AWAITING_APPROVAL, Status.RELEASED: Status.MERGED}[gate]
    with tx(conn):
        row = get_task(conn, task_id)
        if Status(row["status"]) != required:
            raise GateError(f"{task_id}: can only approve {gate} while {required}, task is {row['status']}")
        if not row["commit_sha"]:
            raise GateError(f"{task_id} has no commit to approve")
        cur = conn.execute(
            "INSERT INTO approvals (ts, task_id, gate, commit_sha, approver) VALUES (?,?,?,?,?)",
            (now(), task_id, str(gate), row["commit_sha"], approver),
        )
        _event(conn, task_id, "approval", approver, detail={"gate": str(gate), "commit_sha": row["commit_sha"]})
        return cur.lastrowid


def transition(conn, task_id: str, to: Status, *, actor: str, expect: Status | None = None,
               detail: dict | None = None, attempts_delta: int = 0, commit_sha: str | None = None,
               branch: str | None = None, worktree: str | None = None, dispatched: bool = False) -> Status:
    """Atomically move a task to `to`. Raises TransitionError/GateError on any rule violation."""
    to = Status(to)
    with tx(conn):
        row = get_task(conn, task_id)
        frm = Status(row["status"])
        if expect is not None and frm != expect:
            raise TransitionError(f"{task_id}: expected {expect}, found {frm}")
        if to not in TRANSITIONS[frm]:
            raise TransitionError(f"{task_id}: {frm} -> {to} is not allowed")
        if frm in HUMAN_EXIT_ONLY and not is_human(actor):
            raise GateError(f"{task_id}: only a human may move a task out of {frm}")
        if to in HUMAN_GATED:
            if not is_human(actor):
                raise GateError(f"{task_id}: {to} requires a human actor")
            appr = conn.execute(
                "SELECT id FROM approvals WHERE task_id=? AND gate=? AND commit_sha=? AND consumed=0"
                " ORDER BY id LIMIT 1", (task_id, str(to), row["commit_sha"] or "")).fetchone()
            if appr is None:
                raise GateError(f"{task_id}: no unconsumed approval for {to} at commit {row['commit_sha']}")
            conn.execute("UPDATE approvals SET consumed = 1 WHERE id = ?", (appr["id"],))

        cur = conn.execute(
            "UPDATE tasks SET status=?, attempts=attempts+?, commit_sha=COALESCE(?, commit_sha),"
            " branch=COALESCE(?, branch), worktree=COALESCE(?, worktree), dispatches=dispatches+?, updated_at=?"
            " WHERE id=? AND status=?",
            (str(to), attempts_delta, commit_sha, branch, worktree, int(dispatched), now(), task_id, str(frm)),
        )
        if cur.rowcount != 1:  # compare-and-set lost a race
            raise TransitionError(f"{task_id}: concurrent modification")
        _event(conn, task_id, "transition", actor, frm=str(frm), to=str(to), detail=detail)
    return to


def record_run(conn, task_id: str, attempt: int, role: str, agent: str | None, argv: list[str],
               cwd: str, dry_run: bool, *, pgid: int | None = None, log_path: str | None = None,
               exit_code: int | None = None) -> int:
    finished = dry_run or exit_code is not None
    with tx(conn):
        cur = conn.execute(
            "INSERT INTO runs (task_id, attempt, role, agent, argv_json, cwd, started_at, finished_at, exit_code,"
            " dry_run, pgid, log_path) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            (task_id, attempt, role, agent, json.dumps(redact_obj(argv)), cwd, now(),
             now() if finished else None, (0 if dry_run else exit_code), int(dry_run), pgid, log_path),
        )
        return cur.lastrowid


def finish_run(conn, run_id: int, exit_code: int) -> None:
    with tx(conn):
        conn.execute("UPDATE runs SET finished_at = ?, exit_code = ? WHERE id = ?", (now(), exit_code, run_id))


def unfinished_live_runs(conn) -> list[sqlite3.Row]:
    return conn.execute("SELECT * FROM runs WHERE dry_run = 0 AND finished_at IS NULL").fetchall()


def last_repair_feedback(conn, task_id: str) -> str | None:
    row = conn.execute("SELECT detail_json FROM events WHERE task_id = ? AND to_status = 'repair'"
                       " ORDER BY id DESC LIMIT 1", (task_id,)).fetchone()
    if not row:
        return None
    d = json.loads(row["detail_json"])
    return d.get("feedback") or d.get("reason")
