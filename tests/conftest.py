import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from orchestrator import db  # noqa: E402
from orchestrator.controller import Controller  # noqa: E402
from orchestrator.spec import TaskSpec  # noqa: E402


def make_spec(id, owner="claude", reviewer="codex", deps=(), **kw):
    return TaskSpec(id=id, title=f"task {id}", owner=owner, reviewer=reviewer,
                    allowed_paths=kw.pop("allowed_paths", ("src/**",)),
                    acceptance=kw.pop("acceptance", ("python -m pytest -q",)),
                    depends_on=tuple(deps), **kw)


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "state.sqlite3")
    yield c
    c.close()


@pytest.fixture
def ctl(conn, tmp_path):
    return Controller(conn, tmp_path / "repo")


def run_until(ctl, task_id, status, max_ticks=20):
    for _ in range(max_ticks):
        if db.get_task(ctl.conn, task_id)["status"] == status:
            return
        ctl.tick()
    raise AssertionError(f"{task_id} never reached {status}; now {db.get_task(ctl.conn, task_id)['status']}")
