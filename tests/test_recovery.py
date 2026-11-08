from conftest import make_spec, run_until

from orchestrator import db
from orchestrator.controller import Controller
from orchestrator.states import Status as S


def _crash_and_restart(path, tmp_path):
    """Simulate controller death: reopen DB with a fresh controller and run startup recovery."""
    c = db.connect(path)
    ctl = Controller(c, tmp_path)
    return ctl, ctl.recover()


def test_first_crash_refunds_attempt(tmp_path):
    p = tmp_path / "s.sqlite3"
    ctl = Controller(db.connect(p), tmp_path)
    ctl.load([make_spec("A", risk="low")])
    run_until(ctl, "A", S.RUNNING)
    assert db.get_task(ctl.conn, "A")["attempts"] == 1
    ctl2, moved = _crash_and_restart(p, tmp_path)
    assert moved == [("A", "running", "repair")]
    assert db.get_task(ctl2.conn, "A")["attempts"] == 0
    run_until(ctl2, "A", S.AWAITING_APPROVAL)  # and it still completes afterwards
    row = db.get_task(ctl2.conn, "A")
    assert row["dispatches"] == 2 and row["branch"].endswith("-d2")  # retry never reuses a branch


def test_repeated_crashes_eventually_block(tmp_path):
    p = tmp_path / "s.sqlite3"
    ctl = Controller(db.connect(p), tmp_path)
    ctl.load([make_spec("A", risk="medium", max_attempts=3)])
    for _ in range(10):
        run_until(ctl, "A", S.RUNNING)
        ctl, _ = _crash_and_restart(p, tmp_path)
        ctl.tick()  # repair -> ready|blocked
        if db.get_task(ctl.conn, "A")["status"] == S.BLOCKED:
            break
    assert db.get_task(ctl.conn, "A")["status"] == S.BLOCKED


def test_high_risk_orphan_goes_to_human(tmp_path):
    p = tmp_path / "s.sqlite3"
    ctl = Controller(db.connect(p), tmp_path)
    ctl.load([make_spec("A", risk="high")])
    run_until(ctl, "A", S.TESTING)
    _, moved = _crash_and_restart(p, tmp_path)
    assert moved == [("A", "testing", "blocked")]


def test_no_orphans_is_noop(ctl):
    ctl.load([make_spec("A")])
    assert ctl.recover() == []
