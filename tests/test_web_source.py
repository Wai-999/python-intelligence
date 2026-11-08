"""Official-docs sources: Sphinx pages split into numbered sections that citations and the copy check can use."""
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("fetch_web_source", ROOT / "scripts" / "fetch_web_source.py")
fw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fw)

PAGE = """<html><head><script>var x = "not text";</script></head><body>
<nav>Navigation junk</nav>
<div class="body" role="main">
<section id="built-in-types"><h1>Built-in Types<a class="headerlink" href="#built-in-types">¶</a></h1>
<p>Intro paragraph.</p>
<section id="mapping-types-dict"><h2>Mapping Types — <code>dict</code><a class="headerlink" href="#x">¶</a></h2>
<p>Dictionaries keep insertion order.</p>
<section id="dictionary-view-objects"><h3>Dictionary view objects</h3><p>Views are dynamic.</p></section>
</section>
</section>
</div>
<footer>Copyright footer</footer></body></html>"""


def test_sections_become_numbered_pages_with_titles_anchors_and_own_text():
    records, toc = fw.to_records(PAGE, "docs", "ab" * 32)
    assert toc == [[1, "Built-in Types", 1], [2, "Mapping Types — dict", 2], [3, "Dictionary view objects", 3]]
    assert [r["anchor"] for r in records] == ["built-in-types", "mapping-types-dict", "dictionary-view-objects"]
    assert "insertion order" in records[1]["text"] and "Views are dynamic" not in records[1]["text"]
    joined = " ".join(r["text"] for r in records)
    for junk in ("not text", "Navigation junk", "Copyright footer", "¶"):
        assert junk not in joined
    assert all(r["sha256"] == "ab" * 32 and r["source_id"] == "docs" for r in records)


def test_web_registry_entries_are_cleared_with_a_recorded_decision():
    reg = json.loads((ROOT / "docs" / "audit" / "web_sources.json").read_text())
    for s in reg["sources"]:
        assert s["allowed_to_publish"] is False
        if s["allowed_for_internal_extraction"]:
            assert s["rights_verified"] and s["decision"]["by"] and s["decision"]["basis"]
            assert s["url"].startswith("https://docs.python.org/3.12/"), "pin docs to the Pyodide CPython version"
            assert len(s["sha256"]) == 64


def test_catalog_lists_web_sources_with_section_anchors():
    cat = json.loads((ROOT / "content" / "sources.json").read_text())["sources"]
    docs = cat["pydocs-312-stdtypes"]
    assert docs["kind"] == "web" and docs["anchors"]["30"] == "mapping-types-dict"


def test_parent_text_after_a_nested_section_stays_with_the_parent():
    html = """<div role="main"><section id="a"><h2>A</h2><p>before</p>
    <section id="b"><h3>B</h3><p>inner</p></section>
    <p>after the child</p></section></div>"""
    records, toc = fw.to_records(html, "d", "0" * 64)
    assert toc == [[1, "A", 1], [2, "B", 2]]
    assert "after the child" in records[0]["text"] and "after the child" not in records[1]["text"]
    assert records[1]["text"] == "inner"


def test_sections_and_headings_inside_skipped_subtrees_are_ignored():
    html = """<div role="main"><section id="a"><h2>A</h2><p>real</p>
    <nav><section id="fake"><h2>Fake</h2><p>menu</p></section></nav><p>tail</p></section></div>"""
    records, toc = fw.to_records(html, "d", "0" * 64)
    assert toc == [[1, "A", 1]]
    assert "menu" not in records[0]["text"] and "tail" in records[0]["text"]


vspec = importlib.util.spec_from_file_location("validate_content", ROOT / "scripts" / "validate_content.py")
vc = importlib.util.module_from_spec(vspec)
vspec.loader.exec_module(vc)


def test_catalog_must_match_the_registry_approved_sha():
    cat = {"docs": {"sha256": "aa" * 32}, "book": {"sha256": "bb" * 32}}
    assert vc.check_catalog_bindings(cat, {"docs": "aa" * 32, "book": "bb" * 32}) == []
    errs = vc.check_catalog_bindings(cat, {"docs": "cc" * 32, "book": "bb" * 32})   # registry re-approved a new page
    assert len(errs) == 1 and errs[0].startswith("docs: content/sources.json sha256")
    assert "no approved sha256" in vc.check_catalog_bindings(cat, {"book": "bb" * 32})[0]
