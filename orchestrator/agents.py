"""argv builders for the two worker CLIs. Flags verified against --help on 2026-11-08:
claude 2.1.319, codex-cli 0.167.0-alpha.3.2. See docs/adr/0001-dual-agent-orchestrator.md §4.
"""

from __future__ import annotations

import json
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

CODEX_APP_BIN = "/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex"
PINNED_VERSIONS = {"claude": "2.1.319", "codex": "0.167.0-alpha.3.2"}

FORBIDDEN_ARGS = frozenset({
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "bypassPermissions",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "danger-full-access",
    "--bare",  # breaks subscription auth (API key only)
})

CLAUDE_IMPLEMENT_TOOLS = ("Read", "Edit", "Write", "Glob", "Grep",
                          "Bash(git status:*)", "Bash(git diff:*)", "Bash(python -m pytest:*)")
CLAUDE_REVIEW_TOOLS = ("Read", "Glob", "Grep")

FINDINGS_SCHEMA = {
    "type": "object",
    "required": ["verdict", "findings"],
    "additionalProperties": False,
    "properties": {
        "verdict": {"enum": ["approve", "request_changes"]},
        "findings": {"type": "array", "items": {
            "type": "object",
            "required": ["severity", "file", "line", "summary", "reproduction", "proposed_fix"],
            "additionalProperties": False,
            "properties": {
                "severity": {"enum": ["critical", "high", "medium", "low"]},
                "file": {"type": "string"}, "line": {"type": "integer"},
                "summary": {"type": "string"}, "reproduction": {"type": "string"},
                "proposed_fix": {"type": "string"},
            },
        }},
    },
}


class UnsafeCommandError(ValueError):
    pass


def resolve_binary(agent: str) -> str | None:
    if agent == "claude":
        return os.environ.get("PI_CLAUDE_BIN") or shutil.which("claude")
    if agent == "codex":
        env = os.environ.get("PI_CODEX_BIN")
        if env:
            return env
        return shutil.which("codex") or (CODEX_APP_BIN if Path(CODEX_APP_BIN).exists() else None)
    raise ValueError(agent)


@dataclass(frozen=True)
class Invocation:
    agent: str
    role: str  # "implement" | "review"
    argv: tuple[str, ...]
    cwd: str
    env: tuple[tuple[str, str], ...] = ()  # extra env vars (e.g. isolated CODEX_HOME)
    stdin_devnull: bool = True  # codex appends piped stdin to the prompt; claude waits 3 s for it


def _guard(argv: list[str]) -> tuple[str, ...]:
    bad = FORBIDDEN_ARGS.intersection(argv)
    if bad:
        raise UnsafeCommandError(f"forbidden arguments: {sorted(bad)}")
    return tuple(argv)


# Verified in docs/audit/01-cli-contract.md: these stop user-global hooks/MCP/skills leaking in
# and cut per-call context from ~390k to ~3k tokens, while still loading the project CLAUDE.md.
CLAUDE_ISOLATION = ("--setting-sources", "project,local", "--strict-mcp-config", "--disable-slash-commands")


def build(agent: str, role: str, *, prompt: str, cwd: str, out_dir: str, binary: str | None = None,
          codex_home: str | None = None, extra_tools: tuple[str, ...] = ()) -> Invocation:
    if role not in ("implement", "review"):
        raise ValueError(role)
    exe = binary or resolve_binary(agent) or agent
    if agent == "claude":
        argv = [exe, "-p", prompt, "--output-format", "json", "--no-session-persistence",
                "--permission-mode", "dontAsk", *CLAUDE_ISOLATION]
        if role == "implement":
            argv += ["--allowedTools", *CLAUDE_IMPLEMENT_TOOLS, *extra_tools]
        else:
            argv += ["--tools", ",".join(CLAUDE_REVIEW_TOOLS),
                     "--json-schema", json.dumps(FINDINGS_SCHEMA, separators=(",", ":"))]
    elif agent == "codex":
        sandbox = "workspace-write" if role == "implement" else "read-only"
        argv = [exe, "exec", "-s", sandbox, "-C", cwd, "--json",
                "-o", str(Path(out_dir) / f"codex-{role}-last.txt"), "--ephemeral", "--ignore-user-config"]
        if role == "review":
            argv += ["--output-schema", str(Path(out_dir) / "findings.schema.json")]
        argv.append(prompt)
    else:
        raise ValueError(agent)
    # --ignore-user-config alone does NOT stop ~/.codex/AGENTS.md; a dedicated CODEX_HOME does.
    env = (("CODEX_HOME", codex_home),) if agent == "codex" and codex_home else ()
    return Invocation(agent=agent, role=role, argv=_guard(argv), cwd=cwd, env=env)


def ensure_codex_home(path: str | Path) -> str:
    """Isolated CODEX_HOME whose auth.json is a symlink (credentials are never copied)."""
    home = Path(path)
    home.mkdir(parents=True, exist_ok=True)
    link, real = home / "auth.json", Path.home() / ".codex" / "auth.json"
    if not link.is_symlink():
        if link.exists():
            raise UnsafeCommandError(f"{link} exists and is not a symlink; refusing to touch credentials")
        link.symlink_to(real)
    return str(home)


def implement_prompt(spec, feedback: str | None = None) -> str:
    brief = spec.extra.get("brief", "")
    text = (f"Task {spec.id}: {spec.title}\n"
            f"{brief}\n\n"
            f"Follow AGENTS.md and MASTER_ARCHITECTURE.md. Create or modify ONLY these paths: {list(spec.allowed_paths)}.\n"
            f"After you finish, the controller will itself run: {list(spec.acceptance)}.\n"
            "Do NOT run git add/commit: the controller commits your working-tree changes. "
            "You have no network access. End with a short report: changed files, checks run, results, risks.")
    if feedback:
        text += f"\n\nThis is a retry. The previous attempt was rejected. Fix these problems:\n{feedback}"
    return text


def review_prompt(spec, commit_sha: str) -> str:
    return (f"Independently review task {spec.id} ('{spec.title}') at commit {commit_sha}.\n"
            "The diff is in REVIEW_DIFF.patch. Do not modify files. Return findings with severity, file, "
            "line, reproduction and proposed fix, matching the provided JSON schema.")
