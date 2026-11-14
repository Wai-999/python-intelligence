"""Every exercise carries a difficulty tag (master prompt §5)."""
import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)
LESSONS = [json.loads(p.read_text()) for p in sorted((ROOT / "content" / "lessons").glob("*.json"))]


def test_every_shipped_exercise_is_tagged():
    for lesson in LESSONS:
        assert vc.check_difficulty(lesson) == [], lesson["id"]
    kinds = {(s["kind"], s["difficulty"]) for l in LESSONS for s in l["steps"] if s["kind"] in vc.EXERCISE_KINDS}
    assert {k for k, _ in kinds} == set(vc.EXERCISE_KINDS)


FULL = next(l for l in LESSONS if {"guided", "challenge", "transfer"} <= {s["kind"] for s in l["steps"]})


@pytest.mark.parametrize("kind", ["guided", "challenge", "transfer"])
@pytest.mark.parametrize("bad", [None, 0, 4, "2", True, 2.0])
def test_missing_or_bad_tags_fail_on_every_exercise_kind(kind, bad):
    l = copy.deepcopy(FULL)
    ex = next(s for s in l["steps"] if s["kind"] == kind)
    if bad is None:
        ex.pop("difficulty")
    else:
        ex["difficulty"] = bad
    assert any(ex["id"] in e and "difficulty must be" in e for e in vc.check_difficulty(l)), (kind, bad)


def test_a_transfer_problem_cannot_be_a_warm_up():
    l = copy.deepcopy(FULL)
    next(s for s in l["steps"] if s["kind"] == "transfer")["difficulty"] = 1
    assert any("can't be a warm-up" in e for e in vc.check_difficulty(l))
