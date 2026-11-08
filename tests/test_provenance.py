"""Provenance gate: citations must point at real pages/sections of cleared sources, and lessons must not copy."""
import copy
import importlib.util
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
spec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vc)
import provenance  # noqa: E402

IDS = {"py-values-names", "py-functions", "py-scope-defaults"}
CLEARED = {"book-a", "book-b"}
CATALOG = {
    "book-a": {"short": "Book A", "license": "CC BY-NC 3.0", "page_count": 100,
               "sections": [[1, "Functions", 10], [2, "Parameters", 12], [1, "Loops", 30]]},
    "book-b": {"short": "Book B", "license": "CC BY-SA 3.0", "page_count": 50,
               "sections": [[1, "Calling things", 5]]},
}


def grounded():
    l = json.loads((ROOT / "content" / "lessons" / "py-functions.json").read_text())
    l["sources"] = [
        {"id": "a", "source_id": "book-a", "pages": [10, 14], "section": "Parameters", "use": "reference"},
        {"id": "b", "source_id": "book-b", "pages": [5, 6], "section": "Calling things", "use": "reference"},
    ]
    for s in l["steps"]:
        if s["kind"] == "intuition":
            s["cites"] = ["a"]
        elif s["kind"] == "formal":
            s["cites"] = ["a", "b"]
    return l


def errs(mutate=lambda l: None, catalog=CATALOG):
    l = grounded()
    mutate(l)
    return vc.check_lesson(l, CLEARED, IDS, catalog)


def kind(l, k):
    return next(s for s in l["steps"] if s["kind"] == k)


def test_well_cited_lesson_passes():
    assert errs() == []


def test_original_lessons_still_pass_without_sources():
    for f in (ROOT / "content" / "lessons").glob("*.json"):
        l = json.loads(f.read_text())
        if not l["sources"]:
            assert vc.check_provenance(l, set(), {}) == []


@pytest.mark.parametrize("mutate,expect", [
    (lambda l: kind(l, "formal").pop("cites"), "uncited claim"),
    (lambda l: kind(l, "intuition").__setitem__("cites", ["zzz"]), "cites unknown source"),
    (lambda l: kind(l, "formal").__setitem__("cites", ["a"]), "source b: listed but never cited"),
    (lambda l: l["sources"][0].__setitem__("section", "Loops"), "is not a heading of Book A overlapping pages"),
    (lambda l: l["sources"][0].__setitem__("pages", [90, 120]), "beyond the end of Book A"),
    (lambda l: l["sources"][0].__setitem__("pages", [14, 10]), "valid [start, end] page range"),
    (lambda l: l["sources"][0].__setitem__("source_id", "book-x"), "not cleared"),
    (lambda l: l["sources"][0].__setitem__("use", "inspired"), "use must be one of"),
    (lambda l: l["sources"][1].__setitem__("id", "a"), "duplicate source id"),
    (lambda l: [s.__setitem__("use", "adapted") for s in l["sources"]], "incompatible licences"),
    (lambda l: l["sources"][0].__setitem__("use", "adapted"), "must carry that licence"),
])
def test_bad_citations_are_rejected(mutate, expect):
    e = errs(mutate)
    assert any(expect in x for x in e), e


def test_source_missing_from_catalog_is_rejected():
    e = errs(catalog={"book-b": CATALOG["book-b"]})
    assert any("not in content/sources.json" in x for x in e), e


def test_adapted_with_matching_licence_passes():
    def m(l):
        l["sources"][0]["use"] = "adapted"
        l["license"] = "CC BY-NC 3.0"
    assert errs(m) == []


@pytest.fixture
def index(tmp_path):
    d = tmp_path / "book-a"
    d.mkdir()
    page = ("Python is a language in which a function is a named sequence of statements that "
            "performs a computation and you can call it by name later on")
    (d / "pages.jsonl").write_text(json.dumps({"page": 12, "text": page}) + "\n")
    return provenance.ExtractIndex(tmp_path)


def test_verbatim_copy_is_caught(index):
    l = grounded()
    kind(l, "intuition")["body"] = "As the book says, a function is a named sequence of statements that performs a computation."
    e = vc.check_verbatim(l, index)
    assert e and "copies text from book-a page 12" in e[0], e


def test_short_overlap_and_original_text_pass(index):
    l = grounded()
    kind(l, "intuition")["body"] = "A function is a named sequence of statements; it runs when called."  # 9 shared words
    assert vc.check_verbatim(l, index) == []
    assert vc.check_verbatim(grounded(), index) == []


def test_copy_spanning_newlines_and_case_is_caught(index):
    l = grounded()
    kind(l, "formal")["body"] = "A FUNCTION is a named\nsequence of statements that\nperforms a computation and you can call it"
    assert vc.check_verbatim(l, index)


def test_missing_extracts_disable_only_the_verbatim_check(tmp_path):
    idx = provenance.ExtractIndex(tmp_path / "none")
    assert not idx.available and vc.check_verbatim(grounded(), idx) == []


# --- dist gate ------------------------------------------------------------------------------------------
cd_spec = importlib.util.spec_from_file_location("check_dist", ROOT / "scripts" / "check_dist.py")
check_dist = importlib.util.module_from_spec(cd_spec)
cd_spec.loader.exec_module(check_dist)


def make_dist(tmp_path, js):
    d = tmp_path / "dist"
    (d / "assets").mkdir(parents=True)
    (d / "index.html").write_text("<title>Python Intelligence</title>")
    (d / "assets" / "index.js").write_text(js)
    return d


def test_dist_gate_passes_original_bundle(tmp_path, index):
    assert check_dist.main(str(make_dist(tmp_path, "const s='Functions run when you call them.'")), index) == 0


def test_dist_gate_blocks_copied_text(tmp_path, index, capsys):
    js = "const s='a function is a named sequence of statements that performs a computation and you can call it'"
    assert check_dist.main(str(make_dist(tmp_path, js)), index) == 1
    assert "copied from book-a page 12" in capsys.readouterr().out


@pytest.mark.parametrize("name", ["pages.jsonl", "review_queue.json", "book.pdf"])
def test_dist_gate_blocks_extract_files(tmp_path, index, name):
    d = make_dist(tmp_path, "")
    (d / name).write_text("{}")
    assert check_dist.main(str(d), index) == 1


# --- review follow-ups (Codex cross-review of 57fbba8) ---------------------------------------------------
def test_section_may_start_before_the_cited_pages():
    # "Functions" (level 1) starts on p.10 and runs until "Loops" on p.30, so pp. 20-21 lie inside it.
    assert errs(lambda l: l["sources"][0].update(pages=[20, 21], section="Functions")) == []
    # "Parameters" (level 2) runs 12..29 too, but "Loops" (p.30..100) does not overlap pp. 10-14.
    assert any("overlapping pages" in e for e in errs(lambda l: l["sources"][0].update(section="Loops")))


def test_section_spans():
    spans = vc.section_spans([[1, "A", 10], [2, "A.1", 12], [2, "A.2", 15], [1, "B", 30]], 100)
    assert spans == [("A", 10, 29), ("A.1", 12, 14), ("A.2", 15, 29), ("B", 30, 100)]


def test_dist_gate_sees_through_js_string_escapes(tmp_path, index):
    js = r'const s="a function is a named\nsequence of statements that performs a computation and you can call it"'
    assert check_dist.main(str(make_dist(tmp_path, js)), index) == 1


@pytest.fixture
def lesson_files(tmp_path):
    d = tmp_path / "lessons"
    d.mkdir()
    (d / "one.json").write_text('{"id": "one"}')
    (d / "two.json").write_text('{"id": "two"}')
    return sorted(d.glob("*.json"))


def test_attestation_round_trip_and_change_detection(lesson_files, index):
    index.shas = {"book-a": "aa" * 32}
    cat = {"book-a": {"sha256": "aa" * 32}}
    att = vc.make_attestation(lesson_files, index)
    assert vc.check_attestation(lesson_files, att, cat) == []
    lesson_files[1].write_text('{"id": "two", "body": "edited"}')
    e = vc.check_attestation(lesson_files, att, cat)
    assert len(e) == 1 and e[0].startswith("two: changed since its last copy check"), e


def test_attestation_must_cover_every_catalogued_book_and_exist(lesson_files, index):
    index.shas = {"book-a": "aa" * 32}
    att = vc.make_attestation(lesson_files, index)
    cat = {"book-a": {"sha256": "aa" * 32}, "book-b": {"sha256": "bb" * 32}}
    assert any("does not cover book-b" in e for e in vc.check_attestation(lesson_files, att, cat))
    assert any("re-run the copy check" in e for e in vc.check_attestation(lesson_files, att, {"book-a": {"sha256": "cc" * 32}}))
    assert "no provenance_attestation.json" in vc.check_attestation(lesson_files, None, cat)[0]
