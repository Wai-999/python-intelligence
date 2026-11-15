"""harness.trace_learner (master prompt section 5, "Show execution trace"): a frame before each line of the learner's
code and at each return, with the active frame's names, the call stack and what the previous step printed."""
import importlib.util
from pathlib import Path

_spec = importlib.util.spec_from_file_location("harness", Path(__file__).resolve().parents[1] / "src" / "py" / "harness.py")
harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(harness)


def frames(code, limit=harness.MAX_TRACE_FRAMES):
    return harness.trace_learner(code, limit)


def test_a_three_line_program_step_by_step():
    r = frames("x = 2\ny = x * 3\nprint(y)\n")
    assert r["ok"] and r["error"] is None
    f = r["trace"]["frames"]
    assert [x["line"] for x in f] == [1, 2, 3, 3]
    assert [x["locals"] for x in f] == [{}, {"x": "2"}, {"x": "2", "y": "6"}, {"x": "2", "y": "6"}]
    assert [x.get("output") for x in f] == [None, None, None, "6"]  # shown once line 3 has run
    assert f[-1]["note"] == "The program has finished." and all(x["stack"] == ["<module>"] for x in f)


def test_calls_show_the_stack_with_arguments_and_the_return_value():
    f = frames("def area(w, h):\n    return w * h\n\nprint(area(3, 4))\n")["trace"]["frames"]
    inside = [x for x in f if len(x["stack"]) == 2]
    assert inside and all(x["stack"] == ["<module>", "area(3, 4)"] for x in inside)
    assert any(x["note"] == "area returns 12." for x in f)
    assert f[-1]["output"] == "12"
    assert f[1]["locals"] == {"area": "function area"}  # no memory addresses


def test_long_runs_are_capped_but_finish():
    r = frames("n = 0\nwhile n < 1000:\n    n += 1\nprint(n)\n", limit=40)
    assert r["trace"]["truncated"] and len(r["trace"]["frames"]) == 41  # the cap, plus the closing frame
    assert r["trace"]["frames"][-1]["locals"] == {"n": "1000"} and r["trace"]["frames"][-1]["output"] == "1000"


def test_an_error_ends_the_trace_at_its_line_and_values_stay_short():
    r = frames("s = 'x' * 100\nprint(s[:3])\nz = 1 / 0\n")
    assert not r["ok"] and r["error"]["type"] == "ZeroDivisionError"
    last = r["trace"]["frames"][-1]
    assert last["line"] == 3 and last["note"] == "Line 3 raised ZeroDivisionError: division by zero"
    assert len(last["locals"]["s"]) == 60 and last["locals"]["s"].endswith("...")


def test_library_code_and_imports_are_not_traced_or_listed():
    f = frames("import json\ntext = json.dumps([1, 2])\n")["trace"]["frames"]
    assert {x["line"] for x in f} == {1, 2}
    assert f[-1]["locals"] == {"text": "'[1, 2]'"}
