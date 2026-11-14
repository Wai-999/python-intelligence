"""Every exercise carries a difficulty tag (master prompt §5)."""
import copy
import importlib.util
import json
from pathlib import Path

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


def test_missing_or_bad_tags_fail():
    l = copy.deepcopy(LESSONS[0])
    ex = next(s for s in l["steps"] if s["kind"] in vc.EXERCISE_KINDS)
    for bad in (None, 0, 4, "2", True, 2.0):
        if bad is None:
            ex.pop("difficulty", None)
        else:
            ex["difficulty"] = bad
        assert vc.check_difficulty(l), bad
    tr = next(s for s in l["steps"] if s["kind"] == "transfer")
    tr["difficulty"] = 1
    ex["difficulty"] = 2
    assert any("can't be a warm-up" in e for e in vc.check_difficulty(l))
