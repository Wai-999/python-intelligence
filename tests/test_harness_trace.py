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
    assert [x.get("output") for x in f] == [None, None, None, "6\n"]  # shown once line 3 has run
    assert f[-1]["note"] == "The program has finished." and all(x["stack"] == ["<module>"] for x in f)


def test_calls_show_the_stack_with_arguments_and_the_return_value():
    f = frames("def area(w, h):\n    return w * h\n\nprint(area(3, 4))\n")["trace"]["frames"]
    inside = [x for x in f if len(x["stack"]) == 2]
    assert inside and all(x["stack"] == ["<module>", "area(3, 4)"] for x in inside)
    assert any(x["note"] == "area returns 12." for x in f)
    assert f[-1]["output"] == "12\n"
    assert f[1]["locals"] == {"area": "function area"}  # no memory addresses


def test_long_runs_are_capped_but_finish():
    r = frames("n = 0\nwhile n < 1000:\n    n += 1\nprint(n)\n", limit=40)
    assert r["trace"]["truncated"] and len(r["trace"]["frames"]) == 41  # the cap, plus the closing frame
    assert r["trace"]["frames"][-1]["locals"] == {"n": "1000"} and r["trace"]["frames"][-1]["output"] == "1000\n"


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


def test_generators_yield_and_finish_and_class_bodies_do_not_return():
    f = frames("def gen():\n    yield 1\n    yield 2\n\nclass Box:\n    size = 1\n\nfor v in gen():\n    pass\n")["trace"]["frames"]
    notes = [x["note"] for x in f]
    assert "gen yields 1 and pauses." in notes and "gen yields 2 and pauses." in notes
    assert "gen has no more values to give." in notes
    assert not any("returns" in n for n in notes)  # neither the generator nor the class body "returns"


def test_an_error_leaving_a_function_is_not_a_return():
    r = frames("def bad():\n    return 1 / 0\n\ndef outer():\n    return bad()\n\ntry:\n    outer()\nexcept ZeroDivisionError:\n    print('caught')\n")
    notes = [x["note"] for x in r["trace"]["frames"]]
    assert "bad stops here: the error passes to its caller." in notes and "outer stops here: the error passes to its caller." in notes
    assert not any("returns" in n for n in notes)
    assert r["trace"]["frames"][-1]["output"] == "caught\n"


def test_output_is_exact_chunks_with_blank_lines_and_partial_writes():
    f = frames("print('a', end='')\nprint('b')\nprint()\nprint('c')\n")["trace"]["frames"]
    assert "".join(x.get("output", "") for x in f) == "ab\n\nc\n"


def test_trace_output_is_capped_with_a_marker():
    r = frames("for i in range(30):\n    print('x' * 10_000)\n", limit=10)
    kept = "".join(x.get("output", "") for x in r["trace"]["frames"])
    assert r["trace"]["outputCut"] and kept.endswith(harness.TRACE_OUTPUT_CUT + "\n")
    assert len(kept) <= harness.MAX_TRACE_OUTPUT + len(harness.TRACE_OUTPUT_CUT) + 2


def test_showing_values_never_runs_the_learners_code():
    code = ("class P:\n    def __repr__(self):\n        global calls\n        calls += 1\n        return 'P'\n\n"
            "calls = 0\np = P()\nxs = [p, {'k': p}]\nprint(calls)\n")
    r = frames(code)
    last = r["trace"]["frames"][-1]
    assert last["output"] == "0\n" and last["locals"]["p"] == "<P object>"
    assert last["locals"]["xs"] == "[<P object>, {'k': <P object>}]"
