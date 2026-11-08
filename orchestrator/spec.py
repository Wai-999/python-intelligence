"""Task spec loading and validation."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from fnmatch import fnmatch
from pathlib import Path, PurePosixPath

AGENTS = ("claude", "codex")
RISKS = ("low", "medium", "high")
MAX_RETRIES = 2  # architecture: retry cap = 2  ->  at most 1 + 2 attempts
MAX_ATTEMPTS = 1 + MAX_RETRIES

# Never writable by an agent task, regardless of allowed_paths.
ALWAYS_DENIED = (".git/**", ".env", ".env.*", "sources/**", ".github/workflows/**", ".orchestrator/**", "worktrees/**",
                 # Provenance evidence is generated from the owner's book extracts; an agent must not be able to
                 # weaken the copy check or forge the catalogue that citations are validated against.
                 "content/provenance/**", "content/sources.json", "content/source_sections.json",
                 # Rights registries record owner decisions; only a human edits them.
                 "docs/audit/source_manifest.json", "docs/audit/web_sources.json")


class SpecError(ValueError):
    pass


@dataclass(frozen=True)
class TaskSpec:
    id: str
    title: str
    owner: str
    reviewer: str
    allowed_paths: tuple[str, ...]
    acceptance: tuple[str, ...]
    depends_on: tuple[str, ...] = ()
    risk: str = "medium"
    max_attempts: int = MAX_ATTEMPTS
    # Dry-run only: simulate a failing test gate on the first N attempts.
    simulate_test_failures: int = 0
    extra: dict = field(default_factory=dict, compare=False)

    @classmethod
    def from_dict(cls, d: dict) -> "TaskSpec":
        known = {"id", "title", "owner", "reviewer", "allowed_paths", "acceptance",
                 "depends_on", "risk", "max_attempts", "simulate_test_failures"}
        missing = {"id", "title", "owner", "reviewer", "allowed_paths", "acceptance"} - d.keys()
        if missing:
            raise SpecError(f"task {d.get('id', '?')}: missing fields {sorted(missing)}")
        return cls(
            id=str(d["id"]), title=str(d["title"]), owner=d["owner"], reviewer=d["reviewer"],
            allowed_paths=tuple(d["allowed_paths"]), acceptance=tuple(d["acceptance"]),
            depends_on=tuple(d.get("depends_on", ())), risk=d.get("risk", "medium"),
            max_attempts=int(d.get("max_attempts", MAX_ATTEMPTS)),
            simulate_test_failures=int(d.get("simulate_test_failures", 0)),
            extra={k: v for k, v in d.items() if k not in known},
        )

    def to_dict(self) -> dict:
        return {"id": self.id, "title": self.title, "owner": self.owner, "reviewer": self.reviewer,
                "allowed_paths": list(self.allowed_paths), "acceptance": list(self.acceptance),
                "depends_on": list(self.depends_on), "risk": self.risk, "max_attempts": self.max_attempts,
                "simulate_test_failures": self.simulate_test_failures}


def validate(specs: list[TaskSpec]) -> list[TaskSpec]:
    """Validate a task set; return it in a dependency-respecting (topological) order."""
    by_id: dict[str, TaskSpec] = {}
    for s in specs:
        if s.id in by_id:
            raise SpecError(f"duplicate task id {s.id}")
        by_id[s.id] = s
    for s in specs:
        if s.owner not in AGENTS or s.reviewer not in AGENTS:
            raise SpecError(f"{s.id}: owner/reviewer must be one of {AGENTS}")
        if s.owner == s.reviewer:
            raise SpecError(f"{s.id}: reviewer must differ from owner (independent review)")
        if s.risk not in RISKS:
            raise SpecError(f"{s.id}: risk must be one of {RISKS}")
        if not 1 <= s.max_attempts <= MAX_ATTEMPTS:
            raise SpecError(f"{s.id}: max_attempts must be 1..{MAX_ATTEMPTS} (retry cap {MAX_RETRIES})")
        if not s.allowed_paths:
            raise SpecError(f"{s.id}: allowed_paths must not be empty")
        if not s.acceptance:
            raise SpecError(f"{s.id}: at least one acceptance command is required")
        for p in s.allowed_paths:
            if p.startswith("/") or ".." in PurePosixPath(p).parts:
                raise SpecError(f"{s.id}: allowed path {p!r} must be relative and stay inside the repo")
        for d in s.depends_on:
            if d not in by_id:
                raise SpecError(f"{s.id}: unknown dependency {d}")

    # Kahn's algorithm; leftover nodes mean a cycle.
    indeg = {s.id: len(s.depends_on) for s in specs}
    children: dict[str, list[str]] = {s.id: [] for s in specs}
    for s in specs:
        for d in s.depends_on:
            children[d].append(s.id)
    order, frontier = [], sorted(i for i, n in indeg.items() if n == 0)
    while frontier:
        i = frontier.pop(0)
        order.append(by_id[i])
        for c in sorted(children[i]):
            indeg[c] -= 1
            if indeg[c] == 0:
                frontier.append(c)
    if len(order) != len(specs):
        cyclic = sorted(i for i, n in indeg.items() if n > 0)
        raise SpecError(f"dependency cycle among {cyclic}")
    return order


def load_tasks(path: str | Path) -> list[TaskSpec]:
    with open(path, "rb") as f:
        data = tomllib.load(f)
    return validate([TaskSpec.from_dict(d) for d in data.get("task", [])])


def check_scope(changed: list[str], allowed: tuple[str, ...] | list[str]) -> list[str]:
    """Return the changed paths that violate scope (empty list == in scope)."""
    violations = []
    for path in changed:
        p = PurePosixPath(path)
        if p.is_absolute() or ".." in p.parts:
            violations.append(path)
        elif any(fnmatch(path, pat) for pat in ALWAYS_DENIED):
            violations.append(path)
        elif not any(fnmatch(path, pat) for pat in allowed):
            violations.append(path)
    return violations
