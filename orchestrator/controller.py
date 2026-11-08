"""Scheduler. DRY-RUN ONLY: plans and records commands, simulates outcomes, executes nothing."""

from __future__ import annotations

import hashlib
import json
import shlex
import sqlite3
from pathlib import Path

from . import agents, db, recovery, worktree
from .spec import TaskSpec
from .states import DEP_SATISFIED, IN_FLIGHT, Status

S = Status
CONTROLLER = "controller"
MAX_CONCURRENCY = 2


class LiveExecutionDisabled(RuntimeError):
    pass


class Controller:
    live_capable = False  # only orchestrator.live.LiveController sets this

    def __init__(self, conn: sqlite3.Connection, repo: str | Path, *, dry_run: bool = True,
                 concurrency: int = MAX_CONCURRENCY):
        if not dry_run and not self.live_capable:
            raise LiveExecutionDisabled(
                "Live execution is not implemented in this prototype and requires owner approval "
                "(see docs/TASKS.md P1-7).")
        if not 1 <= concurrency <= MAX_CONCURRENCY:
            raise ValueError(f"concurrency must be 1..{MAX_CONCURRENCY}")
        self.conn, self.repo, self.dry_run, self.concurrency = conn, Path(repo), dry_run, concurrency

    # -- lifecycle -----------------------------------------------------------------
    def load(self, specs: list[TaskSpec]) -> int:
        return sum(db.upsert_spec(self.conn, s) for s in specs)

    def recover(self) -> list[tuple[str, str, str]]:
        moved = recovery.recover_orphans(self.conn)
        db.log_event(self.conn, None, "startup_recovery", CONTROLLER, {"moved": moved})
        return moved

    def _spec(self, row) -> TaskSpec:
        return TaskSpec.from_dict(json.loads(row["spec_json"]))

    # -- scheduling ------------------------------------------------------------------
    def promote_ready(self) -> list[str]:
        promoted = []
        for row in db.tasks_in(self.conn, S.QUEUED):
            deps = self.conn.execute(
                "SELECT t.status FROM deps d JOIN tasks t ON t.id = d.depends_on WHERE d.task_id = ?",
                (row["id"],)).fetchall()
            if all(Status(d["status"]) in DEP_SATISFIED for d in deps):
                db.transition(self.conn, row["id"], S.READY, actor=CONTROLLER, expect=S.QUEUED)
                promoted.append(row["id"])
        return promoted

    def _busy_agents(self) -> set[str]:
        busy = {r["owner"] for r in db.tasks_in(self.conn, S.RUNNING, S.IMPLEMENTED)}
        busy |= {r["reviewer"] for r in db.tasks_in(self.conn, S.REVIEW)}
        return busy

    def tick(self) -> list[str]:
        """Advance every in-flight task by exactly one step, then dispatch new work."""
        log: list[str] = []
        log += [f"{t}: queued -> ready" for t in self.promote_ready()]

        snapshot = db.tasks_in(self.conn, S.REVIEW, S.TESTING, S.IMPLEMENTED, S.RUNNING, S.REPAIR)
        for row in snapshot:
            line = self._advance(row)
            if line:
                log.append(line)

        busy = self._busy_agents()
        active = len(db.tasks_in(self.conn, *IN_FLIGHT))
        for row in db.tasks_in(self.conn, S.READY):
            if active >= self.concurrency:
                break
            if row["owner"] in busy:
                continue
            line = self._dispatch(row)
            if line:
                log.append(line)
            busy.add(row["owner"])
            active += 1
        return log

    # -- steps (simulated) -------------------------------------------------------------
    def _dispatch(self, row) -> str:
        spec, attempt, seq = self._spec(row), row["attempts"] + 1, row["dispatches"] + 1
        wt = worktree.implement_worktree(self.repo, spec.id, spec.owner, seq)
        for cmd in wt.commands:
            db.record_run(self.conn, spec.id, attempt, "worktree", None, list(cmd), str(self.repo), True)
        inv = agents.build(spec.owner, "implement", prompt=agents.implement_prompt(spec),
                           cwd=wt.path, out_dir=str(self.repo / "logs" / spec.id))
        db.record_run(self.conn, spec.id, attempt, "implement", spec.owner, list(inv.argv), inv.cwd, True)
        db.transition(self.conn, spec.id, S.RUNNING, actor=CONTROLLER, expect=S.READY, attempts_delta=1,
                      dispatched=True, branch=wt.branch, worktree=wt.path,
                      detail={"attempt": attempt, "dispatch": seq, "worktree": wt.path, "branch": wt.branch,
                              "dry_run": True})
        return f"{spec.id}: ready -> running ({spec.owner}, attempt {attempt}, {wt.branch})"

    def _advance(self, row) -> str:
        spec, st, attempt = self._spec(row), Status(row["status"]), row["attempts"]
        tid = spec.id
        if st is S.RUNNING:
            sha = "dry" + hashlib.sha1(f"{tid}-d{row['dispatches']}".encode()).hexdigest()[:12]
            db.transition(self.conn, tid, S.IMPLEMENTED, actor=CONTROLLER, expect=st, commit_sha=sha,
                          detail={"simulated": True})
            return f"{tid}: running -> implemented (commit {sha})"
        if st is S.IMPLEMENTED:
            for cmd in spec.acceptance:
                db.record_run(self.conn, tid, attempt, "test", None, shlex.split(cmd), "<worktree>", True)
            db.transition(self.conn, tid, S.TESTING, actor=CONTROLLER, expect=st)
            return f"{tid}: implemented -> testing ({len(spec.acceptance)} acceptance cmd(s), run by controller)"
        if st is S.TESTING:
            if attempt <= spec.simulate_test_failures:
                db.transition(self.conn, tid, S.REPAIR, actor=CONTROLLER, expect=st,
                              detail={"reason": "acceptance failed (simulated)"})
                return f"{tid}: testing -> repair (simulated test failure)"
            rv = worktree.review_worktree(self.repo, tid, spec.reviewer, row["commit_sha"])
            inv = agents.build(spec.reviewer, "review", prompt=agents.review_prompt(spec, row["commit_sha"]),
                               cwd=rv.path, out_dir=str(self.repo / "logs" / tid))
            for cmd in rv.commands:
                db.record_run(self.conn, tid, attempt, "worktree", None, list(cmd), str(self.repo), True)
            db.record_run(self.conn, tid, attempt, "review", spec.reviewer, list(inv.argv), inv.cwd, True)
            db.transition(self.conn, tid, S.REVIEW, actor=CONTROLLER, expect=st)
            return f"{tid}: testing -> review (reviewer {spec.reviewer} @ {row['commit_sha']})"
        if st is S.REVIEW:
            db.transition(self.conn, tid, S.AWAITING_APPROVAL, actor=CONTROLLER, expect=st,
                          detail={"verdict": "approve", "findings": [], "simulated": True})
            return f"{tid}: review -> awaiting_approval  ⛔ needs `approve {tid}`"
        if st is S.REPAIR:
            to = S.READY if attempt < row["max_attempts"] else S.BLOCKED
            db.transition(self.conn, tid, to, actor=CONTROLLER, expect=st,
                          detail={"attempts": attempt, "max_attempts": row["max_attempts"]})
            return f"{tid}: repair -> {to} (attempt {attempt}/{row['max_attempts']})"
        raise AssertionError(st)

    # -- human actions -----------------------------------------------------------------
    def approve(self, task_id: str, approver: str, gate: Status = S.MERGED) -> str:
        """Human gate. Records an approval bound to the current commit, then applies it."""
        db.record_approval(self.conn, task_id, gate, approver)
        row = db.get_task(self.conn, task_id)
        if gate is S.MERGED:
            db.record_run(self.conn, task_id, row["attempts"], "merge", None,
                          list(worktree.merge_command(self.repo, row["branch"])), str(self.repo), True)
        db.transition(self.conn, task_id, gate, actor=approver, detail={"dry_run": True})
        return f"{task_id}: -> {gate} (approved by {approver}; dry-run, nothing merged)"

    def reject(self, task_id: str, actor: str, feedback: str) -> str:
        """Human sends work at the approval gate back for another attempt, with feedback for the agent."""
        from .states import is_human
        if not is_human(actor):
            raise db.GateError("only a human may reject at the approval gate")
        db.transition(self.conn, task_id, S.REPAIR, actor=actor, expect=S.AWAITING_APPROVAL,
                      detail={"reason": "changes requested by human at approval gate", "feedback": feedback})
        return f"{task_id}: awaiting_approval -> repair (rejected by {actor})"

    def accept(self, task_id: str, actor: str, reason: str) -> str:
        """Human takes a blocked task's latest commit to the approval gate as-is (merging still needs `approve`).

        Allowed only when that exact commit passed the controller-run acceptance tests, i.e. the task reached
        review after its most recent implementation. Work that failed its tests can only be retried (unblock).
        """
        row = db.get_task(self.conn, task_id)
        last = lambda where: self.conn.execute(  # noqa: E731
            f"SELECT COALESCE(MAX(id), 0) FROM events WHERE task_id = ? AND {where}", (task_id,)).fetchone()[0]
        implemented = last("to_status = 'implemented'")
        tested = last("from_status = 'testing' AND to_status = 'review'")
        if not row["commit_sha"] or not implemented or tested < implemented:
            raise db.GateError(f"{task_id}: its latest commit did not pass the acceptance tests; use unblock to retry")
        db.transition(self.conn, task_id, S.AWAITING_APPROVAL, actor=actor, expect=S.BLOCKED,
                      detail={"reason": reason, "accepted_commit": row["commit_sha"]})
        return f"{task_id}: blocked -> awaiting_approval at {row['commit_sha'][:10]} (accepted by {actor}; approve to merge)"

    def unblock(self, task_id: str, actor: str, reason: str) -> str:
        db.transition(self.conn, task_id, S.READY, actor=actor, expect=S.BLOCKED, detail={"reason": reason})
        return f"{task_id}: blocked -> ready (by {actor})"
