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
_HIDDEN = {"__builtins__", "__name__", "__source__"}


def _show(value):
    """A short, deterministic display string: no memory addresses, at most 60 characters."""
    if isinstance(value, _types.FunctionType):
        return "function " + value.__name__
    if isinstance(value, type):
        return "class " + value.__name__
    try:
        text = repr(value)
    except Exception:
        text = "<unprintable " + type(value).__name__ + ">"
    if " at 0x" in text:  # objects without a repr of their own
        text = "<" + type(value).__name__ + " object>"
    return text if len(text) <= 60 else text[:57] + "..."


def _visible(names):
    return {k: _show(v) for k, v in names.items()
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
                args = code.co_varnames[:code.co_argcount]
                out.append(code.co_name + "(" + ", ".join(_show(frame.f_locals.get(a)) for a in args) + ")")
        frame = frame.f_back
    return out[::-1]


class _Tee:
    """Passes output through unchanged while keeping a copy, so each traced step knows what it printed."""
    def __init__(self, inner):
        self.inner = inner
        self.parts = []

    def write(self, text):
        self.parts.append(text)
        return self.inner.write(text)

    def __getattr__(self, name):
        return getattr(self.inner, name)


def trace_learner(code, max_frames=MAX_TRACE_FRAMES):
    """Run `code` like run_learner, recording a frame before each line of the learner's code runs and when each of
    its functions returns: the line, the names in the active frame, the call stack and the output that step printed.
    At most `max_frames` frames are kept; the program still runs to the end. Never raises."""
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
    out = _Tee(_sys.stdout)

    # Output printed since the last frame is shown with the next one, once the line that printed it has run.

    def add(frame_info):
        text = "".join(out.parts).rstrip("\n")
        out.parts.clear()
        if text:
            frame_info["output"] = text
        frames.append(frame_info)

    def tracer(frame, event, arg):
        if frame.f_code.co_filename != LEARNER_FILE:
            return None  # library code is not traced
        if event in ("line", "return"):
            if len(frames) >= max_frames:
                state["truncated"] = True
            elif event == "line":
                add({"line": frame.f_lineno, "locals": _visible(frame.f_locals), "stack": _stack(frame),
                     "note": "Next: line " + str(frame.f_lineno) + "."})
            elif frame.f_code.co_name != "<module>":
                add({"line": frame.f_lineno, "locals": _visible(frame.f_locals), "stack": _stack(frame),
                     "note": frame.f_code.co_name + " returns " + _show(arg) + "."})
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
        if result["ok"]:
            note = "The program has finished."
        else:
            note = "Line " + str(last["line"]) + " raised " + result["error"]["summary"]
        frames.append({"line": last["line"], "locals": _visible(ns) if result["ok"] else last["locals"],
                       "stack": ["<module>"] if result["ok"] else last["stack"], "note": note})
        text = "".join(out.parts).rstrip("\n")
        if text:
            frames[-1]["output"] = text
    result["trace"] = {"frames": frames, "truncated": state["truncated"], "limit": max_frames}
    return result


def trace_json(code):
    """JSON-in/JSON-out entry point used from JavaScript."""
    return _json.dumps(trace_learner(code))
