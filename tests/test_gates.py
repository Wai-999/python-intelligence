"""The invariants that matter most: nothing merges or releases without a human, bound to a SHA."""

import pytest
from conftest import make_spec, run_until

from orchestrator import db
from orchestrator.controller import Controller, LiveExecutionDisabled
from orchestrator.states import Status as S


def test_full_dry_run_lifecycle_stops_at_approval(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    for _ in range(10):  # ticking forever never merges
        ctl.tick()
    assert db.get_task(ctl.conn, "A")["status"] == S.AWAITING_APPROVAL


def test_approve_merges_and_release_needs_second_approval(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    ctl.approve("A", "human:owner")
    assert db.get_task(ctl.conn, "A")["status"] == S.MERGED
    with pytest.raises(db.GateError):  # merge approval does not carry over to release
        db.transition(ctl.conn, "A", S.RELEASED, actor="human:owner")
    ctl.approve("A", "human:owner", S.RELEASED)
    assert db.get_task(ctl.conn, "A")["status"] == S.RELEASED


def test_controller_actor_cannot_pass_gate_even_with_approval(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    db.record_approval(ctl.conn, "A", S.MERGED, "human:owner")
    with pytest.raises(db.GateError, match="human actor"):
        db.transition(ctl.conn, "A", S.MERGED, actor="controller")


def test_approval_bound_to_commit_sha(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    db.record_approval(ctl.conn, "A", S.MERGED, "human:owner")
    ctl.conn.execute("UPDATE tasks SET commit_sha = 'newer' WHERE id = 'A'")  # agent pushed again
    with pytest.raises(db.GateError, match="no unconsumed approval"):
        db.transition(ctl.conn, "A", S.MERGED, actor="human:owner")


def test_cannot_pre_approve_before_gate(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.REVIEW)
    with pytest.raises(db.GateError, match="only approve"):
        db.record_approval(ctl.conn, "A", S.MERGED, "human:owner")


def test_non_human_approver_rejected(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    with pytest.raises(db.GateError):
        db.record_approval(ctl.conn, "A", S.MERGED, "codex")


def test_retry_cap_then_blocked_then_human_unblock(ctl):
    ctl.load([make_spec("A", max_attempts=3, simulate_test_failures=99)])
    run_until(ctl, "A", S.BLOCKED, max_ticks=40)
    assert db.get_task(ctl.conn, "A")["attempts"] == 3
    with pytest.raises(db.GateError):
        db.transition(ctl.conn, "A", S.READY, actor="controller")
    ctl.unblock("A", "human:owner", "inspected logs")
    assert db.get_task(ctl.conn, "A")["status"] == S.READY


def test_one_failure_then_success(ctl):
    ctl.load([make_spec("A", simulate_test_failures=1)])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    assert db.get_task(ctl.conn, "A")["attempts"] == 2


def test_dependency_waits_for_merge(ctl):
    ctl.load([make_spec("A"), make_spec("B", deps=["A"])])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    assert db.get_task(ctl.conn, "B")["status"] == S.QUEUED
    ctl.approve("A", "human:owner")
    ctl.tick()
    assert db.get_task(ctl.conn, "B")["status"] in (S.READY, S.RUNNING)


def test_concurrency_and_one_session_per_agent(ctl):
    ctl.load([make_spec("A", owner="claude", reviewer="codex"),
              make_spec("B", owner="claude", reviewer="codex"),
              make_spec("C", owner="codex", reviewer="claude")])
    ctl.tick()
    running = {r["id"] for r in db.tasks_in(ctl.conn, S.RUNNING)}
    assert running == {"A", "C"}  # B waits: claude already busy


def test_illegal_transition_rejected(ctl):
    ctl.load([make_spec("A")])
    with pytest.raises(db.TransitionError, match="not allowed"):
        db.transition(ctl.conn, "A", S.REVIEW, actor="controller")


def test_live_mode_refused(conn, tmp_path):
    with pytest.raises(LiveExecutionDisabled):
        Controller(conn, tmp_path, dry_run=False)


def test_concurrency_cannot_exceed_two(conn, tmp_path):
    with pytest.raises(ValueError):
        Controller(conn, tmp_path, concurrency=3)


def test_state_survives_reopen(tmp_path):
    p = tmp_path / "s.sqlite3"
    c1 = db.connect(p)
    ctl = Controller(c1, tmp_path)
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.REVIEW)
    c1.close()
    c2 = db.connect(p)
    assert db.get_task(c2, "A")["status"] == S.REVIEW
    assert c2.execute("SELECT COUNT(*) FROM events WHERE task_id='A'").fetchone()[0] >= 5


def test_human_reject_sends_back_with_feedback(ctl):
    ctl.load([make_spec("A")])
    run_until(ctl, "A", S.AWAITING_APPROVAL)
    with pytest.raises(db.GateError):
        ctl.reject("A", "controller", "nope")
    ctl.reject("A", "human:owner", "validate on write")
    assert db.get_task(ctl.conn, "A")["status"] == S.REPAIR
    assert db.last_repair_feedback(ctl.conn, "A") == "validate on write"


# --- accept: a human may take a blocked task's TESTED commit to the gate (merge still needs approve) -------
def _blocked_after_review(ctl, tid):
    ctl.load([make_spec(tid)])
    run_until(ctl, tid, S.AWAITING_APPROVAL)          # implemented -> testing ✓ -> review -> gate
    db.transition(ctl.conn, tid, S.BLOCKED, actor="controller", expect=S.AWAITING_APPROVAL)


def test_accept_moves_tested_blocked_work_to_the_gate_only(ctl):
    _blocked_after_review(ctl, "A")
    sha = db.get_task(ctl.conn, "A")["commit_sha"]
    assert sha
    ctl.accept("A", "human:owner", "remaining findings are follow-ups")
    row = db.get_task(ctl.conn, "A")
    assert row["status"] == S.AWAITING_APPROVAL and row["commit_sha"] == sha
    with pytest.raises(db.GateError):                  # accepting is not approving
        db.transition(ctl.conn, "A", S.MERGED, actor="human:owner")
    ctl.approve("A", "human:owner")
    assert db.get_task(ctl.conn, "A")["status"] == S.MERGED


def test_accept_requires_a_human(ctl):
    _blocked_after_review(ctl, "A")
    with pytest.raises(db.GateError, match="only a human"):
        ctl.accept("A", "controller", "x")


def test_accept_refuses_work_that_did_not_pass_its_tests(ctl):
    ctl.load([make_spec("B")])
    run_until(ctl, "B", S.IMPLEMENTED)                 # never reached testing -> review
    db.transition(ctl.conn, "B", S.BLOCKED, actor="controller", expect=S.IMPLEMENTED)
    with pytest.raises(db.GateError, match="did not pass the acceptance tests"):
        ctl.accept("B", "human:owner", "x")
    assert db.get_task(ctl.conn, "B")["status"] == S.BLOCKED


def test_accept_refuses_a_newer_untested_attempt(ctl):
    _blocked_after_review(ctl, "C")
    ctl.unblock("C", "human:owner", "retry")           # a new attempt starts...
    run_until(ctl, "C", S.IMPLEMENTED)                 # ...and produces a commit that was never tested
    db.transition(ctl.conn, "C", S.BLOCKED, actor="controller", expect=S.IMPLEMENTED)
    with pytest.raises(db.GateError, match="did not pass"):
        ctl.accept("C", "human:owner", "x")


def test_accept_only_from_blocked(ctl):
    ctl.load([make_spec("D")])
    run_until(ctl, "D", S.AWAITING_APPROVAL)
    with pytest.raises(db.TransitionError):
        ctl.accept("D", "human:owner", "x")
