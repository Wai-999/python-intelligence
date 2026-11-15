# Single source of truth for executing learner code and lesson tests.
# Loaded verbatim into Pyodide (src/py/worker.ts) AND imported by scripts/validate_content.py under CPython,
# so a lesson that validates at build time behaves the same in the browser.
import ast as _ast
import json as _json
import os as _os
import sys as _sys
import tempfile as _tempfile
import traceback as _traceback
import types as _types

LEARNER_FILE = "<learner>"


def _mangle(name, cls):
    """Python's class-private name mangling: inside class C, __name (not __dunder__) is stored as _C__name."""
    if cls and name.startswith("__") and not name.endswith("__") and "." not in name:
        stripped = cls.lstrip("_")
        if stripped:
            return "_" + stripped + name
    return name


def bound_names(code):
    """Every name the code binds anywhere, read with Python's own parser (so every syntax form is handled exactly).

    Used to tell a misspelt name (a slip) from a structural NameError: an undefined name close to one of these is
    probably a typo. Assignment, loop, comprehension, with/except and match targets, walrus names, function, lambda
    and class names and parameters (including type parameters), the names imports bind, and global/nonlocal names.
    Inside a class body (and the functions in it), private names are mangled as Python does, so they compare with the
    names a NameError reports.
    """
    try:
        tree = _ast.parse(code)
    except SyntaxError:
        return []
    names = set()

    def visit(node, cls):
        add = lambda name: names.add(_mangle(name, cls))
        if isinstance(node, _ast.Name) and isinstance(node.ctx, _ast.Store):
            add(node.id)
        elif isinstance(node, _ast.arg):
            add(node.arg)
        elif isinstance(node, (_ast.FunctionDef, _ast.AsyncFunctionDef)):
            add(node.name)
        elif isinstance(node, _ast.ClassDef):
            add(node.name)  # mangled by the enclosing class, if any
        elif isinstance(node, (_ast.Import, _ast.ImportFrom)):
            for alias in node.names:
                if alias.name != "*":
                    add(alias.asname or alias.name.split(".")[0])
        elif isinstance(node, (_ast.Global, _ast.Nonlocal)):
            for name in node.names:
                add(name)
        elif isinstance(node, _ast.ExceptHandler) and node.name:
            add(node.name)
        elif isinstance(node, (_ast.MatchAs, _ast.MatchStar)) and node.name:
            add(node.name)
        elif isinstance(node, _ast.MatchMapping) and node.rest:
            add(node.rest)
        elif type(node).__name__ in ("TypeVar", "ParamSpec", "TypeVarTuple"):  # Python 3.12 type parameters
            add(node.name)
        inner = node.name if isinstance(node, _ast.ClassDef) else cls
        for child in _ast.iter_child_nodes(node):
            # A class's bases, keywords and decorators belong to the enclosing scope; only its body is inside it.
            visit(child, inner if isinstance(node, _ast.ClassDef) and child in node.body else cls)

    visit(tree, None)
    return sorted(names)


def _error_info(exc, code=None):
    tb = _traceback.extract_tb(exc.__traceback__)
    line = None
    for frame in reversed(tb):
        if frame.filename == LEARNER_FILE:
            line = frame.lineno
            break
    if line is None and isinstance(exc, SyntaxError):
        line = exc.lineno
    info = {
        "type": type(exc).__name__,
        "message": str(exc),
        "line": line,
        "summary": "".join(_traceback.format_exception_only(type(exc), exc)).strip(),
    }
    if type(exc) is NameError and code is not None:
        info["bound"] = bound_names(code)
    return info


def run_learner(code, tests=None):
    """Execute `code` in a fresh namespace AND a fresh, empty working directory, then each test there.

    The browser's file system persists between runs inside one worker, so without a fresh directory a file
    written by one run (or by one test) would change the next run's result. The directory is removed
    afterwards and the previous working directory restored. Never raises.
    """
    prev = _os.getcwd()
    with _tempfile.TemporaryDirectory(prefix="run-") as tmp:
        _os.chdir(tmp)
        try:
            return _run(code, tests)
        finally:
            _os.chdir(prev)


def _run(code, tests):
    # __source__ lets a check inspect how the code is written (e.g. with ast), not just the values it leaves behind.
    ns = {"__name__": "__main__", "__source__": code}
    result = {"ok": True, "error": None, "tests": []}
    try:
        exec(compile(code, LEARNER_FILE, "exec"), ns)
    except BaseException as exc:  # includes SystemExit / KeyboardInterrupt raised by learner code
        result["ok"] = False
        result["error"] = _error_info(exc, code)
        return result
    for test in tests or []:
        name = test["name"]
        try:
            exec(compile(test["code"], "<test:" + name + ">", "exec"), ns)
        except AssertionError as exc:
            result["tests"].append({"name": name, "passed": False, "errorType": "AssertionError",
                                    "message": str(exc) or "assertion failed", "concept": test.get("concept")})
        except BaseException as exc:
            entry = {"name": name, "passed": False, "errorType": type(exc).__name__,
                     "message": type(exc).__name__ + ": " + str(exc), "concept": test.get("concept")}
            if type(exc) is NameError:  # often a typo inside a learner function the check called
                entry["bound"] = bound_names(code)
            result["tests"].append(entry)
        else:
            result["tests"].append({"name": name, "passed": True, "errorType": None, "message": "",
                                    "concept": test.get("concept")})
    return result


def run_json(code, tests_json="[]"):
    """JSON-in/JSON-out entry point used from JavaScript."""
    return _json.dumps(run_learner(code, _json.loads(tests_json)))


# --- Execution trace of the learner's own code (master prompt section 5, "Show execution trace") ---------------------
MAX_TRACE_FRAMES = 300
MAX_TRACE_OUTPUT = 100_000  # characters of output kept in a trace, like the worker's per-run cap
TRACE_OUTPUT_CUT = "[output truncated: only the first 100,000 characters are kept in the trace]"
_HIDDEN = {"__builtins__", "__name__", "__source__"}
_SCALARS = (int, float, complex, bool, type(None))
_YIELD = __import__("dis").opmap.get("YIELD_VALUE")


def _show(value, depth=0):
    """A short display string that never runs the learner's own code: exact built-in types are formatted here (strings
    and containers cut short), library arrays and tables by their shape, anything else by its type's name."""
    kind = type(value)
    if kind in _SCALARS:
        text = repr(value)
    elif kind is str or kind is bytes:
        text = repr(value[:61])
    elif kind in (list, tuple, set, frozenset, dict) and depth < 2:
        items = list(value.items())[:8] if kind is dict else list(value)[:8]
        size = len(value)
        if kind is dict:
            inner = ", ".join(_show(k, depth + 1) + ": " + _show(v, depth + 1) for k, v in items)
        else:
            inner = ", ".join(_show(v, depth + 1) for v in items)
        if size > len(items):
            inner += ", ..."
        if kind is list:
            text = "[" + inner + "]"
        elif kind is tuple:
            text = "(" + inner + ("," if size == 1 else "") + ")"
        elif kind is dict:
            text = "{" + inner + "}"
        else:
            text = (kind.__name__ + "()") if size == 0 else ("{" + inner + "}" if kind is set else "frozenset({" + inner + "})")
    elif kind in (list, tuple, set, frozenset, dict):
        text = kind.__name__ + " of " + str(len(value))
    elif kind is range:
        text = repr(value)
    elif isinstance(value, _types.FunctionType):
        text = "function " + value.__name__
    elif isinstance(value, type):
        text = "class " + value.__name__
    elif kind.__module__.startswith("numpy") and kind.__name__ == "ndarray" and value.dtype.kind in "biuf":
        text = repr(value) if value.size <= 12 else "array of shape " + str(value.shape)
    elif kind.__module__.startswith("numpy") and kind.__name__ != "ndarray" and value.__class__.__mro__[-2].__name__ == "generic":
        text = repr(value.item()) if hasattr(value, "item") else "<" + kind.__name__ + ">"
    elif kind.__module__.startswith("pandas") and kind.__name__ == "DataFrame":
        text = "<DataFrame " + str(value.shape[0]) + " rows x " + str(value.shape[1]) + " columns>"
    elif kind.__module__.startswith("pandas") and kind.__name__ == "Series":
        text = "<Series of " + str(len(value)) + ">"
    else:
        text = "<" + kind.__name__ + " object>"
    text = " ".join(text.split()) if "\n" in text else text
    return text if len(text) <= 60 else text[:57] + "..."


def _visible(names):
    items = list(names.items())  # a snapshot: formatting must not see the namespace change underneath it
    return {k: _show(v) for k, v in items
            if k not in _HIDDEN and not k.startswith("__") and not isinstance(v, _types.ModuleType)}


def _stack(frame):
    """The learner's frames, outermost first, each call shown with its arguments' current values."""
    out = []
    while frame is not None:
        code = frame.f_code
        if code.co_filename == LEARNER_FILE:
            if code.co_name == "<module>":
                out.append("<module>")
            else:
                local = frame.f_locals
                args = code.co_varnames[:code.co_argcount]
                out.append(code.co_name + "(" + ", ".join(_show(local.get(a)) for a in args) + ")")
        frame = frame.f_back
    return out[::-1]


class _Tee:
    """Passes output through unchanged (the worker caps what reaches the page) and keeps an exact copy, within
    MAX_TRACE_OUTPUT characters, so each traced step knows what it printed."""
    def __init__(self, inner):
        self.inner = inner
        self.parts = []
        self.kept = 0
        self.cut = False

    def write(self, text):
        if not self.cut:
            room = MAX_TRACE_OUTPUT - self.kept
            if len(text) <= room:
                self.parts.append(text)
                self.kept += len(text)
            else:
                if room > 0:
                    self.parts.append(text[:room])
                self.parts.append("\n" + TRACE_OUTPUT_CUT + "\n")
                self.kept = MAX_TRACE_OUTPUT
                self.cut = True
        return self.inner.write(text)

    def take(self):
        text = "".join(self.parts)
        self.parts.clear()
        return text

    def __getattr__(self, name):
        return getattr(self.inner, name)


def trace_learner(code, max_frames=MAX_TRACE_FRAMES):
    """Run `code` like run_learner, recording a frame before each line of the learner's code runs and whenever one of
    its functions returns, yields or is left by an error: the line, the names in the active frame, the call stack and
    the exact output the previous step printed. At most `max_frames` frames are kept (plus a closing one); the program
    still runs to the end. Never raises."""
    prev = _os.getcwd()
    with _tempfile.TemporaryDirectory(prefix="trace-") as tmp:
        _os.chdir(tmp)
        try:
            return _trace(code, max_frames)
        finally:
            _os.chdir(prev)


def _trace(code, max_frames):
    ns = {"__name__": "__main__", "__source__": code}
    frames = []
    state = {"truncated": False}
    raising = set()  # frames an exception is passing through (cleared when a handler's line runs)
    out = _Tee(_sys.stdout)

    def add(info):
        text = out.take()  # printed since the previous frame: shown once the line that printed it has run
        if text:
            info["output"] = text
        frames.append(info)

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != LEARNER_FILE:
            return None  # library code is not traced
        if event == "exception":
            raising.add(id(frame))
            return tracer
        if event == "line":
            raising.discard(id(frame))
        if event not in ("line", "return"):
            return tracer
        if len(frames) >= max_frames:
            state["truncated"] = True
            return tracer
        name = frame.f_code.co_name
        if event == "line":
            note = "Next: line " + str(frame.f_lineno) + "."
        elif not frame.f_code.co_flags & 0x1:  # CO_OPTIMIZED: only functions (not the module or a class body) return
            return tracer
        elif id(frame) in raising:
            raising.discard(id(frame))
            note = name + " stops here: the error passes to its caller."
        elif _YIELD is not None and frame.f_lasti >= 0 and frame.f_code.co_code[frame.f_lasti] == _YIELD:
            note = name + " yields " + _show(arg) + " and pauses."
        elif frame.f_code.co_flags & 0x20:  # CO_GENERATOR, finishing
            note = name + " has no more values to give."
        else:
            note = name + " returns " + _show(arg) + "."
        add({"line": frame.f_lineno, "locals": _visible(frame.f_locals), "stack": _stack(frame), "note": note})
        return tracer

    result = {"ok": True, "error": None, "tests": []}
    real = _sys.stdout
    _sys.stdout = out
    _sys.settrace(tracer)
    try:
        exec(compile(code, LEARNER_FILE, "exec"), ns)
    except BaseException as exc:
        result["ok"] = False
        result["error"] = _error_info(exc, code)
    finally:
        _sys.settrace(None)
        _sys.stdout = real
    if frames:  # a closing frame shows the final names and the last output
        last = frames[-1]
        note = "The program has finished." if result["ok"] else "Line " + str(last["line"]) + " raised " + result["error"]["summary"]
        add({"line": last["line"], "locals": _visible(ns) if result["ok"] else last["locals"],
             "stack": ["<module>"] if result["ok"] else last["stack"], "note": note})
    result["trace"] = {"frames": frames, "truncated": state["truncated"], "limit": max_frames, "outputCut": out.cut}
    return result


def trace_json(code):
    """JSON-in/JSON-out entry point used from JavaScript."""
    return _json.dumps(trace_learner(code))
