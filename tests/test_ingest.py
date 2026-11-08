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
    cleared = dict(source_id="book", local_path=pdf.name, sha256=sha256_file(pdf),
                   allowed_for_internal_extraction=True, downloaded=True)
    manifest.write_text(json.dumps({"sources": [cleared, dict(source_id="denied"),
        dict(source_id="missing", allowed_for_internal_extraction=True, downloaded=False)]}))
    out = tmp_path / "out"
    assert len(extract_from_manifest(manifest, out, repo_root=tmp_path)) == 1
    assert {p.name for p in out.iterdir()} == {"book"}
    for only in ("denied", "missing", "unknown"):
        with pytest.raises(IngestError):
            extract_from_manifest(manifest, out, only=only, repo_root=tmp_path)
    cleared["local_path"] = str(pdf)
    manifest.write_text(json.dumps({"sources": [cleared]}))
    command = [sys.executable, "-m", "ingest", "--manifest", str(manifest), "--out", str(out)]
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
