"""Every meso-loop counterexample (content/counterexamples.json) does what it says, and its marked answer says the same."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

CASES = json.loads((Path(__file__).resolve().parents[1] / "content" / "counterexamples.json").read_text())


@pytest.mark.parametrize("signature", sorted(CASES))
def test_snippet_outcome_matches_the_marked_answer(signature, tmp_path):
    case = CASES[signature]
    assert 0 <= case["answer"] < len(case["choices"])
    answer = case["choices"][case["answer"]]
    outcome = case["outcome"]
    script = tmp_path / "snippet.py"
    script.write_text(case["code"] + "\n")
    try:
        run = subprocess.run([sys.executable, "-I", str(script)], capture_output=True, text=True, timeout=3, cwd=tmp_path)
    except subprocess.TimeoutExpired:
        assert outcome.get("runsForever"), f"{signature}: snippet didn't finish"
        assert "never stops" in answer or "doesn't stop" in answer
        return
    assert not outcome.get("runsForever"), f"{signature}: snippet finished"
    if "raises" in outcome:
        last = run.stderr.strip().splitlines()[-1]
        assert last.startswith(outcome["raises"] + ":"), last
        assert outcome["raises"] in answer
    else:
        assert run.returncode == 0, run.stderr
        assert run.stdout.strip() == outcome["prints"]
        assert answer == outcome["prints"]


def test_every_structural_error_class_named_in_the_signatures_is_a_real_exception():
    import builtins
    for signature in CASES:
        name = signature.removeprefix("error:")
        assert isinstance(getattr(builtins, name, None), type) and issubclass(getattr(builtins, name), BaseException), signature
