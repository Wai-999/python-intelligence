"""Live controller: really runs the agent CLIs in isolated worktrees.

Enabled by the owner on 2026-11-08 ("I allow everything for building this"). Guarantees kept:
agents never commit; the controller stages, scope-checks, secret-scans and commits; the controller
runs acceptance tests itself; review is by the other agent on an immutable SHA; merging still needs a
recorded human approval; release (deploy) is not implemented here.
"""

from __future__ import annotations

import json
import re
import shlex
import sys
from pathlib import Path

from . import agents, db, gitops, recovery, runner, worktree
from .controller import CONTROLLER, Controller
from .review import ReviewParseError, parse_claude, parse_codex
from .redact import _PATTERNS
from .spec import check_scope
from .states import Status

S = Status
_SAFE_EXTRA_TOOL = re.compile(r"^Bash\([A-Za-z0-9 ._/\-]+:\*\)$")


class LiveController(Controller):
    live_capable = True

    def __init__(self, conn, repo, *, concurrency: int = 2, implement_timeout_s: float = 1800,
                 review_timeout_s: float = 900, test_timeout_s: float = 900, codex_home: str | None = None):
        super().__init__(conn, repo, dry_run=False, concurrency=concurrency)
        self.handles: dict[str, tuple[runner.Handle, int, str, Path | None]] = {}
        self.t_impl, self.t_review, self.t_test = implement_timeout_s, review_timeout_s, test_timeout_s
        self.codex_home = codex_home or agents.ensure_codex_home(self.repo / ".orchestrator" / "codex-home")
        # Worktrees see node_modules and .venv312 through symlinks into the main checkout. Writes through them
        # (by an agent, or by agent-written code run as an acceptance test) would silently change what every later
        # task is built and validated with, so any change blocks the task for a human.
        self.shared_baseline = gitops.shared_fingerprints(self.repo)

    # -- startup ---------------------------------------------------------------------
    def recover(self):
        for run in db.unfinished_live_runs(self.conn):  # children survive a controller crash (own pgid)
            if run["pgid"]:
                runner.kill_group(run["pgid"])
            db.finish_run(self.conn, run["id"], -1)
        return super().recover()

    # -- helpers -------------------------------------------------------------------------
    def _logs(self, tid: str) -> Path:
        d = self.repo / "logs" / tid
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _shared_tampered(self) -> list[str]:
        now = gitops.shared_fingerprints(self.repo)
        return [name for name, fp in now.items() if fp != self.shared_baseline.get(name)]

    def _block_if_shared_tampered(self, tid, frm, stage: str) -> str | None:
        changed = self._shared_tampered()
        if not changed:
            return None
        db.transition(self.conn, tid, S.BLOCKED, actor=CONTROLLER, expect=frm,
                      detail={"reason": f"shared dependency dir(s) {changed} changed during {stage}; inspect and "
                                        "reinstall them, then restart the controller before unblocking"})
        return f"{tid}: {frm} -> blocked (shared {changed} modified during {stage})"

    def _repair(self, tid, frm, reason: str, **detail) -> str:
        db.transition(self.conn, tid, S.REPAIR, actor=CONTROLLER, expect=frm, detail={"reason": reason, **detail})
        return f"{tid}: {frm} -> repair ({reason.splitlines()[0][:120]})"

    def _extra_tools(self, spec) -> tuple[str, ...]:
        tools = tuple(spec.extra.get("allowed_tools", ()))
        bad = [t for t in tools if not _SAFE_EXTRA_TOOL.match(t)]
        if bad:
            raise agents.UnsafeCommandError(f"{spec.id}: extra tools must look like 'Bash(cmd:*)': {bad}")
        return tools

    def _finish(self, tid) -> tuple[int | None, bool, runner.Handle, int, Path | None]:
        h, run_id, role, out = self.handles[tid]
        if h.timed_out():
            runner.kill_group(h.pid)
            h.proc.wait()
            code, to = h.proc.returncode, True
        else:
            code, to = h.poll(), False
        if code is None:
            return None, False, h, run_id, out
        h.log_path.write_text(runner.read_log(h.log_path))  # persist redacted form only
        db.finish_run(self.conn, run_id, code)
        del self.handles[tid]
        return code, to, h, run_id, out

    # -- steps ---------------------------------------------------------------------------
    def _dispatch(self, row) -> str:
        spec, attempt, seq = self._spec(row), row["attempts"] + 1, row["dispatches"] + 1
        base = row["commit_sha"] if row["commit_sha"] and row["branch"] and \
            gitops.branch_exists(self.repo, row["branch"]) else "main"
        wt = worktree.implement_worktree(self.repo, spec.id, spec.owner, seq)
        gitops.add_worktree(self.repo, wt.path, wt.branch, base)
        feedback = db.last_repair_feedback(self.conn, spec.id) if attempt > 1 else None
        inv = agents.build(spec.owner, "implement", prompt=agents.implement_prompt(spec, feedback), cwd=wt.path,
                           out_dir=str(self._logs(spec.id)), codex_home=self.codex_home,
                           extra_tools=self._extra_tools(spec))
        log = self._logs(spec.id) / f"d{seq}-implement-{spec.owner}.log"
        h = runner.start(inv.argv, cwd=wt.path, log_path=log, timeout_s=self.t_impl,
                         env=runner.scrubbed_env(dict(inv.env)))
        run_id = db.record_run(self.conn, spec.id, attempt, "implement", spec.owner, list(inv.argv), wt.path,
                               False, pgid=h.pid, log_path=str(log))
        self.handles[spec.id] = (h, run_id, "implement", None)
        db.transition(self.conn, spec.id, S.RUNNING, actor=CONTROLLER, expect=S.READY, attempts_delta=1,
                      dispatched=True, branch=wt.branch, worktree=wt.path,
                      detail={"attempt": attempt, "dispatch": seq, "base": base, "pid": h.pid, "retry": bool(feedback)})
        return f"{spec.id}: ready -> running ({spec.owner}, attempt {attempt}, {wt.branch} from {base[:12]})"

    def _advance(self, row) -> str | None:
        spec, st, tid = self._spec(row), Status(row["status"]), row["id"]
        if st in (S.RUNNING, S.REVIEW) and tid not in self.handles:
            return self._repair(tid, st, "process handle lost (controller restarted without recovery)")
        if st is S.RUNNING:
            return self._after_implement(row, spec)
        if st is S.IMPLEMENTED:
            return self._test_then_review(row, spec)
        if st is S.REVIEW:
            return self._after_review(row, spec)
        if st is S.REPAIR:
            line = super()._advance(row)
            if db.get_task(self.conn, tid)["status"] == S.READY and row["worktree"]:
                gitops.remove_worktree(self.repo, row["worktree"])  # branch kept; commit (if any) is next base
            return line
        if st is S.TESTING:  # only reachable via a crash mid-test; recovery normally handles it
            return self._repair(tid, st, "interrupted during tests")
        raise AssertionError(st)

    def _after_implement(self, row, spec) -> str | None:
        tid, wt = row["id"], row["worktree"]
        code, timed_out, h, _, _ = self._finish(tid)
        if code is None:
            return None
        full = runner.read_log(h.log_path)
        report = full[-4000:]
        # Before ANY other outcome handling: a failing or timed-out agent may still have written through the links.
        if (blocked := self._block_if_shared_tampered(tid, S.RUNNING, "implementation")):
            return blocked
        if timed_out:
            return self._repair(tid, S.RUNNING, f"implementer timed out after {self.t_impl:.0f}s", log_tail=report[-1500:])
        if code != 0:
            return self._repair(tid, S.RUNNING, f"implementer exited {code}", log_tail=report[-1500:])
        denials = []
        if spec.owner == "claude":
            try:
                env, _ = json.JSONDecoder().raw_decode(full[full.index("{"):]) if "{" in full else ({}, 0)
                denials = [d.get("tool_input", {}).get("command") or d.get("tool_name")
                           for d in env.get("permission_denials", [])]
                if env.get("is_error"):
                    return self._repair(tid, S.RUNNING, f"claude reported error: {str(env.get('result'))[:500]}")
            except ValueError:
                pass
        changed = gitops.stage_all(wt)
        if not changed:
            gitops.unstage_all(wt)
            return self._repair(tid, S.RUNNING, "implementer produced no changes", agent_report=report[-1500:])
        bad = check_scope(changed, spec.allowed_paths)
        if bad:
            gitops.unstage_all(wt)
            return self._repair(tid, S.RUNNING, f"out-of-scope changes: {bad}. Allowed: {list(spec.allowed_paths)}")
        leaks = [f for f in changed if (Path(wt) / f).is_file() and
                 any(p.search((Path(wt) / f).read_text(errors="ignore")) for p in _PATTERNS[:5])]
        if leaks:
            gitops.unstage_all(wt)
            return self._repair(tid, S.RUNNING, f"credential-shaped strings in {leaks}")
        sha = gitops.commit(wt, spec.owner, f"{tid}: {spec.title}\n\nImplemented by {spec.owner} agent "
                                             f"(dispatch {row['dispatches']}, attempt {row['attempts']}); "
                                             "staged, scope-checked and committed by pi-orchestrator.")
        db.transition(self.conn, tid, S.IMPLEMENTED, actor=CONTROLLER, expect=S.RUNNING, commit_sha=sha,
                      detail={"changed": changed, "permission_denials": denials, "agent_report": report[-2000:]})
        return f"{tid}: running -> implemented ({len(changed)} file(s), commit {sha[:10]})"

    def _test_then_review(self, row, spec) -> str:
        tid, wt = row["id"], row["worktree"]
        db.transition(self.conn, tid, S.TESTING, actor=CONTROLLER, expect=S.IMPLEMENTED)
        logs = self._logs(tid)
        for i, cmd in enumerate(spec.acceptance):
            argv = shlex.split(cmd)
            if argv and argv[0] in ("python", "python3"):
                argv[0] = sys.executable
            log = logs / f"d{row['dispatches']}-test{i}.log"
            res = runner.run(argv, cwd=wt, timeout_s=self.t_test, log_path=log,
                             env=runner.scrubbed_env({"PATH": runner.scrubbed_env()["PATH"]}))
            db.record_run(self.conn, tid, row["attempts"], "test", None, argv, wt, False,
                          log_path=str(log), exit_code=res.code)
            if (blocked := self._block_if_shared_tampered(tid, S.TESTING, f"acceptance `{cmd}`")):
                return blocked
            if res.code != 0 or res.timed_out:
                return self._repair(tid, S.TESTING, f"acceptance failed: `{cmd}` exit {res.code}"
                                    f"{' (timeout)' if res.timed_out else ''}\n{res.output[-2500:]}",
                                    feedback=f"Acceptance command `{cmd}` failed:\n{res.output[-2500:]}")
        # Tests passed -> independent review on a detached checkout of the exact commit.
        sha = row["commit_sha"]
        rv = worktree.review_worktree(self.repo, tid, spec.reviewer, sha)
        gitops.add_review_worktree(self.repo, rv.path, sha)
        (Path(rv.path) / "REVIEW_DIFF.patch").write_text(gitops.diff_patch(self.repo, "main", sha))
        (logs / "findings.schema.json").write_text(json.dumps(agents.FINDINGS_SCHEMA, indent=2))
        inv = agents.build(spec.reviewer, "review", prompt=agents.review_prompt(spec, sha), cwd=rv.path,
                           out_dir=str(logs), codex_home=self.codex_home)
        out_file = logs / "codex-review-last.txt"
        out_file.unlink(missing_ok=True)
        log = logs / f"d{row['dispatches']}-review-{spec.reviewer}.log"
        h = runner.start(inv.argv, cwd=rv.path, log_path=log, timeout_s=self.t_review,
                         env=runner.scrubbed_env(dict(inv.env)))
        run_id = db.record_run(self.conn, tid, row["attempts"], "review", spec.reviewer, list(inv.argv), rv.path,
                               False, pgid=h.pid, log_path=str(log))
        self.handles[tid] = (h, run_id, "review", out_file if spec.reviewer == "codex" else None)
        db.transition(self.conn, tid, S.REVIEW, actor=CONTROLLER, expect=S.TESTING,
                      detail={"acceptance": list(spec.acceptance), "review_worktree": rv.path})
        return f"{tid}: implemented -> testing ✓ -> review ({spec.reviewer} @ {sha[:10]})"

    def _after_review(self, row, spec) -> str | None:
        tid = row["id"]
        code, timed_out, h, _, out_file = self._finish(tid)
        if code is None:
            return None
        rv_path = worktree.review_worktree(self.repo, tid, spec.reviewer, row["commit_sha"]).path
        gitops.remove_worktree(self.repo, rv_path)
        if (blocked := self._block_if_shared_tampered(tid, S.REVIEW, "review")):
            return blocked
        if timed_out or code != 0:
            return self._repair(tid, S.REVIEW, f"reviewer {'timed out' if timed_out else f'exited {code}'}",
                                log_tail=runner.read_log(h.log_path, tail=1500))
        try:
            rev = parse_codex(out_file) if out_file else parse_claude(runner.read_log(h.log_path))
        except (ReviewParseError, ValueError) as e:
            return self._repair(tid, S.REVIEW, f"unparseable review: {e}")
        findings = list(rev.findings)
        if rev.needs_repair:
            return self._repair(tid, S.REVIEW, f"review requested changes ({len(rev.blocking)} blocking)",
                                feedback=rev.feedback(), verdict=rev.verdict, findings=findings)
        db.transition(self.conn, tid, S.AWAITING_APPROVAL, actor=CONTROLLER, expect=S.REVIEW,
                      detail={"verdict": rev.verdict, "findings": findings, "reviewer": spec.reviewer})
        note = "" if rev.verdict == "approve" else "; reviewer requested changes, none blocking: human decides"
        return f"{tid}: review -> awaiting_approval ({len(findings)} non-blocking finding(s){note})  ⛔ needs approve"

    # -- human actions -----------------------------------------------------------------
    def approve(self, task_id: str, approver: str, gate: Status = S.MERGED) -> str:
        if gate is not S.MERGED:
            raise db.GateError("release/deploy is not implemented in the local orchestrator (Phase 5)")
        db.record_approval(self.conn, task_id, gate, approver)
        row = db.get_task(self.conn, task_id)
        try:
            merged = gitops.merge(self.repo, row["branch"],
                                  f"Merge {task_id}: {row['title']}\n\nApproved by {approver} at {row['commit_sha']}; "
                                  f"implemented by {row['owner']}, reviewed by {row['reviewer']}.")
        except gitops.GitError as e:
            db.log_event(self.conn, task_id, "merge_failed", approver, {"error": str(e)})
            raise
        db.transition(self.conn, task_id, S.MERGED, actor=approver, detail={"merge_commit": merged})
        gitops.remove_worktree(self.repo, row["worktree"])
        return f"{task_id}: -> merged into main ({merged[:10]}), approved by {approver}"

    def run(self, max_minutes: float = 120, poll_s: float = 5.0, echo=print) -> None:
        """Tick until nothing can progress without a human (or time runs out)."""
        import time
        end = time.monotonic() + max_minutes * 60
        while time.monotonic() < end:
            for line in self.tick():
                echo(line)
            busy = db.tasks_in(self.conn, S.READY, S.RUNNING, S.IMPLEMENTED, S.TESTING, S.REVIEW, S.REPAIR)
            if not busy and not self.promote_ready():
                return
            time.sleep(poll_s)
        self.shutdown()
        echo("run: time limit reached; in-flight work was stopped and will be recovered on next start")

    def shutdown(self) -> None:
        """Kill in-flight workers so no unsupervised agent outlives the controller."""
        for tid in list(self.handles):
            h, run_id, _, _ = self.handles.pop(tid)
            runner.kill_group(h.pid)
            db.finish_run(self.conn, run_id, -15)
