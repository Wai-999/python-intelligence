"""The meso loop's list of Python built-in names (src/learner/loop.ts) matches CPython's own."""
import builtins
import re
from pathlib import Path

SOURCE = (Path(__file__).resolve().parents[1] / "src" / "learner" / "loop.ts").read_text()


def test_builtin_names_match_the_interpreter():
    block = re.search(r"export const PY_BUILTINS = \[(.*?)\];", SOURCE, re.S).group(1)
    listed = re.findall(r'"([A-Za-z_]+)"', re.sub(r"//[^\n]*", "", block))
    assert len(listed) == len(set(listed)), "duplicates"
    real = {n for n in dir(builtins) if not n.startswith("_")
            and not (isinstance(getattr(builtins, n), type) and issubclass(getattr(builtins, n), BaseException))}
    assert set(listed) == real
