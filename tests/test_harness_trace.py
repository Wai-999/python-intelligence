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


def test_a_huge_integer_does_not_stop_the_program():
    r = frames("big = 10 ** 5000\nprint(big % 7)\n")
    assert r["ok"] and r["trace"]["frames"][-1]["output"] == "2\n"  # 10**5000 % 7 == 3**(5000 % 6) % 7
    assert r["trace"]["frames"][-1]["locals"]["big"].startswith("<int with about 500")


def test_metaclass_hooks_and_spoofed_library_types_are_never_run():
    code = ("calls = []\n"
            "class Meta(type):\n"
            "    def __getattribute__(cls, name):\n"
            "        calls.append(name)\n"
            "        return type.__getattribute__(cls, name)\n"
            "    def __repr__(cls):\n"
            "        calls.append('repr')\n"
            "        return 'M'\n"
            "class Thing(metaclass=Meta):\n"
            "    pass\n"
            "class ndarray:\n"  # a learner class named like numpy's, with a __class__ property
            "    @property\n"
            "    def __class__(self):\n"
            "        calls.append('__class__')\n"
            "        return int\n"
            "fake = ndarray()\n"
            "n = len(calls)\n"
            "print(n)\n")
    r = frames(code)
    plain = harness.run_learner(code)
    assert r["ok"] and plain["ok"]
    assert r["trace"]["frames"][-1]["output"] == "0\n"  # nothing was called while tracing
    last = r["trace"]["frames"][-1]["locals"]
    assert last["Thing"] == "class Thing" and last["fake"] == "<ndarray object>"


def test_an_uncaught_error_is_shown_at_the_line_that_raised_with_its_calls():
    r = frames("def inner(x):\n    return x / 0\n\ndef outer():\n    return inner(5)\n\nouter()\n")
    last = r["trace"]["frames"][-1]
    assert last["line"] == 2 and last["stack"] == ["<module>", "outer()", "inner(5)"]
    assert last["locals"] == {"x": "5"} and last["note"].startswith("Line 2 raised ZeroDivisionError")
    r = frames("n = 0\nwhile n < 100:\n    n += 1\nn / 0\n", limit=5)  # after truncation too
    assert r["trace"]["truncated"] and r["trace"]["frames"][-1]["line"] == 4


def test_call_labels_show_every_kind_of_parameter():
    f = frames("def f(a, *rest, key=1, **more):\n    return a\n\nf(1, 2, 3, key=4, z=5)\n")["trace"]["frames"]
    calls = {x["stack"][-1] for x in f if len(x["stack"]) == 2}
    assert calls == {"f(1, *(2, 3), key=4, **{'z': 5})"}


def test_finally_blocks_do_not_turn_an_error_into_a_return():
    code = ("def cleanup():\n    try:\n        return 1 / 0\n    finally:\n        print('tidy')\n\n"
            "def swallow():\n    try:\n        1 / 0\n    finally:\n        return 'kept'\n\n"
            "def handled():\n    try:\n        1 / 0\n    except ZeroDivisionError:\n        return 'fixed'\n\n"
            "print(swallow(), handled())\ntry:\n    cleanup()\nexcept ZeroDivisionError:\n    print('caught')\n")
    r = frames(code)
    notes = [x["note"] for x in r["trace"]["frames"]]
    assert "cleanup stops here: the error passes to its caller." in notes and not any(n.startswith("cleanup returns") for n in notes)
    assert "swallow returns 'kept'." in notes and "handled returns 'fixed'." in notes
    assert "".join(x.get("output", "") for x in r["trace"]["frames"]) == "kept fixed\ntidy\ncaught\n"


def test_numpy_values_are_shown_without_numpys_configurable_printing():
    code = ("import numpy as np\ncalls = []\n"
            "np.set_printoptions(formatter={'int': lambda v: calls.append(v) or str(v)})\n"
            "a = np.array([1, 2, 3])\nm = np.array([[1.5, 2.0], [3.0, 4.0]])\ns = a.sum()\nprint(len(calls))\n"
            "np.set_printoptions(formatter=None)\n")
    r = frames(code)
    assert r["ok"] and "".join(x.get("output", "") for x in r["trace"]["frames"]) == "0\n"  # no formatter call while tracing
    last = r["trace"]["frames"][-1]["locals"]
    assert last["a"] == "array([1, 2, 3])" and last["m"] == "array([[1.5, 2.0], [3.0, 4.0]])" and last["s"] == "6"
    import sys
    assert sys.gettrace() is None and sys.stdout is not None  # tracing and stdout restored


def test_a_metaclass_overriding_equality_is_never_called():
    code = ("calls = []\nclass Meta(type):\n    def __eq__(cls, other):\n        calls.append(1)\n        return False\n"
            "    __hash__ = type.__hash__\nclass Odd(metaclass=Meta):\n    pass\nthing = Odd()\nprint(len(calls))\n")
    assert "".join(x.get("output", "") for x in frames(code)["trace"]["frames"]) == "0\n"
    assert frames(code)["trace"]["frames"][-1]["locals"]["thing"] == "<Odd object>"


def test_yields_returns_and_unwinding_read_the_same_on_newer_pythons():
    """Pyodide pins Python 3.12; the instruction a yield stops on moved in 3.13. Run the same check on any newer
    interpreter installed here (skipped where there is none)."""
    import shutil
    import subprocess
    import sys
    import pytest
    found = [p for p in (shutil.which(f"python3.{m}") for m in (13, 14)) if p]
    if not found:
        pytest.skip("no Python 3.13 or 3.14 installed")
    src = Path(__file__).resolve().parents[1] / "src" / "py" / "harness.py"
    script = ("import importlib.util as u, json, sys\n"
              f"s = u.spec_from_file_location('h', {str(src)!r}); h = u.module_from_spec(s); s.loader.exec_module(h)\n"
              "r = h.trace_learner(\"def gen():\\n    yield 1\\n\\nfor v in gen():\\n    pass\\ndef bad():\\n    try:\\n        return 1 / 0\\n    finally:\\n        pass\\ntry:\\n    bad()\\nexcept ZeroDivisionError:\\n    pass\\n\")\n"
              "print(json.dumps([f['note'] for f in r['trace']['frames'] if not f['note'].startswith('Next')]))\n")
    for exe in found:
        out = subprocess.run([exe, "-I", "-c", script], capture_output=True, text=True, timeout=60)
        assert out.returncode == 0, out.stderr
        assert __import__("json").loads(out.stdout) == ["gen yields 1 and pauses.", "gen has no more values to give.",
                                                        "bad stops here: the error passes to its caller.", "The program has finished."], exe


def test_the_closing_frame_is_at_the_programs_own_last_line():
    assert frames("def f():\n    return 1\nx = f()\n")["trace"]["frames"][-1]["line"] == 3  # not inside f
    assert frames("def gen():\n    yield 1\n    yield 2\ng = gen()\nv = next(g)\n")["trace"]["frames"][-1]["line"] == 5
    r = frames("n = 0\nwhile n < 50:\n    n += 1\ndone = True\n", limit=6)  # past the frame cap
    assert r["trace"]["truncated"] and r["trace"]["frames"][-1]["line"] == 4


def test_set_displays_do_not_depend_on_the_hash_seed():
    import os
    import subprocess
    import sys
    src = Path(__file__).resolve().parents[1] / "src" / "py" / "harness.py"
    script = ("import importlib.util as u\n"
              f"s = u.spec_from_file_location('h', {str(src)!r}); h = u.module_from_spec(s); s.loader.exec_module(h)\n"
              "print(h._show({'pear', 'apple', 'fig', 'kiwi', 'plum', 'lime', 'date', 'nut', 'yam', 'oat'}), h._show(frozenset({'b', 'a'})))\n")
    seen = {subprocess.run([sys.executable, "-I", "-c", script], capture_output=True, text=True,
                           env={**os.environ, "PYTHONHASHSEED": seed}).stdout for seed in ("1", "2", "3", "4")}
    assert len(seen) == 1 and seen.pop().startswith("{'apple', 'date', 'fig'")


def test_numpy_scalars_are_shown_only_for_numpys_own_classes():
    code = ("import numpy as np\ncalls = []\nclass Sneaky(np.float64):\n    def item(self):\n        calls.append('item')\n"
            "        return 0.0\n    @property\n    def dtype(self):\n        calls.append('dtype')\n        return np.dtype('f8')\n"
            "s = Sneaky(2.5)\nt = np.int64(7)\nprint(len(calls))\n")
    r = frames(code)
    assert r["ok"] and "".join(x.get("output", "") for x in r["trace"]["frames"]) == "0\n"
    assert harness.run_learner(code)["ok"]
    last = r["trace"]["frames"][-1]["locals"]
    assert last["s"] == "<Sneaky object>" and last["t"] == "7"


def test_closing_or_throwing_into_a_generator_is_not_a_yield():
    code = ("def gen():\n    yield 1\n    yield 2\n\ndef tough():\n    while True:\n        try:\n            yield 'ok'\n"
            "        except ValueError:\n            pass\n\ng = gen()\nnext(g)\ng.close()\nh = gen()\nnext(h)\n"
            "try:\n    h.throw(KeyError('x'))\nexcept KeyError:\n    pass\nt = tough()\nnext(t)\nt.throw(ValueError())\n")
    notes = [x["note"] for x in frames(code)["trace"]["frames"]]
    assert notes.count("gen yields 1 and pauses.") == 2 and "gen yields 2 and pauses." not in notes
    assert "gen is closed." in notes and "gen stops here: the error passes to its caller." in notes
    assert notes.count("tough yields 'ok' and pauses.") == 2  # caught the thrown error and yielded again
