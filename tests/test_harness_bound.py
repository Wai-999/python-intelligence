"""harness.bound_names reads the names learner code binds with Python's own parser (used to tell typos from real
NameErrors in the meso loop), and run_learner attaches them to a NameError."""
import importlib.util
from pathlib import Path

import pytest

_spec = importlib.util.spec_from_file_location("harness", Path(__file__).resolve().parents[1] / "src" / "py" / "harness.py")
harness = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(harness)
names = harness.bound_names


@pytest.mark.parametrize("code, expected", [
    # assignments: chained, annotated, augmented, destructuring (nested, starred); subscripts and attributes bind nothing
    ("total, n = 0, 1\np = q = 0\ncount: int = 0\nlabel: str\nn += 1\n", {"total", "n", "p", "q", "count", "label"}),
    ("[first, second] = pair\n(a, (b, *c)) = x\nxs[i] = 1\nobj.attr = 2\ngrid[r][c] = 0\nd[k], e = 1, 2\n",
     {"first", "second", "a", "b", "c", "e"}),
    # keyword arguments (one line or several, on an assignment's right-hand side) and comparisons bind nothing
    ("plot(xs,\n     color=c,\n     label=name)\nresult = dict(\n    a=1,\n    b=2,\n)\nif n == 1: pass\n", {"result"}),
    # functions, parameters (multi-line, defaults with brackets, *args, **kw, keyword-only), lambdas, classes
    ("def area(width,\n         height=(1, 2), *rest, unit='m', **kw):\n    pass\nsquare = lambda n, *more, k=2: n * k\nclass Box: pass\n",
     {"area", "width", "height", "rest", "unit", "kw", "square", "n", "more", "k", "Box"}),
    # imports bind what Python binds
    ("import os.path\nimport numpy as np, json\nfrom os import path as p, sep\nfrom m import (a, b)\nfrom n import *\n",
     {"os", "np", "json", "p", "sep", "a", "b"}),
    # loops and comprehensions (nested, starred, dict), with/except as, walrus, global/nonlocal
    ("for i, item in enumerate(xs): acc = i\npairs = [a + b for a, b in rows]\nflat = [x for (i2, (j, *rest)) in g for x in rest]\n"
     "sq = {k: v for k, v in d.items()}\n", {"i", "item", "acc", "pairs", "a", "b", "flat", "i2", "j", "rest", "x", "sq", "k", "v"}),
    ("with open(f) as fh, open(g) as gh:\n    pass\ntry:\n    pass\nexcept ValueError as err:\n    pass\nif (n := 10) > 5: pass\n"
     "def f():\n    global total, count\n    nonlocal_free = 1\n", {"fh", "gh", "err", "n", "f", "total", "count", "nonlocal_free"}),
    # semicolons, one-line suites, a lambda inside a compound header
    ("total = 0; count = 1\nif ready: flag = 1\nelse: other = 2\nif lambda: 0: lam = 1\nwhile n: step = n\n",
     {"total", "count", "flag", "other", "lam", "step"}),
    # strings and comments never bind: quotes inside comments, triple quotes inside strings, real docstrings
    ("# don't use ''' here\ntotal = 0\ns = \"'''\"\ndoc = \"\"\"\nwidth = 3\n\"\"\"\n", {"total", "s", "doc"}),
    # f-strings: a walrus in a field binds, a nested format field's walrus binds, literal text and format specs don't
    ('print(f"{(count := 3)} items")\n', {"count"}),
    ('w = 5\nprint(f"{x:{(width := w)}}")\n', {"w", "width"}),
    ('x = 1\nprint(f"{x:=^10}")\nprint(f"literal (n := 5) text")\n', {"x"}),
    # a backslash just before a field, plain and raw (the field is still code)
    ('print(f"\\\\{(a := 1)}")\nprint(rf"\\{(b := 2)}")\n', {"a", "b"}),
    # match statements
    ("match cmd:\n    case [first, *others]:\n        pass\n    case {'k': val, **extra}:\n        pass\n    case Point(x=px) as pt:\n        pass\n",
     {"first", "others", "val", "extra", "px", "pt"}),
    # type parameters (Python 3.12)
    ("def first[T](items: list[T]) -> T:\n    return items[0]\n", {"first", "T", "items"}),
])
def test_bound_names(code, expected):
    compile(code, "<test>", "exec")  # every example is valid Python
    assert set(names(code)) == expected


def test_unparsable_code_binds_nothing():
    assert names("def broken(:\n") == []


def test_a_name_error_carries_the_bound_names_and_other_errors_do_not():
    err = harness.run_learner("total = 0\nlabel = f'{(count := 2)}'\nprint(totl)")["error"]
    assert err["type"] == "NameError" and err["bound"] == ["count", "label", "total"]
    assert "bound" not in harness.run_learner("x = 1 + 'a'")["error"]
    # UnboundLocalError is a NameError subclass with a different message: it gets no list (it is never a typo).
    assert "bound" not in harness.run_learner("c = 0\ndef f():\n    c = c + 1\nf()")["error"]
