"""Build gate for lesson content. Blocks publication on any error (exit 1).

Checks every content/lessons/*.json for:
  schema & teaching-arc order; unique ids; quiz answers in range; trace frames within the code;
  prerequisite graph (unknown ids, cycles, concepts taught twice);
  provenance (every source_id exists in the rights manifest AND is cleared for internal extraction);
  executable truth, using the SAME harness the browser runs (src/py/harness.py):
    - each example's stdout equals expected_output,
    - each exercise's solution passes all tests, and its starter fails at least one.
Snippets run in a subprocess with a timeout. NOTE: CPython here may differ from Pyodide's Python 3.12.7
for version-specific behaviour; lessons should stay within the common subset.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HARNESS = ROOT / "src" / "py" / "harness.py"
MANIFEST = ROOT / "docs" / "audit" / "source_manifest.json"
ORDER = ["motivation", "intuition", "visual", "formal", "example", "guided", "challenge", "quiz", "summary"]
REQUIRED_KINDS = {"motivation", "example", "quiz", "summary"}
COMMON = {"id", "kind", "title", "body"}
BY_KIND = {
    "visual": {"visual"}, "example": {"code", "expected_output"},
    "guided": {"starter", "hints", "tests", "solution"}, "challenge": {"starter", "hints", "tests", "solution"},
    "quiz": {"questions", "pass_mark"},
}
LESSON_FIELDS = {"id", "title", "summary", "track", "level", "estimated_minutes", "prerequisites", "concepts",
                 "sources", "license", "steps"}
TRACKS = {"python-core", "data", "statistics", "ml", "projects"}

RUNNER = r"""
import sys, json, io, contextlib, runpy
ns = runpy.run_path(sys.argv[1])
payload = json.loads(sys.stdin.read())
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    res = ns["run_learner"](payload["code"], payload["tests"])
res["stdout"] = buf.getvalue()
sys.__stdout__.write(json.dumps(res))
"""


def run_snippet(code: str, tests: list | None = None, timeout: float = 10) -> dict:
    try:
        p = subprocess.run([sys.executable, "-I", "-c", RUNNER, str(HARNESS)], input=json.dumps({"code": code, "tests": tests or []}),
                           capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": {"type": "TimeoutError", "message": f">{timeout}s"}, "tests": [], "stdout": ""}
    if p.returncode != 0:
        return {"ok": False, "error": {"type": "HarnessCrash", "message": p.stderr[-500:]}, "tests": [], "stdout": ""}
    return json.loads(p.stdout)


def check_lesson(lesson: dict, cleared_sources: set[str], all_ids: set[str]) -> list[str]:
    lid = lesson.get("id", "?")
    errs: list[str] = []
    E = lambda m: errs.append(f"{lid}: {m}")
    missing = LESSON_FIELDS - lesson.keys()
    if missing:
        return [f"{lid}: missing fields {sorted(missing)}"]
    if lesson["track"] not in TRACKS:
        E(f"unknown track {lesson['track']}")
    if lesson["level"] not in range(1, 6):
        E("level must be 1..5")
    if not str(lesson["license"]).strip():
        E("license must be stated")
    for p in lesson["prerequisites"]:
        if p not in all_ids:
            E(f"unknown prerequisite {p}")
    for s in lesson["sources"]:
        if s.get("source_id") not in cleared_sources:
            E(f"source {s.get('source_id')} is not cleared for internal extraction in the rights manifest")
        pages = s.get("pages")
        if not (isinstance(pages, list) and len(pages) == 2 and 0 < pages[0] <= pages[1]):
            E(f"source {s.get('source_id')} needs a valid [start, end] page range")

    steps = lesson["steps"]
    kinds = [s.get("kind") for s in steps]
    if not REQUIRED_KINDS <= set(kinds) or not any(k in ("guided", "challenge") for k in kinds):
        E(f"must include {sorted(REQUIRED_KINDS)} and at least one exercise; has {kinds}")
    idx = [ORDER.index(k) if k in ORDER else -1 for k in kinds]
    if -1 in idx:
        E(f"unknown step kind in {kinds}")
    elif idx != sorted(idx):
        E(f"steps out of teaching-arc order: {kinds}")
    seen = set()
    for s in steps:
        sid = s.get("id")
        where = f"step {sid}"
        if sid in seen:
            E(f"duplicate step id {sid}")
        seen.add(sid)
        need = COMMON | BY_KIND.get(s.get("kind"), set())
        if need - s.keys():
            E(f"{where}: missing {sorted(need - s.keys())}")
            continue
        k = s["kind"]
        if k == "visual":
            v = s["visual"]
            n_lines = len(v["code"].splitlines())
            if v.get("type") != "call-trace" or not v.get("frames"):
                E(f"{where}: visual must be a non-empty call-trace")
            for i, f in enumerate(v.get("frames", [])):
                if not 1 <= f.get("line", 0) <= n_lines:
                    E(f"{where}: frame {i} line {f.get('line')} outside code (1..{n_lines})")
            res = run_snippet(v["code"])
            if not res["ok"]:
                E(f"{where}: traced code fails: {res['error']}")
            outs = [f["output"] for f in v["frames"] if f.get("output")]
            if outs and res["stdout"].strip() != "\n".join(outs).strip():
                E(f"{where}: trace output {outs} != real output {res['stdout']!r}")
        elif k == "example":
            res = run_snippet(s["code"])
            if not res["ok"]:
                E(f"{where}: example raises {res['error']}")
            elif res["stdout"] != s["expected_output"]:
                E(f"{where}: stdout {res['stdout']!r} != expected_output {s['expected_output']!r}")
        elif k in ("guided", "challenge"):
            if not s["tests"]:
                E(f"{where}: needs tests")
            sol = run_snippet(s["solution"], s["tests"])
            if not sol["ok"]:
                E(f"{where}: solution raises {sol['error']}")
            for t in sol["tests"]:
                if not t["passed"]:
                    E(f"{where}: solution fails test '{t['name']}': {t['message']}")
            start = run_snippet(s["starter"], s["tests"])
            if start["ok"] and all(t["passed"] for t in start["tests"]):
                E(f"{where}: starter already passes every test (tests are not checking anything)")
        elif k == "quiz":
            if not 0 < s["pass_mark"] <= 1:
                E(f"{where}: pass_mark must be in (0, 1]")
            for q in s["questions"]:
                if not 0 <= q.get("answer", -1) < len(q.get("choices", [])):
                    E(f"{where}: question {q.get('id')} answer index out of range")
                if len(set(q.get("choices", []))) != len(q.get("choices", [])):
                    E(f"{where}: question {q.get('id')} has duplicate choices")
    return errs


def main() -> int:
    files = sorted((ROOT / "content" / "lessons").glob("*.json"))
    lessons = [json.loads(f.read_text()) for f in files]
    errs: list[str] = []
    for f, l in zip(files, lessons):
        if f.stem != l.get("id"):
            errs.append(f"{f.name}: file name must equal lesson id {l.get('id')!r}")
    manifest = json.loads(MANIFEST.read_text())
    cleared = {s["source_id"] for s in manifest["sources"] if s.get("allowed_for_internal_extraction")}
    ids = [l.get("id") for l in lessons]
    if len(set(ids)) != len(ids):
        errs.append("duplicate lesson ids")
    for l in lessons:
        errs += check_lesson(l, cleared, set(ids))

    # Graph-level: cycles and concept ownership; every concept referenced by tests/quizzes must be taught somewhere.
    taught: dict[str, str] = {}
    for l in lessons:
        for c in l["concepts"]:
            if c in taught:
                errs.append(f"concept {c} taught by both {taught[c]} and {l['id']}")
            taught[c] = l["id"]
    for l in lessons:
        for s in l["steps"]:
            refs = [t.get("concept") for t in s.get("tests", [])] + [q.get("concept") for q in s.get("questions", [])]
            for c in filter(None, refs):
                if c not in taught:
                    errs.append(f"{l['id']}/{s['id']}: concept {c} is not taught by any lesson")
    deps = {l["id"]: set(l["prerequisites"]) for l in lessons}
    done: set[str] = set()
    while True:
        nxt = {i for i, d in deps.items() if i not in done and d <= done}
        if not nxt:
            break
        done |= nxt
    if done != set(deps):
        errs.append(f"prerequisite cycle among {sorted(set(deps) - done)}")

    if errs:
        print("\n".join(f"✗ {e}" for e in errs))
        print(f"content invalid: {len(errs)} error(s)", file=sys.stderr)
        return 1
    n_exec = sum(1 for l in lessons for s in l["steps"] if s["kind"] in ("example", "guided", "challenge", "visual"))
    print(f"✓ content valid: {len(lessons)} lessons, {n_exec} executable steps verified with the shared harness")
    return 0


if __name__ == "__main__":
    sys.exit(main())
