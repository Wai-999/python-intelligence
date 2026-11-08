"""Build gate for lesson content. Blocks publication on any error (exit 1).

Checks every content/lessons/*.json for:
  schema & teaching-arc order; unique ids; quiz answers in range; trace frames within the code;
  prerequisite graph (unknown ids, cycles, concepts taught twice);
  provenance: every source is cleared in the rights manifest and listed in content/sources.json; page
    ranges exist and contain the cited section heading; in a book-grounded lesson every intuition/formal
    step cites a source and every source is cited; adapted sources share one licence and the lesson
    carries it; no lesson string copies 12+ consecutive words from a local extract (when extracts exist);
  executable truth, using the SAME harness the browser runs (src/py/harness.py):
    - each example's stdout equals expected_output,
    - each exercise's solution passes all tests, and its starter fails at least one.
Snippets run in a subprocess with a timeout. NOTE: CPython here may differ from Pyodide's Python 3.12.7
for version-specific behaviour; lessons should stay within the common subset.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provenance import SHINGLE, ExtractIndex, strings_in  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "content" / "sources.json"
SECTIONS = ROOT / "content" / "source_sections.json"
ATTEST = ROOT / "content" / "provenance_attestation.json"
CLAIM_KINDS = {"intuition", "formal"}  # steps that state facts and so must cite, in a book-grounded lesson
USES = {"reference", "adapted"}
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


def section_spans(sections: list, page_count: int) -> list[tuple[str, int, int]]:
    """(title, first page, last page) per heading; a section runs until the next heading of the same or higher level."""
    out = []
    for i, (lvl, title, page) in enumerate(sections):
        nxt = next((p for l2, _, p in sections[i + 1:] if l2 <= lvl), page_count + 1)
        out.append((title, page, max(page, nxt - 1) if nxt > page else page))
    return out


def lesson_digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def make_attestation(files: list[Path], index: ExtractIndex) -> dict:
    """Record that these exact lesson files passed the copy check against these exact extracts."""
    return {"_note": "Written by validate_content.py after a passing copy check against local extracts. CI, which has "
                     "no extracts, requires every lesson to match this record.",
            "shingle_words": SHINGLE,
            "extracts": dict(sorted(index.shas.items())),
            "lessons": {f.stem: lesson_digest(f) for f in sorted(files)}}


def check_attestation(files: list[Path], attestation: dict | None, catalog: dict) -> list[str]:
    """Used where extracts are absent: every lesson must have passed the copy check, unchanged since."""
    if attestation is None:
        return [f"no {ATTEST.name}: run the build where book extracts exist (python -m ingest) to copy-check lessons"]
    errs = []
    if attestation.get("shingle_words") != SHINGLE:
        errs.append(f"{ATTEST.name} was made with a different shingle size; re-run the copy check")
    for sid, cat in catalog.items():
        if attestation.get("extracts", {}).get(sid) != cat.get("sha256"):
            errs.append(f"{ATTEST.name} does not cover {sid} at sha256 {str(cat.get('sha256'))[:12]}; re-run the copy check")
    for f in files:
        if attestation.get("lessons", {}).get(f.stem) != lesson_digest(f):
            errs.append(f"{f.stem}: changed since its last copy check against the book extracts; run the build where extracts exist")
    return errs


def check_provenance(lesson: dict, cleared: set[str], catalog: dict) -> list[str]:
    """Citation rules. `catalog` is content/sources.json["sources"]."""
    errs: list[str] = []
    refs: dict[str, dict] = {}
    for s in lesson["sources"]:
        rid, sid = s.get("id"), s.get("source_id")
        tag = f"source {rid or sid}"
        if not isinstance(rid, str) or not rid:
            errs.append(f"{tag}: needs an id that steps can cite")
        elif rid in refs:
            errs.append(f"{tag}: duplicate source id")
        else:
            refs[rid] = s
        if s.get("use") not in USES:
            errs.append(f"{tag}: use must be one of {sorted(USES)}")
        pages = s.get("pages")
        if not (isinstance(pages, list) and len(pages) == 2 and all(type(x) is int for x in pages)
                and 0 < pages[0] <= pages[1]):
            errs.append(f"{tag}: needs a valid [start, end] page range")
            pages = None
        if sid not in cleared:
            errs.append(f"{tag}: {sid} is not cleared for internal extraction in the rights manifest")
            continue
        cat = catalog.get(sid)
        if cat is None:
            errs.append(f"{tag}: {sid} is not in content/sources.json (run scripts/build_source_catalog.py)")
            continue
        if pages and pages[1] > cat["page_count"]:
            errs.append(f"{tag}: pages {pages} beyond the end of {cat['short']} ({cat['page_count']} pages)")
        elif pages and not any(t == s.get("section") and p <= pages[1] and end >= pages[0]
                               for t, p, end in section_spans(cat["sections"], cat["page_count"])):
            errs.append(f"{tag}: section {s.get('section')!r} is not a heading of {cat['short']} overlapping pages {pages}")
    cited: set[str] = set()
    for st in lesson["steps"]:
        c = st.get("cites", [])
        if not (isinstance(c, list) and all(isinstance(x, str) for x in c)):
            errs.append(f"step {st.get('id')}: cites must be a list of source ids")
            continue
        for r in c:
            if r not in refs:
                errs.append(f"step {st.get('id')}: cites unknown source {r!r}")
        cited |= set(c)
        if refs and st.get("kind") in CLAIM_KINDS and not c:
            errs.append(f"step {st.get('id')}: uncited claim: a {st.get('kind')} step in a book-grounded lesson must cite a source")
    for r in sorted(set(refs) - cited):
        errs.append(f"source {r}: listed but never cited by a step")
    adapted = {catalog[s["source_id"]]["license"] for s in refs.values()
               if s.get("use") == "adapted" and s.get("source_id") in catalog}
    if len(adapted) > 1:
        errs.append(f"adapted sources have incompatible licences {sorted(adapted)}; adapt from one licence per lesson")
    elif adapted and lesson["license"] != next(iter(adapted)):
        errs.append(f"a lesson adapting {next(iter(adapted))} material must carry that licence, not {lesson['license']!r}")
    return errs


def check_verbatim(lesson: dict, index: ExtractIndex) -> list[str]:
    errs = []
    for text in strings_in({k: v for k, v in lesson.items() if k != "sources"}):
        for m in index.find(text, limit=1):
            errs.append(f"{lesson.get('id')}: copies text from {m.source_id} page {m.page}: \"{m.phrase}…\"")
    return errs


def check_lesson(lesson: dict, cleared_sources: set[str], all_ids: set[str], catalog: dict | None = None) -> list[str]:
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
    errs += [f"{lid}: {m}" for m in check_provenance(lesson, cleared_sources, catalog or {})]

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
    catalog = json.loads(CATALOG.read_text())["sources"] if CATALOG.is_file() else {}
    secs = json.loads(SECTIONS.read_text())["sections"] if SECTIONS.is_file() else {}
    catalog = {sid: {**c, "sections": secs.get(sid, [])} for sid, c in catalog.items()}
    for l in lessons:
        errs += check_lesson(l, cleared, set(ids), catalog)
    index = ExtractIndex()
    if index.available:
        missing = sorted(set(catalog) - set(index.shas))
        if missing:
            errs.append(f"local extracts are incomplete (missing {missing}); run python -m ingest")
        for sid in set(catalog) & set(index.shas):
            if index.shas[sid] != catalog[sid].get("sha256"):
                errs.append(f"extract of {sid} is from a different file than content/sources.json; re-extract")
        for l in lessons:
            errs += check_verbatim(l, index)
    else:
        attestation = json.loads(ATTEST.read_text()) if ATTEST.is_file() else None
        errs += check_attestation(files, attestation, catalog)

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
    n_cited = sum(1 for l in lessons if l["sources"])
    if index.available:
        att = make_attestation(files, index)
        if not ATTEST.is_file() or json.loads(ATTEST.read_text()) != att:
            ATTEST.write_text(json.dumps(att, indent=1) + "\n")
            print(f"✓ updated {ATTEST.relative_to(ROOT)} (commit it with the lessons)")
        print(f"✓ provenance: {n_cited} book-grounded lesson(s); no verbatim copying from {len(index.sources)} local extract(s)")
    else:
        print(f"✓ provenance: {n_cited} book-grounded lesson(s) cite-checked; every lesson matches {ATTEST.name} "
              f"(copy-checked where extracts exist)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
