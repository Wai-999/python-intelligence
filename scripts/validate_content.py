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

import ast
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from provenance import ExtractIndex, HashedIndex, load_index, strings_in, write_hashed_index  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "content" / "sources.json"
SECTIONS = ROOT / "content" / "source_sections.json"
_PKG_MANIFEST = json.loads((ROOT / "src" / "py" / "packages.json").read_text())
PACKAGES = {k: v for k, v in _PKG_MANIFEST.items() if not k.startswith("_")}
# The module a learner imports for each package (the same as the package name unless _import_names says otherwise).
IMPORT_NAMES = {pkg: _PKG_MANIFEST.get("_import_names", {}).get(pkg, pkg) for pkg in PACKAGES}
# Standard-library modules Pyodide ships separately (e.g. sqlite3): CPython has them built in, so the gate checks they
# import rather than comparing a pip version.
CPYTHON_MODULES = set(_PKG_MANIFEST.get("_cpython_modules", []))
STDLIB = "standard library"
# Interpreter for lesson snippets: the browser runs CPython 3.12 (Pyodide 0.27.8), so prefer a matching 3.12
# environment (PI_CONTENT_PYTHON, else the project's .venv312) over whatever runs this script.
CONTENT_PY = os.environ.get("PI_CONTENT_PYTHON") or (
    str(ROOT / ".venv312" / "bin" / "python") if (ROOT / ".venv312" / "bin" / "python").is_file() else sys.executable)
CLAIM_KINDS = {"intuition", "formal"}  # steps that state facts and so must cite, in a book-grounded lesson
USES = {"reference", "adapted"}
HARNESS = ROOT / "src" / "py" / "harness.py"
MANIFEST = ROOT / "docs" / "audit" / "source_manifest.json"
ORDER = ["motivation", "intuition", "visual", "formal", "example", "guided", "challenge", "transfer", "quiz", "summary"]
EXERCISE_KINDS = ("guided", "challenge", "transfer")
# Lessons whose master-prompt metadata (objective, analogy, misconceptions, rubric, review recall) and transfer problem
# are still being written (task G-5, in batches). Every other lesson must have them; the list only shrinks.
PENDING_META = set(json.loads((Path(__file__).resolve().parents[1] / "content" / "pending_meta.json").read_text())["lessons"])
REQUIRED_KINDS = {"motivation", "example", "quiz", "summary"}
COMMON = {"id", "kind", "title", "body"}
BY_KIND = {
    "visual": {"visual"}, "example": {"code", "expected_output"},
    "guided": {"starter", "hints", "tests", "solution"}, "challenge": {"starter", "hints", "tests", "solution"},
    "transfer": {"starter", "hints", "tests", "solution"},
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
        # Each snippet runs in its own empty temporary directory: lessons that create files (open(..., "w"))
        # must not write into the repository, and must not see each other's files.
        with tempfile.TemporaryDirectory(prefix="pi-snippet-") as tmp:
            p = subprocess.run([CONTENT_PY, "-I", "-c", RUNNER, str(HARNESS)],
                               input=json.dumps({"code": code, "tests": tests or []}),
                               capture_output=True, text=True, timeout=timeout, cwd=tmp)
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


def check_index_coverage(index, catalog: dict) -> list[str]:
    """The copy index (extracts or hashed) must cover every catalogued book at the catalogued sha256."""
    if not index.available:
        return [f"copy index unavailable ({getattr(index, 'error', None) or 'no extracts'}); "
                "run the build where extracts exist to regenerate content/provenance/"]
    errs = []
    for sid, cat in catalog.items():
        if index.shas.get(sid) != cat.get("sha256"):
            errs.append(f"copy index does not cover {sid} at sha256 {str(cat.get('sha256'))[:12]}; re-extract and rebuild")
    return errs


def check_catalog_bindings(catalog: dict, approved_shas: dict[str, str]) -> list[str]:
    """Every catalogued source must be the exact file/page its rights registry approved (by sha256)."""
    errs = []
    for sid, cat in catalog.items():
        want = approved_shas.get(sid)
        if not want:
            errs.append(f"{sid}: in content/sources.json but has no approved sha256 in a rights registry")
        elif cat.get("sha256") != want:
            errs.append(f"{sid}: content/sources.json sha256 {str(cat.get('sha256'))[:12]} != approved {want[:12]}; "
                        "re-extract and rebuild the catalog")
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
    for r, s in refs.items():
        if s.get("use") == "adapted" and catalog.get(s.get("source_id"), {}).get("reference_only"):
            errs.append(f"source {r}: {s['source_id']} is reference-only in the rights manifest; cite it, don't adapt it")
    adapted = {catalog[s["source_id"]]["license"] for s in refs.values()
               if s.get("use") == "adapted" and s.get("source_id") in catalog}
    if len(adapted) > 1:
        errs.append(f"adapted sources have incompatible licences {sorted(adapted)}; adapt from one licence per lesson")
    elif adapted and lesson["license"] != next(iter(adapted)):
        errs.append(f"a lesson adapting {next(iter(adapted))} material must carry that licence, not {lesson['license']!r}")
    return errs


def check_verbatim(lesson: dict, index: ExtractIndex | HashedIndex) -> list[str]:
    errs = []
    for text in strings_in({k: v for k, v in lesson.items() if k != "sources"}):
        for m in index.find(text, limit=1):
            errs.append(f"{lesson.get('id')}: copies text from {m.where()}: \"{m.phrase}…\"")
    return errs


def check_meta(lesson: dict) -> list[str]:
    """The master prompt's lesson metadata: an objective, one analogy, common misconceptions with corrections, a rubric,
    spaced-review metadata (a free-recall prompt) and one transfer problem. Required unless the lesson is still pending."""
    errs: list[str] = []
    text = lambda v, n=10: isinstance(v, str) and len(v.strip()) >= n
    pending = lesson.get("id") in PENDING_META
    has_any = any(k in lesson for k in ("objective", "analogy", "misconceptions", "rubric", "review"))
    transfers = [s for s in lesson.get("steps", []) if s.get("kind") == "transfer"]
    if pending and not has_any and not transfers:
        return errs
    if not text(lesson.get("objective"), 20):
        errs.append("objective: one sentence saying what the learner will be able to do")
    if not text(lesson.get("analogy"), 20):
        errs.append("analogy: one intuitive analogy for the central idea")
    mis = lesson.get("misconceptions")
    if not (isinstance(mis, list) and len(mis) >= 2 and all(isinstance(m, dict) and text(m.get("belief")) and text(m.get("correction")) for m in mis)):
        errs.append("misconceptions: at least two {belief, correction} pairs")
    rub = lesson.get("rubric")
    if not (isinstance(rub, list) and len(rub) >= 3 and all(isinstance(r, dict) and text(r.get("criterion"), 3) and text(r.get("evidence")) for r in rub)):
        errs.append("rubric: at least three {criterion, evidence} items")
    rev = lesson.get("review")
    if not (isinstance(rev, dict) and text(rev.get("recall"), 15)):
        errs.append("review: {recall: a free-recall prompt for spaced review}")
    if len(transfers) != 1:
        errs.append(f"needs exactly one transfer step (a new problem using the lesson's ideas); has {len(transfers)}")
    else:
        tagged = {t.get("concept") for t in transfers[0].get("tests", [])}
        if not tagged & set(lesson.get("concepts", [])):
            errs.append("the transfer step's tests must be tagged with the lesson's concepts")
    return errs


def interpreter_report() -> tuple[str, dict[str, str | None]]:
    """(python version, {package: installed version or None}) of CONTENT_PY."""
    code = ("import sys, json, importlib, importlib.metadata as m\nstd = set(sys.argv[1].split(','))\nv = {}\nfor n in sys.argv[2:]:\n"
            "    if n in std:\n        try:\n            importlib.import_module(n)\n            v[n] = " + repr(STDLIB) + "\n        except ImportError:\n"
            "            v[n] = None\n        continue\n    try:\n        v[n] = m.version(n)\n"
            "    except m.PackageNotFoundError:\n        v[n] = None\nprint(json.dumps([sys.version.split()[0], v]))")
    out = subprocess.run([CONTENT_PY, "-I", "-c", code, ",".join(sorted(CPYTHON_MODULES)), *PACKAGES], capture_output=True, text=True, timeout=30)
    ver, pkgs = json.loads(out.stdout)
    return ver, pkgs


def imported_roots(code: str) -> set[str]:
    """Top-level module names a snippet imports (`import a.b` -> a, `from c import d` -> c). Unparseable -> empty."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set()
    roots = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            roots |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            roots.add(node.module.split(".")[0])
    return roots


def check_packages(lesson: dict, installed: dict[str, str | None] | None) -> list[str]:
    """`packages` must be allowlisted, and the validating interpreter must have the browser's exact versions."""
    pk = lesson.get("packages", [])
    if not (isinstance(pk, list) and all(isinstance(x, str) for x in pk)):
        return ["packages must be a list of package names"]
    errs = [f"package {x!r} is not available in the browser runtime (allowed: {sorted(PACKAGES)})" for x in pk if x not in PACKAGES]
    # Every package a snippet imports must be declared, or the browser won't load it (the validator's own
    # interpreter has them all installed, so it would not notice).
    declared = set(pk) if isinstance(pk, list) else set()
    for s in lesson.get("steps", []):
        used: set[str] = set()
        for code in (s.get("code"), s.get("solution"), s.get("starter"), (s.get("visual") or {}).get("code"),
                     *[t.get("code") for t in s.get("tests", [])]):
            roots = imported_roots(code or "")
            used |= {pkg for pkg, mod in IMPORT_NAMES.items() if mod in roots}
        errs += [f"step {s.get('id')}: imports {IMPORT_NAMES[pkg]} but the lesson does not declare "
                 + ("it" if IMPORT_NAMES[pkg] == pkg else repr(pkg)) + " in packages"
                 for pkg in sorted(used - declared)]
    for x in pk:
        if x in CPYTHON_MODULES:
            if installed is not None and installed.get(x) != STDLIB:
                errs.append(f"needs the standard-library module {x} to validate, but it doesn't import")
            continue
        if x in PACKAGES and installed is not None and installed.get(x) != PACKAGES[x]:
            errs.append(f"needs {x}=={PACKAGES[x]} (the browser's version) to validate, found {installed.get(x)}; "
                        "use .venv312 or set PI_CONTENT_PYTHON")
    return errs


def check_lesson(lesson: dict, cleared_sources: set[str], all_ids: set[str], catalog: dict | None = None,
                 installed: dict[str, str | None] | None = None) -> list[str]:
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
    errs += [f"{lid}: {m}" for m in check_packages(lesson, installed)]

    steps = lesson["steps"]
    kinds = [s.get("kind") for s in steps]
    errs += [f"{lid}: {m}" for m in check_meta(lesson)]
    if not REQUIRED_KINDS <= set(kinds) or not any(k in EXERCISE_KINDS for k in kinds):
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
        elif k in EXERCISE_KINDS:
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



DIAGNOSTIC = ROOT / "content" / "diagnostic.json"
QUESTION_FIELDS = {"id", "lesson", "concept", "prompt", "choices", "answer", "explanation"}


def check_diagnostic(diag, lessons: dict[str, dict]) -> list[str]:
    """The placement check (src/curriculum/placement.ts). Checkpoints are walked in order and testing out of one unlocks
    what follows its lessons, so each checkpoint's lessons must have every prerequisite covered by it or an earlier one.
    Every predicted output is run in CPython and must be exactly the marked choice."""
    errs: list[str] = []
    if not isinstance(diag, dict) or not isinstance(diag.get("version"), int) or not isinstance(diag.get("checkpoints"), list) or not diag["checkpoints"]:
        return ["diagnostic: needs an integer version and a nonempty checkpoints list"]
    covered: set[str] = set()
    cp_ids: set[str] = set()
    q_ids: set[str] = set()
    for cp in diag["checkpoints"]:
        where = f"diagnostic/{cp.get('id')}"
        if not isinstance(cp.get("id"), str) or not cp["id"] or cp["id"] in cp_ids:
            errs.append(f"{where}: checkpoint ids must be unique nonempty strings")
        cp_ids.add(cp.get("id"))
        if not isinstance(cp.get("title"), str) or not cp["title"].strip():
            errs.append(f"{where}: needs a title")
        covers = cp.get("covers")
        if not isinstance(covers, list) or not covers:
            errs.append(f"{where}: covers must be a nonempty list of lesson ids")
            covers = []
        here = set()
        for lid in covers:
            if lid not in lessons:
                errs.append(f"{where}: unknown lesson {lid}")
            elif lid in covered or lid in here:
                errs.append(f"{where}: lesson {lid} is covered by more than one checkpoint")
            here.add(lid)
        for lid in covers:
            for pre in lessons.get(lid, {}).get("prerequisites", []):
                if pre not in covered and pre not in here:
                    errs.append(f"{where}: {lid} needs {pre}, which no earlier checkpoint covers (testing out would skip it)")
        covered |= here
        qs = cp.get("questions")
        if not isinstance(qs, list) or not qs:
            errs.append(f"{where}: needs questions")
            continue
        asked = {q.get("lesson") for q in qs if isinstance(q, dict)}
        for lid in covers:
            if lid not in asked:
                errs.append(f"{where}: {lid} has no question of its own, so a learner could test out of it untested")
        for q in qs:
            qw = f"{where}/{q.get('id')}"
            missing = QUESTION_FIELDS - set(q)
            if missing:
                errs.append(f"{qw}: missing {sorted(missing)}")
                continue
            if q["id"] in q_ids:
                errs.append(f"{qw}: question ids must be unique across the diagnostic")
            q_ids.add(q["id"])
            if ":" in q["id"]:
                errs.append(f"{qw}: question ids can't contain ':' (it separates the run id in event step ids)")
            if q["lesson"] not in here:
                errs.append(f"{qw}: lesson {q['lesson']} is not one this checkpoint covers")
            elif q["concept"] not in lessons[q["lesson"]]["concepts"]:
                errs.append(f"{qw}: concept {q['concept']} is not taught by {q['lesson']}")
            ch = q["choices"]
            if not isinstance(ch, list) or len(ch) < 2 or len(set(ch)) != len(ch) or not all(isinstance(c, str) and c.strip() for c in ch):
                errs.append(f"{qw}: needs two or more distinct nonempty choices")
                continue
            if any(c.strip().lower() == "not sure" for c in ch):
                errs.append(f"{qw}: 'Not sure' is added by the app; don't list it as a choice")
            if not isinstance(q["answer"], int) or isinstance(q["answer"], bool) or not 0 <= q["answer"] < len(ch):
                errs.append(f"{qw}: answer must index a choice")
                continue
            if not q["explanation"].strip() or not q["prompt"].strip():
                errs.append(f"{qw}: needs a prompt and an explanation")
            if q.get("output"):
                if not isinstance(q.get("code"), str) or not q["code"].strip():
                    errs.append(f"{qw}: an output question needs code")
                    continue
                res = run_snippet(q["code"])
                out = res.get("stdout", "").rstrip("\n")
                if not res.get("ok"):
                    errs.append(f"{qw}: code failed: {res.get('error')}")
                elif out != ch[q["answer"]]:  # choices are distinct, so no other choice can match too
                    errs.append(f"{qw}: the code prints {out!r}, not the marked choice {ch[q['answer']]!r}")
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
    approved = {s["source_id"]: s.get("sha256") for s in manifest["sources"] if s.get("allowed_for_internal_extraction")}
    web = ROOT / "docs" / "audit" / "web_sources.json"
    if web.is_file():  # official documentation pages, cleared in their own registry
        for s in json.loads(web.read_text())["sources"]:
            if s.get("allowed_for_internal_extraction") and s.get("rights_verified") and s.get("decision"):
                cleared.add(s["source_id"])
                approved[s["source_id"]] = s.get("sha256")
    ids = [l.get("id") for l in lessons]
    if len(set(ids)) != len(ids):
        errs.append("duplicate lesson ids")
    catalog = json.loads(CATALOG.read_text())["sources"] if CATALOG.is_file() else {}
    secs = json.loads(SECTIONS.read_text())["sections"] if SECTIONS.is_file() else {}
    # reference_only comes from the rights manifest (the authority), never from the generated catalog.
    ref_only = {s["source_id"] for s in manifest["sources"] if s.get("reference_only")}
    catalog = {sid: {**c, "sections": secs.get(sid, []), "reference_only": sid in ref_only} for sid, c in catalog.items()}
    errs += check_catalog_bindings(catalog, approved)
    py_version, installed = interpreter_report()
    if not py_version.startswith("3.12."):
        print(f"✗ lesson snippets must be validated with CPython 3.12 (the browser's Pyodide runs 3.12); {CONTENT_PY} is "
              f"{py_version}. Create .venv312 (see README) or set PI_CONTENT_PYTHON.")
        return 1
    for l in lessons:
        errs += check_lesson(l, cleared, set(ids), catalog, installed)
    index = load_index()
    errs += check_index_coverage(index, catalog)
    for l in lessons:
        errs += check_verbatim(l, index)

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

    errs += check_diagnostic(json.loads(DIAGNOSTIC.read_text()), {l["id"]: l for l in lessons})

    if errs:
        print("\n".join(f"✗ {e}" for e in errs))
        print(f"content invalid: {len(errs)} error(s)", file=sys.stderr)
        return 1
    n_exec = sum(1 for l in lessons for s in l["steps"] if s["kind"] in ("example", "visual", *EXERCISE_KINDS))
    print(f"✓ content valid: {len(lessons)} lessons, {n_exec} executable steps verified with the shared harness "
          f"(CPython {py_version})")
    print(f"✓ placement check: {sum(len(c['questions']) for c in json.loads(DIAGNOSTIC.read_text())['checkpoints'])} questions, "
          f"predicted outputs verified")
    n_cited = sum(1 for l in lessons if l["sources"])
    if isinstance(index, ExtractIndex):
        if write_hashed_index(index):
            print("✓ regenerated content/provenance/ hashed copy index (commit it)")
        print(f"✓ provenance: {n_cited} book-grounded lesson(s); no copying from {len(index.sources)} local extract(s)")
    else:
        print(f"✓ provenance: {n_cited} book-grounded lesson(s); no copying (hashed index of {len(index.sources)} book(s))")
    return 0


if __name__ == "__main__":
    sys.exit(main())
