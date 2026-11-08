import json
import sys
import time

import pytest

from orchestrator import review, runner


def test_timeout_kills_whole_process_group(tmp_path):
    # parent spawns a grandchild sleeper; both must die
    code = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(60)']); time.sleep(60)"
    t0 = time.monotonic()
    res = runner.run([sys.executable, "-c", code], cwd=tmp_path, timeout_s=1)
    assert res.timed_out and time.monotonic() - t0 < 8


def test_stdin_is_closed(tmp_path):
    res = runner.run([sys.executable, "-c", "import sys; print(repr(sys.stdin.read()))"], cwd=tmp_path, timeout_s=10)
    assert res.output.strip() == "''"


def test_env_scrubbed():
    env = runner.scrubbed_env(base={"PATH": "/bin", "ANTHROPIC_API_KEY": "x", "GH_TOKEN": "y", "OPENAI_API_KEY": "z"})
    assert env["PATH"] == "/bin" and "ANTHROPIC_API_KEY" not in env and "GH_TOKEN" not in env
    assert "OPENAI_API_KEY" not in env and env["PI_WORKER"] == "1"


def test_logs_are_redacted(tmp_path):
    log = tmp_path / "l.log"
    tok = "ghp_" + "q" * 36
    runner.run([sys.executable, "-c", f"print('{tok}')"], cwd=tmp_path, timeout_s=10, log_path=log)
    assert tok not in log.read_text()


GOOD = {"verdict": "approve", "findings": [{"severity": "low", "file": "a.py", "line": 3, "summary": "s",
                                             "reproduction": "r", "proposed_fix": "f"}]}


def test_parse_claude_structured_output():
    r = review.parse_claude("Warning: no stdin\n" + json.dumps({"structured_output": GOOD, "result": "x"}))
    assert r.passes and len(r.findings) == 1


def test_parse_claude_falls_back_to_result_text():
    r = review.parse_claude(json.dumps({"result": "```json\n" + json.dumps(GOOD) + "\n```"}))
    assert r.verdict == "approve"


def test_parse_codex(tmp_path):
    f = tmp_path / "last.txt"
    f.write_text(json.dumps({**GOOD, "verdict": "request_changes"}))
    r = review.parse_codex(f)
    assert not r.passes and "a.py:3" in r.feedback()


def test_high_finding_blocks_even_if_approved():
    bad = {"verdict": "approve", "findings": [{**GOOD["findings"][0], "severity": "high"}]}
    assert not review.validate(bad).passes


@pytest.mark.parametrize("obj", [{"verdict": "lgtm", "findings": []}, {"verdict": "approve"},
                                 {"verdict": "approve", "findings": [{"severity": "meh"}]}])
def test_invalid_reviews_rejected(obj):
    with pytest.raises(review.ReviewParseError):
        review.validate(obj)


def test_missing_codex_output(tmp_path):
    with pytest.raises(review.ReviewParseError):
        review.parse_codex(tmp_path / "nope.txt")
