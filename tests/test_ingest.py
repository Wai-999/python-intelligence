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
    # Embed a Unicode font so actual circled glyphs survive PDF extraction.
    fontpath = Path('/System/Library/Fonts/Supplemental/Arial Unicode.ttf')
    if not fontpath.exists():
        # Raw layout fixture keeps this regression portable without system fonts.
        from ingest.extract import _code_blocks
        class Page:
            def get_text(self, kind):
                return {'blocks': [{'lines': [{'spans': [dict(
                    text=t, flags=8)]} for t in ['x = "①" ①', 'y = 2❿', 'z = 3 ⑳']]}]}
        assert _code_blocks(Page()) == ['x = "①"\ny = 2\nz = 3']
        return
    with pymupdf.open() as doc:
        page = doc.new_page()
        page.insert_font(fontname='Callout', fontfile=str(fontpath))
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
