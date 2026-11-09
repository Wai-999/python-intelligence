"""Worktrees get read-through links to local tool dirs, and those links are never staged or committed."""
import subprocess

from orchestrator import gitops


def _repo(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    g = lambda *a: subprocess.run(["git", "-C", str(repo), *a], check=True, capture_output=True)  # noqa: E731
    g("init", "-q", "-b", "main")
    (repo / "README.md").write_text("x\n")
    g("add", "README.md")
    g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init")
    for name in gitops.SHARED_LINKS:
        (repo / name).mkdir()
        (repo / name / "marker").write_text(name)
    return repo


def test_agent_and_review_worktrees_link_shared_tool_dirs(tmp_path):
    repo = _repo(tmp_path)
    wt, rv = tmp_path / "wt", tmp_path / "rv"
    gitops.add_worktree(repo, wt, "agent/x", "main")
    gitops.add_review_worktree(repo, rv, "main")
    for path in (wt, rv):
        for name in gitops.SHARED_LINKS:
            assert (path / name).is_symlink() and (path / name / "marker").read_text() == name
    assert ".venv312" in gitops.SHARED_LINKS  # the content gate's CPython 3.12 + numpy/pandas env


def test_stage_all_never_includes_the_shared_links(tmp_path):
    repo = _repo(tmp_path)
    wt = tmp_path / "wt"
    gitops.add_worktree(repo, wt, "agent/y", "main")
    (wt / "feature.py").write_text("x = 1\n")
    assert gitops.stage_all(wt) == ["feature.py"]
