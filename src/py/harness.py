# Single source of truth for executing learner code and lesson tests.
# Loaded verbatim into Pyodide (src/py/worker.ts) AND imported by scripts/validate_content.py under CPython,
# so a lesson that validates at build time behaves the same in the browser.
import ast as _ast
import json as _json
import os as _os
import tempfile as _tempfile
import traceback as _traceback

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
    ns = {"__name__": "__main__"}
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
