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


def test_snippets_run_in_an_isolated_temporary_directory():
    """Lessons that write files must not touch the repository or see each other's files."""
    code = "import os\nwith open('probe.txt', 'w') as f:\n    f.write('x')\nprint(sorted(os.listdir('.')))"
    first, second = vc.run_snippet(code), vc.run_snippet("import os\nprint(sorted(os.listdir('.')))")
    assert first["stdout"].strip() == "['probe.txt']"
    assert second["stdout"].strip() == "[]"
    assert not (ROOT / "probe.txt").exists()


def test_packages_must_be_allowlisted_and_match_the_browser_versions():
    pins = vc.PACKAGES
    ok = {name: version for name, version in pins.items()}
    assert vc.check_packages({"packages": ["numpy"]}, ok) == []
    assert vc.check_packages({}, ok) == []
    assert "not available in the browser runtime" in vc.check_packages({"packages": ["scipy"]}, ok)[0]
    wrong = dict(ok, numpy="1.26.4")
    assert "needs numpy==" in vc.check_packages({"packages": ["numpy"]}, wrong)[0]
    assert "needs pandas==" in vc.check_packages({"packages": ["pandas"]}, dict(ok, pandas=None))[0]
    assert vc.check_packages({"packages": "numpy"}, ok) == ["packages must be a list of package names"]


def test_ci_installs_exactly_the_browser_package_versions():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    for name, version in vc.PACKAGES.items():
        if name in vc.CPYTHON_MODULES:
            assert f'"{name}==' not in ci, f"{name} is part of CPython: there is nothing to pip install"
            continue
        assert f'"{name}=={version}"' in ci, f"CI must pip install {name}=={version} (src/py/packages.json)"


def test_cpython_modules_are_checked_by_import_not_version():
    assert vc.CPYTHON_MODULES == {"sqlite3"} and vc.PACKAGES["sqlite3"] == "1.0.0"
    lesson = {"packages": ["sqlite3"], "steps": [{"id": "ex", "code": "import sqlite3"}]}
    assert vc.check_packages(lesson, {"sqlite3": vc.STDLIB}) == []
    assert any("doesn't import" in e for e in vc.check_packages(lesson, {"sqlite3": None}))
    assert any("does not declare" in e for e in vc.check_packages({"packages": [], "steps": lesson["steps"]}, {}))
    _, installed = vc.interpreter_report()
    assert installed["sqlite3"] == vc.STDLIB  # the validating CPython really imports it


def test_imported_roots():
    code = "import numpy as np\nimport os.path\nfrom pandas import DataFrame\nfrom . import x\nfrom collections.abc import Mapping"
    assert vc.imported_roots(code) == {"numpy", "os", "pandas", "collections"}
    assert vc.imported_roots("def (") == set()


def test_undeclared_package_imports_are_rejected():
    lesson = {"packages": ["numpy"], "steps": [
        {"id": "ex", "code": "import numpy as np"},
        {"id": "ch", "solution": "import pandas as pd", "tests": [{"code": "from pandas import Series"}]},
        {"id": "tr", "visual": {"code": "import math"}}]}
    errs = vc.check_packages(lesson, dict(vc.PACKAGES))
    assert errs == ["step ch: imports pandas but the lesson does not declare it in packages"]
    lesson["packages"] = ["numpy", "pandas"]
    assert vc.check_packages(lesson, dict(vc.PACKAGES)) == []


def test_packages_whose_import_name_differs(monkeypatch):
    # e.g. scikit-learn is imported as sklearn: the gate must map the import back to the package to declare.
    monkeypatch.setattr(vc, "PACKAGES", {"numpy": "2.0.2", "scikit-learn": "1.5.2"})
    monkeypatch.setattr(vc, "IMPORT_NAMES", {"numpy": "numpy", "scikit-learn": "sklearn"})
    installed = dict(vc.PACKAGES)
    lesson = {"packages": ["numpy"], "steps": [{"id": "ex", "code": "from sklearn.linear_model import LinearRegression"}]}
    assert vc.check_packages(lesson, installed) == ["step ex: imports sklearn but the lesson does not declare 'scikit-learn' in packages"]
    lesson["packages"] = ["numpy", "scikit-learn"]
    assert vc.check_packages(lesson, installed) == []
    # Importing a module literally named like the package (but not its import name) is not that package.
    assert vc.check_packages({"steps": [{"id": "x", "code": "import scikit_learn"}]}, installed) == []


def test_shipped_import_names_cover_only_supported_packages():
    meta = vc._PKG_MANIFEST.get("_import_names", {})
    assert isinstance(meta, dict) and set(meta) <= set(vc.PACKAGES)
    assert set(vc.IMPORT_NAMES) == set(vc.PACKAGES)


def _meta_lesson(**over):
    lesson = {"id": "not-pending-example", "concepts": ["loops"],
              "objective": "Repeat work with loops and stop at the right time.",
              "analogy": "A loop is a conveyor belt that handles one item per pass.",
              "misconceptions": [{"belief": "range(1, 5) includes 5.", "correction": "The stop value is excluded."},
                                 {"belief": "An accumulator reset inside the loop keeps the total.", "correction": "Set it once, before."}],
              "rubric": [{"criterion": "Right loop", "evidence": "for over items, while until a condition"},
                         {"criterion": "Accumulator", "evidence": "starts before the loop, updated inside"},
                         {"criterion": "Stops", "evidence": "ends at the right moment, using break"}],
              "review": {"recall": "When would you use while instead of for?"},
              "steps": [{"id": "t", "kind": "transfer", "tests": [{"concept": "loops"}]}]}
    lesson.update(over)
    return lesson


def test_lesson_metadata_is_required_and_checked():
    assert vc.check_meta(_meta_lesson()) == []
    for field, bad in [("objective", "short"), ("analogy", ""), ("misconceptions", [{"belief": "only one", "correction": "is not enough"}]),
                       ("rubric", [{"criterion": "One", "evidence": "two are not enough"}] * 2), ("review", {"recall": ""})]:
        errs = vc.check_meta(_meta_lesson(**{field: bad}))
        assert any(e.startswith(field) for e in errs), (field, errs)
    assert any("exactly one transfer" in e for e in vc.check_meta(_meta_lesson(steps=[])))
    assert any("tagged with the lesson's concepts" in e for e in vc.check_meta(_meta_lesson(steps=[{"id": "t", "kind": "transfer", "tests": [{"concept": "other"}]}])))


def test_pending_lessons_may_lack_metadata_but_partial_metadata_is_checked():
    pending = next(iter(vc.PENDING_META), None)
    if pending is None:
        return  # G-5 finished: every lesson is checked
    bare = {"id": pending, "concepts": ["x"], "steps": []}
    assert vc.check_meta(bare) == []
    assert vc.check_meta({**bare, "objective": "Do one thing well with this lesson's idea."}) != []


def test_the_pending_list_only_names_real_lessons_without_metadata():
    for lid in vc.PENDING_META:
        lesson = json.loads((ROOT / "content" / "lessons" / f"{lid}.json").read_text())
        assert "objective" not in lesson and not any(s["kind"] == "transfer" for s in lesson["steps"]), f"{lid} is done: remove it from pending_meta.json"
