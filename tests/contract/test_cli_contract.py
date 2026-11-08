"""Live contract tests against the REAL claude/codex CLIs. Opt-in: PI_LIVE=1 python -m pytest tests/contract
Each test consumes a little subscription usage. Findings are documented in docs/audit/01-cli-contract.md.
"""

import json
import os
import subprocess
from pathlib import Path

import pytest

from orchestrator import agents, runner

pytestmark = [pytest.mark.live, pytest.mark.skipif(os.environ.get("PI_LIVE") != "1", reason="set PI_LIVE=1")]

PROBE = ('Answer in one line: do your instructions contain the phrase "knowledge-graph" or '
         '"codebase-memory"? Reply exactly LEAK:YES or LEAK:NO.')


@pytest.fixture
def repo(tmp_path):
    subprocess.run(["git", "init", "-q", "-b", "main", str(tmp_path)], check=True)
    (tmp_path / "README.md").write_text("probe\n")
    subprocess.run(["git", "-C", str(tmp_path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(tmp_path), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"],
                   check=True)
    return tmp_path


def test_claude_isolated_and_small_context(repo):
    exe = agents.resolve_binary("claude")
    res = runner.run([exe, "-p", PROBE, "--tools", "", "--permission-mode", "dontAsk", "--no-session-persistence",
                      "--output-format", "json", *agents.CLAUDE_ISOLATION], cwd=repo, timeout_s=180)
    d = json.loads(res.output[res.output.index("{"):])
    assert "LEAK:NO" in d["result"]
    assert d["usage"]["cache_creation_input_tokens"] + d["usage"].get("cache_read_input_tokens", 0) < 50_000


def test_codex_isolated_home(repo, tmp_path):
    exe = agents.resolve_binary("codex")
    home = agents.ensure_codex_home(tmp_path / "codex-home")
    out = tmp_path / "last.txt"
    res = runner.run([exe, "exec", "-s", "read-only", "--ephemeral", "-o", str(out), "-C", str(repo), PROBE],
                     cwd=repo, timeout_s=180, env=runner.scrubbed_env({"CODEX_HOME": home}))
    assert res.code == 0, res.output[-500:]
    assert "LEAK:NO" in out.read_text()


def test_codex_sandbox_cannot_commit_in_worktree(repo, tmp_path):
    wt = tmp_path / "wt"
    subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", "-b", "p", str(wt)], check=True)
    exe = agents.resolve_binary("codex")
    home = agents.ensure_codex_home(tmp_path / "codex-home")
    runner.run([exe, "exec", "-s", "workspace-write", "--ephemeral", "-C", str(wt),
                "Create a.txt containing hi, then run: git add a.txt && git commit -m x"],
               cwd=wt, timeout_s=240, env=runner.scrubbed_env({"CODEX_HOME": home}))
    log = subprocess.run(["git", "-C", str(wt), "log", "--oneline"], capture_output=True, text=True).stdout
    assert len(log.splitlines()) == 1  # still only the initial commit -> controller must commit
