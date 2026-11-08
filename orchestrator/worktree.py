"""Worktree/branch planning. Dry-run only: returns git argv lists, executes nothing."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


@dataclass(frozen=True)
class WorktreePlan:
    path: str
    branch: str | None
    commands: tuple[tuple[str, ...], ...]


def _check(task_id: str, agent: str) -> None:
    for v in (task_id, agent):
        if not _SAFE.match(v):
            raise ValueError(f"unsafe name component {v!r}")


def implement_worktree(repo: str | Path, task_id: str, agent: str, seq: int, base: str = "main") -> WorktreePlan:
    """Fresh worktree + branch per dispatch (`seq` only ever increases, unlike refundable attempts)."""
    _check(task_id, agent)
    path = str(Path(repo) / "worktrees" / f"task-{task_id}-{agent}-d{seq}")
    branch = f"agent/{agent}/{task_id}-d{seq}"
    return WorktreePlan(path, branch, (("git", "-C", str(repo), "worktree", "add", "-b", branch, path, base),))


def review_worktree(repo: str | Path, task_id: str, reviewer: str, commit_sha: str) -> WorktreePlan:
    """Detached checkout at the exact commit under review; reviewer never touches the writer's tree."""
    _check(task_id, reviewer)
    path = str(Path(repo) / "worktrees" / f"review-{task_id}-{reviewer}")
    return WorktreePlan(path, None, (
        ("git", "-C", str(repo), "worktree", "add", "--detach", path, commit_sha),
    ))


def merge_command(repo: str | Path, branch: str) -> tuple[str, ...]:
    return ("git", "-C", str(repo), "merge", "--no-ff", "--no-edit", branch)
