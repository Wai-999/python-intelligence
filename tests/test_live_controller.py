"""Live controller against real git + real subprocesses, with fake agent binaries (no model calls)."""

import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest
from conftest import make_spec

from orchestrator import db, gitops
from orchestrator.live import LiveController
from orchestrator.states import Status as S

FAKE = Path(__file__).parent / "fakes" / "fake_agent.py"


def _git(repo, *a):
    subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True)


@pytest.fixture
def env(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / ".codex").mkdir(parents=True)
    (home / ".codex" / "auth.json").write_text("{}")
    bindir = tmp_path / "bin"
    bindir.mkdir()
    for name in ("claude", "codex"):
        b = bindir / name
        b.write_text(f"#!/bin/sh\nexec {sys.executable} {FAKE} \"$@\"\n".replace(str(FAKE), f"'{FAKE}'"))
        b.chmod(b.stat().st_mode | stat.S_IEXEC)
        # fake reads argv[0] name -> symlink trick: wrapper passes through, so name the script by agent
    # argv[0] inside python is the script path; make per-agent copies so Path(argv[0]).name is the agent.
    for name in ("claude", "codex"):
        copy = bindir / f"{name}.d" / name
        copy.parent.mkdir()
        copy.write_text(FAKE.read_text())
        (bindir / name).write_text(f"#!/bin/sh\nexec '{sys.executable}' '{copy}' \"$@\"\n")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("PI_CLAUDE_BIN", str(bindir / "claude"))
    monkeypatch.setenv("PI_CODEX_BIN", str(bindir / "codex"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-should-never-reach-workers-000000000000")

    repo = tmp_path / "my repo"  # space on purpose
    repo.mkdir()
    _git(repo, "init", "-q", "-b", "main")
    (repo / ".gitignore").write_text("worktrees/\nlogs/\n.orchestrator/\n")
    (repo / "README.md").write_text("x\n")
    _git(repo, "add", ".")
    _git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")

    def plan(p: dict):
        (home / "fake_plan.json").write_text(json.dumps(p))

    def calls():
        return json.loads((home / "fake_plan.json").read_text()).get("calls", [])

    plan({})
    return repo, plan, calls


def drive(ctl, tid, until, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        ctl.tick()
        if db.get_task(ctl.conn, tid)["status"] in until:
            return db.get_task(ctl.conn, tid)["status"]
        time.sleep(0.05)
    raise AssertionError(f"{tid} stuck in {db.get_task(ctl.conn, tid)['status']}")


ACCEPT = (f"python -c \"import pathlib,sys; sys.exit(0 if pathlib.Path('src/feature.py').exists() else 1)\"",)


def mk(repo, *specs, **kw):
    conn = db.connect(repo / ".orchestrator" / "s.sqlite3")
    ctl = LiveController(conn, repo, **kw)
    ctl.load(list(specs))
    return ctl


def test_happy_path_commit_test_review_merge(env):
    repo, plan, calls = env
    ctl = mk(repo, make_spec("T1", owner="codex", reviewer="claude", acceptance=ACCEPT))
    assert drive(ctl, "T1", {S.AWAITING_APPROVAL, S.REPAIR, S.BLOCKED}) == S.AWAITING_APPROVAL
    row = db.get_task(ctl.conn, "T1")
    author = gitops.git(repo, "log", "-1", "--format=%an", row["commit_sha"])
    assert author == "Codex agent"
    assert gitops.git(repo, "rev-parse", "main") != row["commit_sha"]  # not merged yet
    c = calls()
    assert [x["role"] for x in c] == ["implement", "review"] and c[1]["agent"] == "claude"
    assert c[0]["codex_home"].endswith(".orchestrator/codex-home")
    assert not any(x["anthropic_key_leaked"] for x in c)
    ctl.approve("T1", "human:owner")
    assert (repo / "src" / "feature.py").exists()
    assert db.get_task(ctl.conn, "T1")["status"] == S.MERGED
    assert not Path(row["worktree"]).exists()


def test_out_of_scope_write_goes_to_repair_without_commit(env):
    repo, plan, calls = env
    plan({"claude:implement": [{"write": {".github/workflows/x.yml": "on: push\n"}}]})
    ctl = mk(repo, make_spec("T2", acceptance=ACCEPT, max_attempts=1))
    assert drive(ctl, "T2", {S.REPAIR, S.BLOCKED, S.AWAITING_APPROVAL}) == S.REPAIR
    assert db.get_task(ctl.conn, "T2")["commit_sha"] is None
    ctl.tick()
    assert db.get_task(ctl.conn, "T2")["status"] == S.BLOCKED  # max_attempts=1


def test_failing_acceptance_then_feedback_retry(env):
    repo, plan, calls = env
    plan({"claude:implement": [{"write": {"src/other.py": "x = 1\n"}}, {}]})  # 1st misses the file
    ctl = mk(repo, make_spec("T3", acceptance=ACCEPT))
    assert drive(ctl, "T3", {S.AWAITING_APPROVAL, S.BLOCKED}) == S.AWAITING_APPROVAL
    row = db.get_task(ctl.conn, "T3")
    assert row["attempts"] == 2 and row["branch"].endswith("-d2")
    # retry was based on attempt 1's commit, so its file survives
    assert "src/other.py" in gitops.git(repo, "ls-tree", "-r", "--name-only", row["commit_sha"])


def test_blocking_review_findings_trigger_repair(env):
    repo, plan, calls = env
    bad = {"verdict": "request_changes", "findings": [{"severity": "high", "file": "src/feature.py", "line": 1,
           "summary": "returns wrong value", "reproduction": "f() == 1", "proposed_fix": "return 2"}]}
    plan({"codex:review": [{"review": bad}]})
    ctl = mk(repo, make_spec("T4", acceptance=ACCEPT))
    assert drive(ctl, "T4", {S.REPAIR}) == S.REPAIR
    fb = db.last_repair_feedback(ctl.conn, "T4")
    assert "returns wrong value" in fb and "[high]" in fb


def test_request_changes_with_only_medium_findings_goes_to_human(env):
    repo, plan, calls = env
    med = {"verdict": "request_changes", "findings": [{"severity": "medium", "file": "src/feature.py", "line": 1,
           "summary": "edge case", "reproduction": "f(0)", "proposed_fix": "guard 0"}]}
    plan({"codex:review": [{"review": med}]})
    ctl = mk(repo, make_spec("T4b", acceptance=ACCEPT))
    assert drive(ctl, "T4b", {S.AWAITING_APPROVAL, S.REPAIR}) == S.AWAITING_APPROVAL
    ev = ctl.conn.execute("SELECT detail_json FROM events WHERE task_id='T4b' AND to_status='awaiting_approval'").fetchone()
    assert '"request_changes"' in ev[0] and "edge case" in ev[0]   # the human sees verdict and findings


def test_request_changes_without_itemised_findings_repairs(env):
    repo, plan, calls = env
    plan({"codex:review": [{"review": {"verdict": "request_changes", "findings": []}}]})
    ctl = mk(repo, make_spec("T4c", acceptance=ACCEPT))
    assert drive(ctl, "T4c", {S.AWAITING_APPROVAL, S.REPAIR}) == S.REPAIR


def test_implementer_timeout_kills_process(env):
    repo, plan, calls = env
    plan({"claude:implement": [{"do": "sleep", "seconds": 60}]})
    ctl = mk(repo, make_spec("T5", acceptance=ACCEPT), implement_timeout_s=1)
    t0 = time.monotonic()
    assert drive(ctl, "T5", {S.REPAIR}, timeout=15) == S.REPAIR
    assert time.monotonic() - t0 < 10
    assert "timed out" in db.last_repair_feedback(ctl.conn, "T5")


def test_crash_recovery_kills_orphan_worker(env):
    repo, plan, calls = env
    plan({"claude:implement": [{"do": "sleep", "seconds": 60}]})
    ctl = mk(repo, make_spec("T6", acceptance=ACCEPT, risk="low"))
    ctl.tick()
    proc = next(iter(ctl.handles.values()))[0].proc
    ctl.handles.clear()  # simulate controller death (child keeps running in its own group)
    assert proc.poll() is None  # still alive
    ctl2 = LiveController(db.connect(repo / ".orchestrator" / "s.sqlite3"), repo)
    moved = ctl2.recover()
    assert moved == [("T6", "running", "repair")]
    assert proc.wait(timeout=5) < 0  # terminated by a signal from recovery


def test_merge_refused_when_main_dirty(env):
    repo, plan, calls = env
    ctl = mk(repo, make_spec("T7", acceptance=ACCEPT))
    drive(ctl, "T7", {S.AWAITING_APPROVAL})
    (repo / "README.md").write_text("dirty\n")
    with pytest.raises(gitops.GitError, match="uncommitted"):
        ctl.approve("T7", "human:owner")
    assert db.get_task(ctl.conn, "T7")["status"] == S.AWAITING_APPROVAL


def test_release_not_available_live(env):
    repo, plan, calls = env
    ctl = mk(repo, make_spec("T8", acceptance=ACCEPT))
    with pytest.raises(db.GateError, match="not implemented"):
        ctl.approve("T8", "human:owner", S.RELEASED)


def _with_shared_dirs(repo):
    for name in gitops.SHARED_LINKS:
        (repo / name).mkdir(exist_ok=True)
        (repo / name / "pkg.py").write_text("ok = True\n")


def test_agent_writing_through_a_shared_link_blocks_the_task(env):
    repo, plan, calls = env
    _with_shared_dirs(repo)
    plan({"claude:implement": [{"write": {"src/feature.py": "def f():\n    return 2\n", ".venv312/pkg.py": "ok = False\n"}}]})
    ctl = mk(repo, make_spec("T7", acceptance=ACCEPT))
    assert drive(ctl, "T7", {S.BLOCKED, S.AWAITING_APPROVAL, S.REPAIR}) == S.BLOCKED
    ev = ctl.conn.execute("SELECT detail_json FROM events WHERE task_id='T7' AND to_status='blocked'").fetchone()
    assert ".venv312" in ev[0] and "implementation" in ev[0]


def test_acceptance_code_writing_into_node_modules_blocks_the_task(env):
    repo, plan, calls = env
    _with_shared_dirs(repo)
    evil = "python -c \"open('node_modules/pkg.py', 'w').write('hacked = 1')\""
    ctl = mk(repo, make_spec("T8", acceptance=(evil,) + tuple(ACCEPT)))
    assert drive(ctl, "T8", {S.BLOCKED, S.AWAITING_APPROVAL, S.REPAIR}) == S.BLOCKED
    ev = ctl.conn.execute("SELECT detail_json FROM events WHERE task_id='T8' AND to_status='blocked'").fetchone()
    assert "node_modules" in ev[0] and "acceptance" in ev[0]
    assert (repo / "node_modules" / "pkg.py").read_text() == "hacked = 1"  # detected, so a human must restore it


def test_untouched_shared_dirs_do_not_block(env):
    repo, plan, calls = env
    _with_shared_dirs(repo)
    ctl = mk(repo, make_spec("T9", acceptance=ACCEPT))
    assert drive(ctl, "T9", {S.BLOCKED, S.AWAITING_APPROVAL, S.REPAIR}) == S.AWAITING_APPROVAL


def test_failing_implementer_that_tampered_is_blocked_not_retried(env):
    repo, plan, calls = env
    _with_shared_dirs(repo)
    plan({"claude:implement": [{"do": "fail", "write": {".venv312/pkg.py": "ok = False\n"}}]})
    ctl = mk(repo, make_spec("T10", acceptance=ACCEPT))
    assert drive(ctl, "T10", {S.BLOCKED, S.REPAIR, S.AWAITING_APPROVAL}) == S.BLOCKED
    assert ctl.conn.execute("SELECT COUNT(*) FROM events WHERE task_id='T10' AND to_status='repair'").fetchone()[0] == 0


def test_timed_out_implementer_that_tampered_is_blocked(env):
    repo, plan, calls = env
    _with_shared_dirs(repo)
    plan({"claude:implement": [{"do": "sleep", "seconds": 60, "write": {"node_modules/pkg.py": "x = 1\n"}}]})
    ctl = mk(repo, make_spec("T11", acceptance=ACCEPT), implement_timeout_s=1)
    assert drive(ctl, "T11", {S.BLOCKED, S.REPAIR, S.AWAITING_APPROVAL}, timeout=20) == S.BLOCKED
