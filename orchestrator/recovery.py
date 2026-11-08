"""Startup crash recovery.

The controller is single-instance, so at startup no worker subprocess can still be alive.
Any task whose status is RUNNING, TESTING or REVIEW was interrupted mid-step
(controller crash, laptop sleep, Ctrl-C). This module decides where each one goes.

Allowed moves out of those states (see states.TRANSITIONS):
    RUNNING -> REPAIR | BLOCKED        (IMPLEMENTED would claim work we never saw finish)
    TESTING -> REPAIR | BLOCKED        (REVIEW would skip a test run that never completed)
    REVIEW  -> REPAIR | BLOCKED        (AWAITING_APPROVAL would skip an unfinished review)
REPAIR is later turned into READY by tick() if attempts < max_attempts, else BLOCKED.
`row["attempts"]` was already incremented when the attempt was dispatched.
"""

from __future__ import annotations

import json
import sqlite3

from . import db
from .states import Status

RECOVERY_ACTOR = "controller:recovery"


def recover_orphans(conn: sqlite3.Connection) -> list[tuple[str, str, str]]:
    """Move every orphaned task to a safe state. Returns [(task_id, from, to), ...]."""
    recovered: list[tuple[str, str, str]] = []
    for row in db.orphaned_tasks(conn):
        frm = Status(row["status"])
        spec = json.loads(row["spec_json"])  # has "risk": "low" | "medium" | "high"

        prior_crashes = conn.execute(
            "SELECT COUNT(*) FROM events WHERE task_id = ? AND actor = ?", (row["id"], RECOVERY_ACTOR)
        ).fetchone()[0]
        if spec.get("risk") == "high":
            # A half-edited worktree of a high-risk task gets human eyes before any retry.
            to, delta, why = Status.BLOCKED, 0, "high-risk task interrupted; inspect worktree before retry"
        elif prior_crashes == 0:
            # First interruption is presumed environmental (sleep, Ctrl-C): refund the attempt.
            to, delta, why = Status.REPAIR, -1, "first interruption; attempt refunded"
        else:
            # Repeated interruption may be caused by the task itself: stop refunding, so the
            # retry cap still terminates a task that keeps killing the controller.
            to, delta, why = Status.REPAIR, 0, f"interrupted again ({prior_crashes} prior); attempt counted"
        db.transition(conn, row["id"], to, actor=RECOVERY_ACTOR, expect=frm, attempts_delta=delta,
                      detail={"reason": why, "interrupted_in": str(frm), "prior_crashes": prior_crashes})
        recovered.append((row["id"], str(frm), str(to)))

    return recovered
