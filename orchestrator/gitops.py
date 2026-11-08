"""Live git operations used by the live controller. All argv lists; the repo path may contain spaces."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

AGENT_IDENT = {
    "claude": ("Claude Code agent", "claude-agent@python-intelligence.local"),
    "codex": ("Codex agent", "codex-agent@python-intelligence.local"),
}


class GitError(RuntimeError):
    pass


def git(repo: str | Path, *args: str, check: bool = True, env: dict | None = None) -> str:
    p = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                       stdin=subprocess.DEVNULL, env={**os.environ, **(env or {})}, timeout=120)
    if check and p.returncode != 0:
        raise GitError(f"git {' '.join(args)} failed ({p.returncode}): {p.stderr.strip() or p.stdout.strip()}")
    return p.stdout.strip()


def is_clean(repo: str | Path) -> bool:
    return git(repo, "status", "--porcelain", "--untracked-files=normal") == ""


def current_branch(repo: str | Path) -> str:
    return git(repo, "rev-parse", "--abbrev-ref", "HEAD")


def branch_exists(repo: str | Path, branch: str) -> bool:
    return git(repo, "rev-parse", "--verify", "--quiet", f"refs/heads/{branch}", check=False) != ""


def add_worktree(repo, path, branch, base) -> None:
    if Path(path).exists():
        raise GitError(f"worktree path already exists: {path}")
    git(repo, "worktree", "add", "-b", branch, str(path), base)
    # Agents have no network; give them the main checkout's installed JS deps read-through.
    nm = Path(repo) / "node_modules"
    if nm.is_dir() and not (Path(path) / "node_modules").exists():
        (Path(path) / "node_modules").symlink_to(nm)


def add_review_worktree(repo, path, sha) -> None:
    if Path(path).exists():
        remove_worktree(repo, path)
    git(repo, "worktree", "add", "--detach", str(path), sha)
    nm = Path(repo) / "node_modules"
    if nm.is_dir():
        (Path(path) / "node_modules").symlink_to(nm)


def remove_worktree(repo, path) -> None:
    if Path(path).exists():
        git(repo, "worktree", "remove", "--force", str(path), check=False)
    git(repo, "worktree", "prune", check=False)


def stage_all(wt) -> list[str]:
    """Stage everything except the node_modules link; return staged paths."""
    git(wt, "add", "-A", "--", ".", ":(exclude)node_modules")
    out = git(wt, "diff", "--cached", "--name-only", "--no-renames")
    return [l for l in out.splitlines() if l]


def unstage_all(wt) -> None:
    git(wt, "reset", "-q", check=False)


def commit(wt, agent: str, message: str) -> str:
    name, email = AGENT_IDENT[agent]
    env = {"GIT_AUTHOR_NAME": name, "GIT_AUTHOR_EMAIL": email,
           "GIT_COMMITTER_NAME": "pi-orchestrator", "GIT_COMMITTER_EMAIL": "orchestrator@python-intelligence.local"}
    git(wt, "-c", "commit.gpgsign=false", "commit", "-q", "-m", message, env=env)
    return git(wt, "rev-parse", "HEAD")


def diff_patch(repo, base: str, sha: str) -> str:
    return git(repo, "diff", f"{base}...{sha}")


def merge(repo, branch: str, message: str) -> str:
    """--no-ff merge into the checked-out main. Aborts cleanly on conflict."""
    if current_branch(repo) != "main":
        raise GitError("main repo must have 'main' checked out to merge")
    if not is_clean(repo):
        raise GitError("main repo has uncommitted changes; refusing to merge")
    p = subprocess.run(["git", "-C", str(repo), "-c", "commit.gpgsign=false", "merge", "--no-ff", "-m", message, branch],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL)
    if p.returncode != 0:
        git(repo, "merge", "--abort", check=False)
        raise GitError(f"merge conflict or failure: {p.stdout.strip()} {p.stderr.strip()}")
    return git(repo, "rev-parse", "HEAD")
