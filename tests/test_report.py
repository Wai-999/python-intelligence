from orchestrator import db
from orchestrator.report import markdown_status
from orchestrator.spec import TaskSpec
from orchestrator.states import Status


def add_task(conn, task_id, title="Example", max_attempts=3):
    db.upsert_spec(conn, TaskSpec(
        id=task_id, title=title, owner="codex", reviewer="claude",
        allowed_paths=("orchestrator/report.py",),
        acceptance=("python -m pytest -q tests/test_report.py",),
        max_attempts=max_attempts,
    ))


def test_empty_database(tmp_path):
    with db.connect(tmp_path / "s.sqlite3") as conn:
        assert markdown_status(conn) == "# Orchestrator status\n\n_No tasks._\n"


def test_order_escaping_attempts_and_commits(tmp_path):
    with db.connect(tmp_path / "s.sqlite3") as conn:
        add_task(conn, "B", "Read | write | review")
        add_task(conn, "A", max_attempts=2)
        add_task(conn, "C")
        db.transition(conn, "B", Status.READY, actor="controller",
                      attempts_delta=1, commit_sha="1234567890abcdef")
        db.transition(conn, "C", Status.READY, actor="controller", commit_sha="abc")
        before = conn.total_changes
        report = markdown_status(conn)
        assert conn.total_changes == before
        assert report == (
            "# Orchestrator status\n\n"
            "| Task | Title | Status | Owner | Reviewer | Attempts | Commit |\n"
            "| --- | --- | --- | --- | --- | --- | --- |\n"
            "| A | Example | queued | codex | claude | 0/2 | — |\n"
            "| B | Read \\| write \\| review | ready | codex | claude | 1/3 | 1234567890 |\n"
            "| C | Example | ready | codex | claude | 0/3 | abc |\n"
            "\nTotals: queued 1, ready 2\n"
        )


def test_totals_follow_status_order_and_omit_zero_counts(tmp_path):
    with db.connect(tmp_path / "s.sqlite3") as conn:
        add_task(conn, "A")
        add_task(conn, "B")
        add_task(conn, "C")
        db.transition(conn, "A", Status.BLOCKED, actor="controller")
        db.transition(conn, "B", Status.READY, actor="controller")
        db.transition(conn, "B", Status.RUNNING, actor="controller")
        assert markdown_status(conn).splitlines()[-1] == (
            "Totals: queued 1, running 1, blocked 1"
        )
