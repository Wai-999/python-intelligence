"""Each lesson's transfer problem grades fairly: plausible wrong solutions fail, and other valid solutions pass.
The variants live in tests/transfer_variants.json; they run through the same harness the browser uses."""
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(vc)
VARIANTS = json.loads((ROOT / "tests" / "transfer_variants.json").read_text())
CASES = [(lid, kind, i) for lid, v in sorted(VARIANTS.items()) for kind in ("reject", "accept") for i in range(len(v[kind]))]


def transfer(lid):
    lesson = json.loads((ROOT / "content" / "lessons" / f"{lid}.json").read_text())
    return next(s for s in lesson["steps"] if s["kind"] == "transfer")


@pytest.mark.parametrize("lid, kind, i", CASES)
def test_transfer_variant(lid, kind, i):
    step = transfer(lid)
    res = vc.run_snippet(VARIANTS[lid][kind][i], step["tests"], timeout=20)
    passed = res["ok"] and len(res["tests"]) == len(step["tests"]) and all(t["passed"] for t in res["tests"])
    if kind == "reject":
        assert not passed, f"{lid}: a wrong solution passes every check"
    else:
        assert passed, f"{lid}: a valid solution fails: {[t['message'] for t in res['tests'] if not t['passed']] or res.get('error')}"


def test_every_finished_lesson_has_variants():
    pending = set(json.loads((ROOT / "content" / "pending_meta.json").read_text())["lessons"])
    done = {p.stem for p in (ROOT / "content" / "lessons").glob("*.json")} - pending
    assert done <= set(VARIANTS), f"add transfer variants for {sorted(done - set(VARIANTS))}"
    assert all(VARIANTS[lid]["reject"] and VARIANTS[lid]["accept"] for lid in VARIANTS)
