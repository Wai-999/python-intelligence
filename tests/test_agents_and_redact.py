import json

import pytest
from conftest import make_spec

from orchestrator import agents, db, worktree
from orchestrator.redact import MASK, redact


@pytest.mark.parametrize("agent", ["claude", "codex"])
@pytest.mark.parametrize("role", ["implement", "review"])
def test_no_forbidden_flags(agent, role):
    inv = agents.build(agent, role, prompt="p", cwd="/w t", out_dir="/o", binary=agent)
    assert not agents.FORBIDDEN_ARGS.intersection(inv.argv)
    assert inv.stdin_devnull


def test_guard_rejects_forbidden():
    with pytest.raises(agents.UnsafeCommandError):
        agents._guard(["claude", "-p", "x", "--dangerously-skip-permissions"])


def test_claude_isolated_from_user_settings():
    argv = agents.build("claude", "implement", prompt="p", cwd="/w", out_dir="/o", binary="claude").argv
    i = argv.index("--setting-sources")
    assert argv[i + 1] == "project,local"
    assert "--bare" not in argv  # would break subscription auth


def test_codex_review_is_read_only_with_schema():
    argv = agents.build("codex", "review", prompt="p", cwd="/w", out_dir="/o", binary="codex").argv
    assert argv[argv.index("-s") + 1] == "read-only"
    assert "--output-schema" in argv and "--ignore-user-config" in argv
    assert argv[-1] == "p"


def test_claude_review_has_no_write_or_shell_tools():
    argv = agents.build("claude", "review", prompt="p", cwd="/w", out_dir="/o", binary="claude").argv
    tools = argv[argv.index("--tools") + 1].split(",")
    assert set(tools) == {"Read", "Glob", "Grep"}
    json.loads(argv[argv.index("--json-schema") + 1])


def test_worktree_names_and_injection_guard(tmp_path):
    p = worktree.implement_worktree(tmp_path, "P1-3", "codex", 2)
    assert p.path.endswith("worktrees/task-P1-3-codex-d2") and p.branch == "agent/codex/P1-3-d2"
    with pytest.raises(ValueError):
        worktree.implement_worktree(tmp_path, "x; rm -rf /", "codex", 1)


@pytest.mark.parametrize("secret", [
    "ghp_" + "a" * 36, "gho_" + "B" * 36, "github_pat_" + "c" * 30,
    "sk-ant-" + "d" * 40, "sk-" + "e" * 40, "Bearer " + "f" * 30,
])
def test_redact_tokens(secret):
    out = redact(f"log line {secret} end")
    assert secret not in out and MASK in out


def test_redact_key_value():
    assert redact("token=abcdefgh12345") == f"token={MASK}"


def test_secrets_never_reach_events_table(ctl):
    ctl.load([make_spec("A")])
    db.log_event(ctl.conn, "A", "note", "controller", {"stderr": "auth ghp_" + "z" * 36})
    blob = " ".join(r[0] for r in ctl.conn.execute("SELECT detail_json FROM events"))
    assert "ghp_" not in blob
