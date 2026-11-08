# Single source of truth for executing learner code and lesson tests.
# Loaded verbatim into Pyodide (src/py/worker.ts) AND imported by scripts/validate_content.py under CPython,
# so a lesson that validates at build time behaves the same in the browser.
import json as _json
import os as _os
import tempfile as _tempfile
import traceback as _traceback

LEARNER_FILE = "<learner>"


def _error_info(exc):
    tb = _traceback.extract_tb(exc.__traceback__)
    line = None
    for frame in reversed(tb):
        if frame.filename == LEARNER_FILE:
            line = frame.lineno
            break
    if line is None and isinstance(exc, SyntaxError):
        line = exc.lineno
    return {
        "type": type(exc).__name__,
        "message": str(exc),
        "line": line,
        "summary": "".join(_traceback.format_exception_only(type(exc), exc)).strip(),
    }


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
        result["error"] = _error_info(exc)
        return result
    for test in tests or []:
        name = test["name"]
        try:
            exec(compile(test["code"], "<test:" + name + ">", "exec"), ns)
        except AssertionError as exc:
            result["tests"].append({"name": name, "passed": False, "errorType": "AssertionError",
                                    "message": str(exc) or "assertion failed", "concept": test.get("concept")})
        except BaseException as exc:
            result["tests"].append({"name": name, "passed": False, "errorType": type(exc).__name__,
                                    "message": type(exc).__name__ + ": " + str(exc), "concept": test.get("concept")})
        else:
            result["tests"].append({"name": name, "passed": True, "errorType": None, "message": "",
                                    "concept": test.get("concept")})
    return result


def run_json(code, tests_json="[]"):
    """JSON-in/JSON-out entry point used from JavaScript."""
    return _json.dumps(run_learner(code, _json.loads(tests_json)))
