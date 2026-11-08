"""The content gate must actually fail on broken lessons (a gate that never fails is no gate)."""
import copy
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)

LESSON = json.loads((ROOT / "content" / "lessons" / "py-functions.json").read_text())
IDS = {"py-values-names", "py-functions", "py-scope-defaults"}


def step(lesson, sid):
    return next(s for s in lesson["steps"] if s["id"] == sid)


def errors(mutate):
    l = copy.deepcopy(LESSON)
    mutate(l)
    return vc.check_lesson(l, set(), IDS)


def test_real_lesson_is_clean():
    assert vc.check_lesson(copy.deepcopy(LESSON), set(), IDS) == []


@pytest.mark.parametrize("mutate,expect", [
    (lambda l: step(l, "tax").__setitem__("expected_output", "wrong\n"), "!= expected_output"),
    (lambda l: step(l, "temps").__setitem__("solution", "def celsius_to_fahrenheit(c):\n    return c"), "solution fails test"),
    (lambda l: step(l, "temps").__setitem__("starter", step(l, "temps")["solution"]), "starter already passes"),
    (lambda l: step(l, "temps").__setitem__("solution", "while True:\n    pass"), "TimeoutError"),
    (lambda l: step(l, "check")["questions"][0].__setitem__("answer", 9), "answer index out of range"),
    (lambda l: step(l, "trace")["visual"]["frames"][0].__setitem__("line", 99), "outside code"),
    (lambda l: l["steps"].reverse(), "out of teaching-arc order"),
    (lambda l: l.__setitem__("prerequisites", ["nope"]), "unknown prerequisite"),
    (lambda l: l.__setitem__("sources", [{"source_id": "pch-fluent-python", "pages": [1, 2]}]), "not cleared"),
])
def test_broken_lessons_are_rejected(mutate, expect):
    errs = errors(mutate)
    assert any(expect in e for e in errs), errs
