from pathlib import Path

import pytest
from conftest import make_spec

from orchestrator.spec import MAX_ATTEMPTS, SpecError, check_scope, load_tasks, validate

ROOT = Path(__file__).resolve().parents[1]


def test_phase1_task_file_is_valid():
    specs = load_tasks(ROOT / "tasks" / "phase1.toml")
    ids = [s.id for s in specs]
    assert ids[0] == "P1-1"
    for s in specs:  # topological order: deps always come earlier
        assert all(ids.index(d) < ids.index(s.id) for d in s.depends_on)
        assert s.owner != s.reviewer


def test_cycle_rejected():
    with pytest.raises(SpecError, match="cycle"):
        validate([make_spec("A", deps=["B"]), make_spec("B", deps=["A"])])


def test_unknown_dependency_rejected():
    with pytest.raises(SpecError, match="unknown dependency"):
        validate([make_spec("A", deps=["Z"])])


def test_self_review_rejected():
    with pytest.raises(SpecError, match="reviewer must differ"):
        validate([make_spec("A", owner="codex", reviewer="codex")])


def test_retry_cap_enforced():
    with pytest.raises(SpecError, match="max_attempts"):
        validate([make_spec("A", max_attempts=MAX_ATTEMPTS + 1)])


@pytest.mark.parametrize("bad", ["/etc/**", "../outside/**"])
def test_allowed_paths_must_stay_in_repo(bad):
    with pytest.raises(SpecError, match="inside the repo"):
        validate([make_spec("A", allowed_paths=(bad,))])


def test_scope_check():
    allowed = ("src/**", "tests/test_x.py")
    assert check_scope(["src/a/b.py", "tests/test_x.py"], allowed) == []
    assert check_scope(["README.md"], allowed) == ["README.md"]
    assert check_scope(["../x"], allowed) == ["../x"]


@pytest.mark.parametrize("path", [".env", ".env.local", ".git/config", "sources/x.pdf",
                                  ".github/workflows/deploy.yml", ".orchestrator/state.sqlite3",
                                  "content/provenance/shingles.bin", "content/provenance/index.json",
                                  "content/sources.json", "content/source_sections.json"])
def test_always_denied_beats_allowlist(path):
    assert check_scope([path], ("**",)) == [path]
