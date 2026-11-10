import json
from pathlib import Path
import subprocess
import sys

import pymupdf
import pytest

from ingest.extract import IngestError, extract, extract_from_manifest, score_page, sha256_file


@pytest.fixture
def pdf(tmp_path):
    path = tmp_path / "fixture.pdf"
    with pymupdf.open() as doc:
        prose = "This is a normal prose paragraph explaining Python functions.\n" * 5
        doc.new_page().insert_text((50, 50), prose)
        page = doc.new_page()
        page.insert_text((50, 50), prose)
        page.insert_text((50, 170), "def square(x):\n    return x * x", fontname="cour")
        doc.new_page()
        doc.new_page().insert_text((50, 50), "Hi")
        doc.set_page_labels([{"startpage": 0, "prefix": "", "style": "D", "firstpagenum": 1}])
        doc.set_toc([[1, "Functions", 1]])
        doc.save(path)
    return path


def test_extract(pdf, tmp_path):
    out = tmp_path / "out"
    meta = extract(pdf, "book", out, expected_sha256=sha256_file(pdf))
    target = out / "book"
    assert {p.name for p in target.iterdir()} == {"pages.jsonl", "meta.json", "review_queue.json"}
    original = (target / "pages.jsonl").read_bytes()
    rows = [json.loads(line) for line in original.splitlines()]
    keys = {"source_id", "sha256", "page", "label", "text", "chars", "extraction_quality", "flags", "code_blocks"}
    for index, row in enumerate(rows, 1):
        assert set(row) == keys
        assert row["page"] == index and row["label"] == str(index)
        assert row["source_id"] == "book" and row["sha256"] == sha256_file(pdf)
        assert row["chars"] == len(row["text"])
        assert 0 <= row["extraction_quality"] <= 1
        assert row["flags"] == sorted(row["flags"])
    assert rows[0]["extraction_quality"] >= .9
    assert rows[1]["code_blocks"] == ["def square(x):\n    return x * x"]
    assert all(not rows[i]["code_blocks"] for i in (0, 2, 3))
    assert rows[2]["extraction_quality"] == 0 and "no_text" in rows[2]["flags"]
    assert "sparse" in rows[3]["flags"]
    queue = json.loads((target / "review_queue.json").read_text())
    assert [r["page"] for r in queue] == [3, 4]
    assert all(set(r) == {"page", "label", "extraction_quality", "flags"} for r in queue)
    assert meta == json.loads((target / "meta.json").read_text())
    assert meta["toc"] == [[1, "Functions", 1]]
    assert meta["quality"]["low_pages"] == 2
    extract(pdf, "book", out, expected_sha256=sha256_file(pdf))
    assert (target / "pages.jsonl").read_bytes() == original


def test_hash_before_open(pdf, tmp_path, monkeypatch):
    def fail(*args, **kwargs):
        pytest.fail("PDF opened before hash was verified")
    monkeypatch.setattr(pymupdf, "open", fail)
    with pytest.raises(IngestError, match="SHA256 mismatch"):
        extract(pdf, "book", tmp_path / "out", expected_sha256="0" * 64)
    assert not (tmp_path / "out").exists()


def test_scores():
    assert score_page(" \n", True) == (0.0, ["image_only", "no_text"])
    assert score_page("", False) == (0.0, ["no_text"])
    score, flags = score_page("1234" * 20, False)
    assert score <= .5 and "low_alpha" in flags
    score, flags = score_page("a" * 80 + "\ufffd" * 20, False)
    assert score == .8 and flags == ["replacement_chars"]


def test_manifest_and_cli(pdf, tmp_path):
    manifest = tmp_path / "manifest.json"
    cleared = cleared_source(pdf)
    manifest.write_text(json.dumps({"sources": [cleared,
        dict(cleared, source_id="denied", allowed_for_internal_extraction=False),
        dict(cleared, source_id="missing", downloaded=False)]}))
    out = tmp_path / "out"
    assert len(extract_from_manifest(manifest, out, repo_root=tmp_path)) == 1
    assert {p.name for p in out.iterdir()} == {"book"}
    for only in ("denied", "missing", "unknown"):
        with pytest.raises(IngestError):
            extract_from_manifest(manifest, out, only=only, repo_root=tmp_path)
    manifest.write_text(json.dumps({"sources": [cleared]}))
    command = [sys.executable, "-m", "ingest", "--manifest", str(manifest), "--out", str(out), "--repo-root", str(tmp_path)]
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True)
    assert result.returncode == 0 and "book: 4 pages" in result.stdout
    result = subprocess.run(command + ["--only", "unknown"], cwd=root, text=True, capture_output=True)
    assert result.returncode == 1 and "unknown" in result.stderr


def test_bad_inputs(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"not a PDF")
    with pytest.raises(IngestError):
        extract(bad, "book", tmp_path / "out", expected_sha256=sha256_file(bad))
    assert not (tmp_path / "out").exists()
    with pytest.raises(IngestError):
        extract(bad, "../escape", tmp_path, expected_sha256=sha256_file(bad))
    manifest = tmp_path / "bad.json"
    manifest.write_text("{broken")
    with pytest.raises(IngestError, match="Invalid manifest"):
        extract_from_manifest(manifest, tmp_path)


def cleared_source(pdf, **overrides):
    return dict(dict(source_id="book", local_path=pdf.name, sha256=sha256_file(pdf),
                     repo="fixture/repo", path="books/fixture.pdf", commit_sha="a" * 40,
                     git_blob_sha1="b" * 40, size_bytes=pdf.stat().st_size,
                     rights_status="permitted", rights_verified=True, allowed_to_publish=False,
                     decision=dict(by="Owner", date="2026-11-08", basis="Synthetic test fixture"),
                     allowed_for_internal_extraction=True, downloaded=True), **overrides)


@pytest.mark.parametrize("change,match", [
    ({"rights_verified": False}, "rights_verified"),
    ({"decision": None}, "decision"),
    ({"local_path": "/fixture.pdf"}, "local_path"),
    ({"local_path": "../fixture.pdf"}, "local_path"),
])
def test_manifest_rejects_unsafe_source(pdf, tmp_path, change, match):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sources": [cleared_source(pdf, **change)]}))
    with pytest.raises(IngestError, match=match):
        extract_from_manifest(manifest, tmp_path / "out", repo_root=tmp_path)
    assert not (tmp_path / "out").exists()


def test_duplicate_source(pdf, tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sources": [cleared_source(pdf)] * 2}))
    with pytest.raises(IngestError, match="duplicate source_id"):
        extract_from_manifest(manifest, tmp_path / "out", only="book", repo_root=tmp_path)


def test_parse_hashed_bytes(pdf, tmp_path, monkeypatch):
    original = pymupdf.open
    data = pdf.read_bytes()
    def check(*args, **kwargs):
        assert not args
        assert kwargs == dict(stream=data, filetype="pdf")
        pdf.write_bytes(b"replaced after reading")
        return original(**kwargs)
    monkeypatch.setattr(pymupdf, "open", check)
    assert extract(pdf, "book", tmp_path / "out", expected_sha256=sha256_file(pdf))["page_count"] == 4


def test_listing_across_pdf_blocks(tmp_path):
    path = tmp_path / "listing.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 50), "def square(x):", fontname="cour")
        page.insert_text((50, 75), "    return x * x", fontname="cour")
        assert len(page.get_text("dict")["blocks"]) == 2
        doc.save(path)
    extract(path, "listing", tmp_path / "out", expected_sha256=sha256_file(path))
    row = json.loads((tmp_path / "out/listing/pages.jsonl").read_text())
    assert row["code_blocks"] == ["def square(x):\n    return x * x"]


def test_whitespace_code_lines():
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            return {"blocks": [{"lines": [
                {"spans": [{"text": text, "flags": flags}]} for text, flags in
                [("x = 1", 8), ("   ", 8), ("y = 2", 8), ("prose", 0), ("z = 3", 8)]
            ]}]}
    assert _code_blocks(Page()) == ["x = 1\ny = 2", "z = 3"]


def test_cli_reports_before_later_failure(pdf, tmp_path, capsys):
    from ingest.__main__ import main
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sources": [cleared_source(pdf),
        cleared_source(pdf, source_id="bad", sha256="0" * 64)]}))
    assert main(["--manifest", str(manifest), "--repo-root", str(tmp_path)]) == 1
    captured = capsys.readouterr()
    assert "book: 4 pages" in captured.out
    assert "SHA256 mismatch for bad" in captured.err
    assert (tmp_path / "sources/extracts/book/meta.json").exists()


def test_git_output_guard(tmp_path):
    from ingest.__main__ import _check_output
    subprocess.run(["git", "init", str(tmp_path)], check=True, capture_output=True)
    (tmp_path / ".gitignore").write_text("sources/\n")
    _check_output(tmp_path / "sources/extracts")
    with pytest.raises(IngestError, match="ignored by git"):
        _check_output(tmp_path / "extracted")


def test_output_outside_repo_and_without_git(tmp_path, monkeypatch):
    from ingest.__main__ import _check_output
    _check_output(tmp_path / "external")
    def unavailable(*args, **kwargs):
        raise FileNotFoundError("git unavailable")
    monkeypatch.setattr(subprocess, "run", unavailable)
    _check_output(tmp_path / "output")


def test_positioned_indentation(tmp_path):
    path = tmp_path / "positioned.pdf"
    with pymupdf.open() as doc:
        page = doc.new_page()
        for x, y, text in [(50, 50, 'def square(x):'),
                           (76.4, 65, 'if x:'),
                           (102.8, 80, 'return x * x')]:
            page.insert_text((x, y), text, fontname='cour', fontsize=11)
        doc.save(path)
    extract(path, 'book', tmp_path / 'out', expected_sha256=sha256_file(path))
    row = json.loads((tmp_path / 'out/book/pages.jsonl').read_text())
    code = row['code_blocks'][0]
    assert code == 'def square(x):\n    if x:\n        return x * x'
    compile(code, '<extracted>', 'exec')


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('failure', ['write', 'publish'])
def test_directory_failure_preserves_output(pdf, tmp_path, monkeypatch, existing, failure):
    import importlib
    module = importlib.import_module('ingest.extract')
    out = tmp_path / 'out'
    target = out / 'book'
    if existing:
        extract(pdf, 'book', out, expected_sha256=sha256_file(pdf))
        (target / 'old-marker').write_text('previous generation')
    before = {p.name: p.read_bytes() for p in target.iterdir()} if existing else None
    original_write = open
    original_replace = module.os.replace

    def write(path, *args, **kwargs):
        if Path(path).name == 'meta.json':
            raise OSError('injected write failure')
        return original_write(path, *args, **kwargs)

    def replace(source, dest):
        if Path(source).name == 'new':
            assert {p.name for p in Path(source).iterdir()} == {'pages.jsonl', 'meta.json', 'review_queue.json'}
            raise OSError('injected publish failure')
        return original_replace(source, dest)

    if failure == 'write':
        monkeypatch.setattr(module, 'open', write, raising=False)
    else:
        monkeypatch.setattr(module.os, 'replace', replace)
    with pytest.raises(IngestError, match='injected'):
        extract(pdf, 'book', out, expected_sha256=sha256_file(pdf))
    if existing:
        assert {p.name: p.read_bytes() for p in target.iterdir()} == before
    else:
        assert not target.exists()
    assert {p.name for p in out.iterdir()} == ({'book'} if existing else set())


def test_directory_replacement_removes_stale_artifacts(pdf, tmp_path):
    out = tmp_path / 'out'
    extract(pdf, 'book', out, expected_sha256=sha256_file(pdf))
    (out / 'book/stale').write_text('old')
    extract(pdf, 'book', out, expected_sha256=sha256_file(pdf))
    assert {p.name for p in (out / 'book').iterdir()} == {'pages.jsonl', 'meta.json', 'review_queue.json'}


@pytest.mark.parametrize("source_id", ["book\n", "book\t", "book\x00", "book\u200b"])
def test_control_character_id(pdf, tmp_path, source_id):
    with pytest.raises(IngestError, match="source_id"):
        extract(pdf, source_id, tmp_path / "out", expected_sha256=sha256_file(pdf))
    assert not (tmp_path / "out").exists()


def test_case_collision_before_extraction(pdf, tmp_path):
    manifest = tmp_path / "manifest.json"
    manifest.write_text(json.dumps({"sources": [cleared_source(pdf), cleared_source(pdf, source_id="BOOK")]}))
    with pytest.raises(IngestError, match="Case-colliding"):
        extract_from_manifest(manifest, tmp_path / "out", repo_root=tmp_path)
    assert not (tmp_path / "out").exists()


def test_helvetica_colon(tmp_path):
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 50), "def square(x)", fontname="cour", fontsize=11)
        page.insert_text((50 + 13 * 6.6, 50), ":", fontname="helv", fontsize=11)
        page.insert_text((50, 65), "    return x * x", fontname="cour", fontsize=11)
        blocks = _code_blocks(page)
    assert blocks == ["def square(x):\n    return x * x"]
    compile(blocks[0], "<pdf>", "exec")


@pytest.mark.parametrize("gap,expected", [(15, ["x = 1\ny = 2\nz = 3"]),
                                           (80, ["x = 1\ny = 2", "z = 3"])])
def test_listing_vertical_gap(gap, expected):
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        for x, y, text in [(50, 50, "x = 1"), (50, 65, "y = 2"), (50, 65 + gap, "z = 3")]:
            page.insert_text((x, y), text, fontname="cour", fontsize=11)
        assert _code_blocks(page) == expected


def test_literal_and_positioned_indentation():
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        for x, y, text in [(50, 50, "def f():"), (50, 65, "    if True:"),
                           (102.8, 80, "return 1")]:
            page.insert_text((x, y), text, fontname="cour", fontsize=11)
        blocks = _code_blocks(page)
    assert blocks == ["def f():\n    if True:\n        return 1"]
    compile(blocks[0], "<pdf>", "exec")


def test_publish_recovers_interrupted_swap(tmp_path):
    from ingest.extract import _publish
    target = tmp_path / "book"
    workspace = tmp_path / ".book.tmp-crashed"
    (workspace / "old").mkdir(parents=True)
    (workspace / "old/marker").write_text("previous")
    (workspace / "target.json").write_text(json.dumps("book"))
    # Fail staging after recovery; the restored generation must remain usable.
    with pytest.raises(TypeError):
        _publish(target, {"pages.jsonl": None})
    assert (target / "marker").read_text() == "previous"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book"]


def test_failed_rollback_retains_nested_backup(tmp_path, monkeypatch):
    import importlib
    module = importlib.import_module("ingest.extract")
    target = tmp_path / "book"
    target.mkdir()
    (target / "pages.jsonl").write_text("previous")
    replace = module.os.replace
    def fail(source, dest):
        if Path(source).name in {"new", "old"}:
            raise OSError("injected rename failure")
        return replace(source, dest)
    monkeypatch.setattr(module.os, "replace", fail)
    with pytest.raises(IngestError, match="rollback failed"):
        module._publish(target, {"pages.jsonl": "next"})
    backups = list(tmp_path.glob(".book.tmp-*/old/pages.jsonl"))
    assert len(backups) == 1 and backups[0].read_text() == "previous"
    assert not list(tmp_path.glob("*/pages.jsonl"))
    monkeypatch.setattr(module.os, "replace", replace)
    module._publish(target, {"pages.jsonl": "next"})
    assert (target / "pages.jsonl").read_text() == "next"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["book"]


@pytest.mark.parametrize("advance", [5.5, 6.05, 6.6])
@pytest.mark.parametrize("prefix", ["", "    ", "1 "])
def test_raw_glyph_indentation(advance, prefix):
    from ingest.extract import _code_blocks
    def span(text, x, flags=8):
        return dict(flags=flags, bbox=(x, 0, x + len(text) * advance, 12),
                    chars=[dict(c=c, bbox=(x+i*advance, 0, x+(i+1)*advance, 12))
                           for i, c in enumerate(text)])
    class Page:
        def get_text(self, kind):
            assert kind == "rawdict"
            return {"blocks": [{"lines": [
                {"spans": [span("def f():", 50)]},
                {"spans": ([span(prefix, 50, 0)] if prefix else []) +
                    [span("return 123456789", 50 + len(prefix)*advance)]},
                {"spans": [span("value = 1", 50 + 4*advance)]},
            ]}]}
    assert _code_blocks(Page()) == ["def f():\n" + prefix + "return 123456789\n    value = 1"]


def test_tab_does_not_distort_positioned_indent():
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            def span(text, x):
                return dict(flags=8, bbox=(x, 0, x+100, 12), chars=[
                    dict(c=c, bbox=(x+i*5.5, 0, x+(i+1)*5.5, 12))
                    for i, c in enumerate(text)])
            return {"blocks": [{"lines": [
                {"spans": [span("\tvalue = 1", 50)]},
                {"spans": [span("other = 2", 72)]},
                {"spans": [dict(text="\t\u00a0", flags=8), dict(text="!", flags=0)]},
            ]}]}
    assert _code_blocks(Page()) == ["\tvalue = 1\n    other = 2"]


def test_publish_syncs_files_and_directories(tmp_path, monkeypatch):
    import importlib
    import stat
    module = importlib.import_module('ingest.extract')
    synced = []
    original = module.os.fsync
    def sync(fd):
        synced.append(stat.S_ISDIR(module.os.fstat(fd).st_mode))
        original(fd)
    monkeypatch.setattr(module.os, 'fsync', sync)
    module._publish(tmp_path / 'book', {'pages.jsonl': 'page\n', 'meta.json': '{}\n'})
    assert synced.count(False) == 2
    assert synced.count(True) >= 2

@pytest.mark.parametrize('names', [('book', 'BOOK'), ('caf\u00e9', 'cafe\u0301')])
def test_collision_with_only(pdf, tmp_path, names):
    manifest = tmp_path / 'manifest.json'
    manifest.write_text(json.dumps({'sources': [cleared_source(pdf, source_id=n) for n in names]}))
    with pytest.raises(IngestError, match='Case-colliding'):
        extract_from_manifest(manifest, tmp_path / 'out', only=names[1], repo_root=tmp_path)
    assert not (tmp_path / 'out').exists()


def test_workspace_prefix_cannot_claim_other_backup(tmp_path):
    from ingest.extract import _publish
    workspace = tmp_path / '.book.tmp-a.tmp-crashed'
    (workspace / 'old').mkdir(parents=True)
    (workspace / 'target.json').write_text(json.dumps('book.tmp-a'))
    (workspace / 'old/marker').write_text('preserved')
    _publish(tmp_path / 'book', {'pages.jsonl': 'new'})
    assert (workspace / 'old/marker').read_text() == 'preserved'
    assert not (tmp_path / 'book/marker').exists()


@pytest.mark.parametrize('cleanup', ['remove', 'sync'])
def test_cleanup_preserves_primary_failure(tmp_path, monkeypatch, cleanup):
    import importlib
    module = importlib.import_module('ingest.extract')
    if cleanup == 'remove':
        def fail(*args):
            raise OSError('cleanup remove failed')
        monkeypatch.setattr(module.shutil, 'rmtree', fail)
    else:
        def fail(*args):
            raise OSError('cleanup sync failed')
        monkeypatch.setattr(module, '_fsync_directory', fail)
    with pytest.raises(TypeError) as error:
        module._publish(tmp_path / 'book', {'pages.jsonl': None})
    assert any('cleanup failed' in note for note in error.value.__notes__)


def test_cleanup_preserves_rollback_error(tmp_path, monkeypatch):
    import importlib
    module = importlib.import_module('ingest.extract')
    target = tmp_path / 'book'
    target.mkdir()
    (target / 'marker').write_text('previous')
    original = module.os.replace
    def fail(source, dest):
        if Path(source).name in {'new', 'old'}:
            raise OSError('rename failed')
        return original(source, dest)
    monkeypatch.setattr(module.os, 'replace', fail)
    with pytest.raises(IngestError, match='rollback failed'):
        module._publish(target, {'pages.jsonl': 'new'})
    assert len(list(tmp_path.glob('.book.tmp-*/old/marker'))) == 1


def test_missing_metrics_do_not_shift_baseline():
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            def measured(text, x):
                return dict(flags=8, bbox=(x, 0, x+100, 12), chars=[
                    dict(c=c, bbox=(x+i*6, 0, x+(i+1)*6, 12))
                    for i, c in enumerate(text)])
            return {'blocks': [{'lines': [
                {'spans': [measured('def f():', 50)]},
                {'spans': [dict(text='    x = 1', flags=8)]},
                {'spans': [measured('return x', 74)]},
            ]}]}
    code, = _code_blocks(Page())
    assert code == 'def f():\n    x = 1\n    return x'
    compile(code, '<fixture>', 'exec')


def test_columns_and_double_blank_lines():
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        for x, y, text in [(50, 80, 'def f():'), (76.4, 95, 'return 1'),
                           (50, 140, 'def g():'), (76.4, 155, 'return 2'),
                           (300, 50, 'def h():'), (326.4, 65, 'return 3')]:
            page.insert_text((x, y), text, fontname='cour', fontsize=11)
        blocks = _code_blocks(page)
    assert blocks == ['def f():\n    return 1\ndef g():\n    return 2',
                      'def h():\n    return 3']
    for code in blocks:
        compile(code, '<fixture>', 'exec')


@pytest.mark.parametrize('name', ['SomeMono-Regular', 'ABC+CourierNew', 'Consolas', 'Menlo'])
def test_named_monospace_without_flag(name):
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            return {'blocks': [{'lines': [{'spans': [dict(
                text='answer = 42', font=name, flags=0)]}]}]}
    assert _code_blocks(Page()) == ['answer = 42']


def test_font_metric_fallback(monkeypatch):
    from ingest.extract import _mono_font
    _mono_font.cache_clear()
    class Font:
        is_monospaced = True
    monkeypatch.setattr(pymupdf, 'Font', lambda name: Font())
    assert _mono_font('FixtureFixedPitch')
    _mono_font.cache_clear()


def test_callouts_only_removed_from_code(tmp_path):
    path = tmp_path / 'callouts.pdf'
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_font(fontname='Callout', fontbuffer=pymupdf.Font('cjk').buffer)
        page.insert_text((50, 50), 'value = 1 ', fontname='cour', fontsize=11)
        page.insert_text((116, 50), '①', fontname='Callout', fontsize=11)
        doc.save(path)
    extract(path, 'book', tmp_path / 'out', expected_sha256=sha256_file(path))
    row = json.loads((tmp_path / 'out/book/pages.jsonl').read_text())
    assert '①' in row['text']
    assert row['code_blocks'] == ['value = 1']


def test_successful_publish_cleanup_warns(tmp_path, monkeypatch, capsys):
    import importlib
    module = importlib.import_module('ingest.extract')
    def fail(*args):
        raise OSError('cleanup failure')
    monkeypatch.setattr(module.shutil, 'rmtree', fail)
    module._publish(tmp_path / 'book', {'pages.jsonl': 'complete'})
    assert (tmp_path / 'book/pages.jsonl').read_text() == 'complete'
    assert 'Warning: output cleanup failed' in capsys.readouterr().err


def test_stale_unmarked_workspace_recovery(tmp_path):
    import os
    import time
    from ingest.extract import _publish
    old = tmp_path / '.book.tmp-old'
    fresh = tmp_path / '.book.tmp-fresh'
    old.mkdir()
    fresh.mkdir()
    os.utime(old, (time.time()-3601, time.time()-3601))
    _publish(tmp_path / 'book', {'pages.jsonl': 'complete'})
    assert not old.exists()
    assert fresh.exists()


def test_overlapping_listings_split():
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 50), 'left = 1', fontname='cour')
        page.insert_text((300, 50), 'right = 2', fontname='cour')
        assert _code_blocks(page) == ['left = 1', 'right = 2']


def test_callout_ranges_and_interior_markers():
    from ingest.extract import _code_blocks
    lines = ['x = "①" ①', 'y = 2❿', 'z = 3 ⑳', '# ① interior']
    class Page:
        def get_text(self, kind):
            return {'blocks': [{'lines': [{'spans': [dict(text=t, flags=8)]}
                                         for t in lines]}]}
    assert _code_blocks(Page()) == ['x = "①"\ny = 2\nz = 3\n# ① interior']


def test_unknown_font_is_not_monospace(monkeypatch):
    from ingest.extract import _mono_font
    _mono_font.cache_clear()
    def unknown(name):
        raise RuntimeError('unknown font')
    monkeypatch.setattr(pymupdf, 'Font', unknown)
    assert not _mono_font('FixtureUnknownFont')
    _mono_font.cache_clear()


@pytest.mark.parametrize('pitch,height', [(11, 13.86), (12, 12.76)])
def test_tall_font_tight_leading(pitch, height):
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            return {'blocks': [{'lines': [
                {'bbox': (50, 50+i*pitch, 180, 50+i*pitch+height),
                 'spans': [dict(text=text, font='SourceCodePro', size=11)]}
                for i, text in enumerate(['def f():', '    return 1'])
            ]}]}
    code, = _code_blocks(Page())
    assert code == 'def f():\n    return 1'
    compile(code, '<tight-leading>', 'exec')


def test_short_code_with_symbol_callouts():
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            return {'blocks': [{'lines': [
                {'spans': [dict(text='x = 1', flags=8),
                           dict(text=' ① ②', font='Symbol', flags=0)]},
                {'spans': [dict(text='①', flags=8)]},
                {'spans': [dict(text='y = 2', flags=8)]},
            ]}]}
    code, = _code_blocks(Page())
    assert code == 'x = 1\ny = 2'
    compile(code, '<callouts>', 'exec')


def test_first_gap_is_double_blank_line():
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        for y, text in [(50, 'import os'), (104, 'def f():'), (122, '    return 1')]:
            page.insert_text((50, y), text, fontname='cour', fontsize=11)
        code, = _code_blocks(page)
    assert code == 'import os\ndef f():\n    return 1'
    compile(code, '<first-gap>', 'exec')


@pytest.mark.parametrize('marked', [False, True])
def test_leftover_cleanup_failure_does_not_abort(tmp_path, monkeypatch, capsys, marked):
    import importlib
    import os
    import time
    module = importlib.import_module('ingest.extract')
    leftover = tmp_path / '.book.tmp-leftover'
    leftover.mkdir()
    if marked:
        (leftover / 'target.json').write_text(json.dumps('book'))
    os.utime(leftover, (time.time()-7200, time.time()-7200))
    original = module.shutil.rmtree
    def remove(path):
        if Path(path) == leftover:
            raise PermissionError('leftover removal denied')
        return original(path)
    monkeypatch.setattr(module.shutil, 'rmtree', remove)
    module._publish(tmp_path / 'book', {'pages.jsonl': 'complete'})
    assert (tmp_path / 'book/pages.jsonl').read_text() == 'complete'
    assert 'leftover removal denied' in capsys.readouterr().err


def test_stale_unmarked_backup_is_preserved(tmp_path):
    import os
    import time
    from ingest.extract import _publish
    leftover = tmp_path / '.book.tmp-old'
    (leftover / 'old').mkdir(parents=True)
    (leftover / 'old/marker').write_text('previous')
    os.utime(leftover, (time.time()-7200, time.time()-7200))
    _publish(tmp_path / 'book', {'pages.jsonl': 'complete'})
    assert (leftover / 'old/marker').read_text() == 'previous'


@pytest.mark.parametrize('gap,fragment', [(2, 'n == 1:'), (18, '# alternative')])
def test_same_baseline_listing_fragments(gap, fragment):
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_text((50, 50), 'if n == 0:', fontname='cour', fontsize=10)
        page.insert_text((74, 65), 'value = 0', fontname='cour', fontsize=10)
        page.insert_text((50, 80), 'elif' if gap == 2 else 'else:',
                         fontname='cour', fontsize=10)
        prefix = 'elif' if gap == 2 else 'else:'
        page.insert_text((50 + (len(prefix) + gap) * 6, 80), fragment,
                         fontname='cour', fontsize=10)
        page.insert_text((74, 95), 'value = 1', fontname='cour', fontsize=10)
        code, = _code_blocks(page)
    assert prefix + ' ' * gap + fragment in code
    compile(code, '<fragments>', 'exec')


def test_large_first_gap_splits():
    from ingest.extract import _code_blocks
    with pymupdf.open() as doc:
        page = doc.new_page()
        for y, text in [(50, 'standalone = 0'), (180, 'def f():'),
                        (195, '    return 1'), (210, 'value = f()')]:
            page.insert_text((50, y), text, fontname='cour', fontsize=11)
        blocks = _code_blocks(page)
    assert blocks == ['standalone = 0', 'def f():\n    return 1\nvalue = f()']
    for code in blocks:
        compile(code, '<gap>', 'exec')


@pytest.mark.parametrize('offset', [1, 6, 12])
@pytest.mark.parametrize('geometry', ['rect', 'mediabox'])
def test_column_jump_below_previous_line(offset, geometry):
    from ingest.extract import _code_blocks
    class Page:
        def get_text(self, kind):
            return {'blocks': [{'lines': [
                {'bbox': (x, y, x+100, y+12),
                 'spans': [dict(text=t, flags=8, size=10)]}
                for x, y, t in [(50, 50, 'left = 1'), (50, 65, 'left += 1'),
                                (350, 65+offset, 'right = 2'),
                                (350, 80+offset, 'right += 1')]]}]}
    page = Page()
    setattr(page, geometry, pymupdf.Rect(0, 0, 600, 800))
    assert _code_blocks(page) == ['left = 1\nleft += 1', 'right = 2\nright += 1']


def _fixture_span(text, x, y, width=6, height=12, size=10):
    return dict(flags=8, size=size, bbox=(x, y, x+len(text)*width, y+height),
                chars=[dict(c=c, bbox=(x+i*width, y, x+(i+1)*width, y+height))
                       for i, c in enumerate(text)])


def _fixture_page(lines):
    class Page:
        mediabox = pymupdf.Rect(0, 0, 600, 800)
        def get_text(self, kind):
            return {'blocks': [{'lines': [dict(bbox=spans[0]['bbox'], spans=spans)
                                         for spans in lines]}]}
    return Page()


@pytest.mark.parametrize('reverse,small,trailing', [(False, False, True),
                                                   (False, True, False),
                                                   (True, False, False)])
def test_visual_fragments(reverse, small, trailing):
    from ingest.extract import _code_blocks
    left = [_fixture_span('if True:', 50, 50)]
    a = [_fixture_span('value ' if trailing else 'value', 74, 65)]
    b = [_fixture_span('= 1', 110, 68 if small else 65,
                       height=8 if small else 12)]
    code, = _code_blocks(_fixture_page([left] + ([b, a] if reverse else [a, b])))
    assert code == 'if True:\n    value = 1'
    compile(code, '<visual>', 'exec')


def test_callout_does_not_set_indent_or_pitch():
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('def f():', 50, 50)],
        [_fixture_span('①', 74, 65, width=30, size=50),
         _fixture_span('return 1', 74, 65)],
        [_fixture_span('value = 2', 50, 200)],
    ])
    # Leading callouts remain annotations in the text; only their metrics are ignored.
    assert _code_blocks(page) == ['def f():\n    ①return 1', 'value = 2']


@pytest.mark.parametrize('suffix', ['    ①', '   ①    ②  ', '\t❶   ⑳'])
def test_aligned_trailing_callouts_leave_no_whitespace(suffix):
    from ingest.extract import _code_blocks
    assert _code_blocks(_fixture_page([[_fixture_span('value = 1'+suffix, 50, 50)]])) == ['value = 1']


def test_new_listing_first_gap_uses_fallback_pitch():
    from ingest.extract import _code_blocks
    lines = [[_fixture_span(text, 50, y)] for y, text in
             [(50, 'a = 1'), (56, 'b = 2'), (180, 'c = 3'),
              (220, 'd = 4'), (232, 'e = 5')]]
    assert _code_blocks(_fixture_page(lines)) == ['a = 1\nb = 2', 'c = 3\nd = 4\ne = 5']


def test_bullet_list_is_not_a_python_listing():
    from ingest.extract import _code_blocks
    assert _code_blocks(_fixture_page([
        [_fixture_span('•', 50, 50)], [_fixture_span("'Hello world!'", 74, 50)],
        [_fixture_span('•', 50, 65)], [_fixture_span("'Hello'", 74, 65)],
    ])) == []


def _separate_blocks(page):
    layout = page.get_text('rawdict')
    lines = [line for block in layout['blocks'] for line in block['lines']]
    class Page:
        mediabox = pymupdf.Rect(0, 0, 600, 800)
        def get_text(self, kind):
            return {'blocks': [{'lines': [line]} for line in lines]}
    return Page()


def test_cross_block_gap_ignores_trailing_spaces():
    from ingest.extract import _code_blocks
    page = _separate_blocks(_fixture_page([
        [_fixture_span('value     ', 50, 50)],
        [_fixture_span('= 1', 86, 50)],
    ]))
    assert _code_blocks(page) == ['value = 1']


@pytest.mark.parametrize('bullet', ['•', '◦', '▪', '–'])
def test_bullet_in_separate_block(bullet):
    from ingest.extract import _code_blocks
    page = _separate_blocks(_fixture_page([
        [_fixture_span('before = 1', 50, 30)],
        [_fixture_span(bullet, 50, 50)],
        [_fixture_span("'Hello world!'", 74, 50)],
        [_fixture_span('after = 2', 50, 70)],
    ]))
    assert _code_blocks(page) == ['before = 1', 'after = 2']


@pytest.mark.parametrize('separate', [False, True])
@pytest.mark.parametrize('marker', ['①', '⑳', '❶', '❿'])
def test_callout_at_fragment_join(separate, marker):
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('value = 1  '+marker, 50, 50)],
        [_fixture_span('+ 2', 140, 50)],
    ])
    if separate:
        page = _separate_blocks(page)
    code, = _code_blocks(page)
    assert marker not in code
    assert code == 'value = 1 + 2'
    compile(code, '<callout-join>', 'exec')


def test_tall_glyph_does_not_merge_neighboring_baselines():
    from ingest.extract import _code_blocks
    tall = _fixture_span('a = 1', 50, 30, height=40)
    tall['origin'] = (50, 50)
    short = _fixture_span('b = 2', 50, 47, height=12)
    short['origin'] = (50, 58)
    assert _code_blocks(_fixture_page([[tall], [short]])) == ['a = 1\nb = 2']


def test_indent_origin_ignores_leading_callout_span():
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('def f():', 50, 50)],
        [_fixture_span('①', 20, 65), _fixture_span('return 1', 74, 65)],
    ])
    assert _code_blocks(page) == ['def f():\n    ①return 1']


# P3-8 backlog (2026-11-09) ------------------------------------------------------------------------------------

@pytest.mark.parametrize('separate', [False, True])
@pytest.mark.parametrize('marker', ['①', '❶'])
def test_callout_leading_a_joined_fragment_is_dropped(separate, marker):
    # An annotation that starts the second fragment of a line would otherwise land inside the code.
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('value = 1', 50, 50)],
        [_fixture_span(marker + ' + 2', 110, 50)],
    ])
    if separate:
        page = _separate_blocks(page)
    code, = _code_blocks(page)
    assert code == 'value = 1 + 2'
    compile(code, '<leading-callout-join>', 'exec')


def test_line_starting_with_a_callout_keeps_it():
    # Only callouts inside a joined line are dropped; one that starts the line stays as an annotation.
    from ingest.extract import _code_blocks
    assert _code_blocks(_fixture_page([[_fixture_span('① x = 1', 50, 50)]])) == ['① x = 1']


def test_tall_glyph_across_blocks_does_not_join_the_next_baseline():
    # Separate blocks are joined by baseline, like fragments within one block, not by (tall) bounding boxes.
    from ingest.extract import _code_blocks
    tall = _fixture_span('a = (', 50, 30, height=40)
    tall['origin'] = (50, 50)
    below = _fixture_span('1)', 86, 47, height=12)
    below['origin'] = (86, 58)
    code, = _code_blocks(_separate_blocks(_fixture_page([[tall], [below]])))
    assert code.splitlines()[0] == 'a = (' and len(code.splitlines()) == 2


def test_same_baseline_across_blocks_still_joins_with_a_small_font():
    from ingest.extract import _code_blocks
    a = _fixture_span('value =', 50, 50)
    a['origin'] = (50, 60)
    b = _fixture_span('1', 98, 54, height=8, size=7)
    b['origin'] = (98, 60)
    assert _code_blocks(_separate_blocks(_fixture_page([[a], [b]]))) == ['value = 1']


def test_bullet_in_another_column_does_not_hide_code():
    # A bullet far to the left (another column) on the same baseline is not this line's bullet.
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('•', 50, 50)], [_fixture_span('A point in the left column', 64, 50, width=5)],
        [_fixture_span('total = 1', 350, 50)], [_fixture_span('total += 2', 350, 65)],
    ])
    assert 'total = 1\ntotal += 2' in _code_blocks(page)


def test_prefix_in_a_wider_font_does_not_skew_indentation():
    # A line-number prefix set in a wider font: indentation is measured from where the prefix starts.
    from ingest.extract import _code_blocks
    first = _fixture_span('def f():', 50, 50)
    number = _fixture_span('7 ', 50, 65, width=10)
    number['flags'] = 0
    body = _fixture_span('return 1', 70, 65)
    assert _code_blocks(_fixture_page([[first], [number, body]])) == ['def f():\n7 return 1']


@pytest.mark.parametrize('separate', [False, True])
@pytest.mark.parametrize('first,second,want', [
    ("print('", "① marks it')", "print('① marks it')"),
    ('s = "a', '❶ b"', 's = "a❶ b"'),
    ('x = 1  # step', '② next', 'x = 1  # step② next'),
])
def test_callout_inside_a_split_literal_or_comment_is_kept(separate, first, second, want):
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span(first, 50, 50)],
        [_fixture_span(second, 50 + len(first) * 6, 50)],
    ])
    if separate:
        page = _separate_blocks(page)
    assert _code_blocks(page) == [want]


@pytest.mark.parametrize('text,open_', [
    ("print('", True), ("print('x')", False), ('s = "a\\"', True), ('s = "a\\""', False),
    ("x = 1  # c", True), ("s = '#' + t", False), ('d = """doc', True), ('d = """doc"""', False),
    ("f(x)", False), ("", False),
])
def test_open_literal_or_comment(text, open_):
    from ingest.extract import _open_literal_or_comment
    assert _open_literal_or_comment(text) is open_


@pytest.mark.parametrize('separate', [False, True])
@pytest.mark.parametrize('quote', ['"""', "'''"])
def test_callout_inside_a_multiline_string_is_kept(separate, quote):
    # The second line continues a triple-quoted string opened on the first, so its circled digit is content.
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('s = ' + quote + 'first', 50, 50)],
        [_fixture_span('second', 50, 65)],
        [_fixture_span('① third' + quote, 92, 65)],
    ])
    if separate:
        page = _separate_blocks(page)
    assert _code_blocks(page) == ['s = ' + quote + 'first\nsecond ① third' + quote]


@pytest.mark.parametrize('separate', [False, True])
def test_callout_after_a_closed_multiline_string_is_dropped(separate):
    from ingest.extract import _code_blocks
    page = _fixture_page([
        [_fixture_span('s = """a', 50, 50)],
        [_fixture_span('b"""', 50, 65)],
        [_fixture_span('x = 1', 50, 80)],
        [_fixture_span('① + 2', 86, 80)],
    ])
    if separate:
        page = _separate_blocks(page)
    assert _code_blocks(page) == ['s = """a\nb"""\nx = 1 + 2']


def test_carried_quote():
    from ingest.extract import _carried_quote
    assert _carried_quote(['s = """a', 'b']) == '"""'
    assert _carried_quote(['s = """a', 'b"""']) is None
    assert _carried_quote(["x = 'unterminated", 'y = 2']) is None   # only triple quotes span lines
    assert _carried_quote(["# a ''' in a comment", 'y']) is None
