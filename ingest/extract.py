"""Deterministic, provenance-preserving internal PDF extraction."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile

import pymupdf

QUALITY_THRESHOLD = 0.6


class IngestError(Exception):
    """An input could not safely be ingested."""


def sha256_file(path) -> str:
    try:
        with open(path, "rb") as stream:
            return hashlib.file_digest(stream, "sha256").hexdigest()
    except OSError as exc:
        raise IngestError(f"Cannot hash {path}: {exc}") from exc


def score_page(text: str, has_images: bool) -> tuple[float, list[str]]:
    """Start at 1, subtract replacement-character share, cap sparse (<40
    non-space characters) or low-letter-share (<50%) pages at .5.
    Empty text scores zero; images on empty pages suggest a scan. These are
    review heuristics, not proof of correctness or verification of code.
    """
    if not text.strip():
        return 0.0, sorted(["no_text"] + (["image_only"] if has_images else []))
    chars = [c for c in text if not c.isspace()]
    flags = []
    quality = 1.0
    if "\ufffd" in text:
        flags.append("replacement_chars")
        quality -= text.count("\ufffd") / len(chars)
    if len(chars) < 40:
        flags.append("sparse")
        quality = min(quality, 0.5)
    if sum(c.isalpha() for c in chars) / len(chars) < 0.5:
        flags.append("low_alpha")
        quality = min(quality, 0.5)
    return round(max(0.0, quality), 3), sorted(flags)


def _normalize(text):
    return "\n".join(line.rstrip() for line in text.replace("\x00", "").replace("\r\n", "\n").replace("\r", "\n").split("\n"))


def _code_blocks(page):
    blocks, current = [], []

    def flush():
        if current:
            blocks.append("\n".join(current))
            current.clear()

    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            spans = line.get("spans", [])
            text = _normalize("".join(span["text"] for span in spans))
            if not text.strip():
                continue
            if spans and all(span["flags"] & 8 for span in spans):
                current.append(text)
            else:
                flush()
    flush()
    return blocks


def _atomic_write(path, text):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", newline="\n",
                                         dir=path.parent, delete=False) as stream:
            temporary = stream.name
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def extract(pdf_path, source_id, out_dir, *, expected_sha256: str) -> dict:
    """Hash before opening; write three internal artifacts, atomically per file."""
    if not isinstance(source_id, str) or not source_id or source_id in {".", ".."} or "/" in source_id or "\\" in source_id:
        raise IngestError("source_id must be a nonempty single directory name")
    try:
        data = Path(pdf_path).read_bytes()
    except OSError as exc:
        raise IngestError(f"Cannot read {pdf_path}: {exc}") from exc
    digest = hashlib.sha256(data).hexdigest()
    if digest != expected_sha256:
        raise IngestError(f"SHA256 mismatch for {source_id}: expected {expected_sha256}, got {digest}")
    try:
        records = []
        with pymupdf.open(stream=data, filetype="pdf") as doc:
            if not doc.is_pdf or doc.needs_pass:
                raise IngestError(f"{source_id}: expected an unencrypted PDF")
            for index, page in enumerate(doc, 1):
                text = _normalize(page.get_text("text"))
                quality, flags = score_page(text, bool(page.get_images()))
                records.append(dict(source_id=source_id, sha256=digest, page=index,
                                    label=page.get_label() or None, text=text, chars=len(text),
                                    extraction_quality=quality, flags=flags, code_blocks=_code_blocks(page)))
            queue = [{key: row[key] for key in ("page", "label", "extraction_quality", "flags")}
                     for row in records if row["extraction_quality"] < QUALITY_THRESHOLD]
            meta = dict(source_id=source_id, sha256=digest, page_count=len(records),
                        extractor="pymupdf " + pymupdf.__version__, toc=doc.get_toc(),
                        quality=dict(mean=round(sum(r["extraction_quality"] for r in records) / len(records), 3)
                                     if records else 0.0, low_pages=len(queue)),
                        review_threshold=QUALITY_THRESHOLD)
        target = Path(out_dir) / source_id
        target.mkdir(parents=True, exist_ok=True)
        _atomic_write(target / "pages.jsonl", "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
        for name, value in (("meta.json", meta), ("review_queue.json", queue)):
            _atomic_write(target / name, json.dumps(value, ensure_ascii=False, indent=2) + "\n")
        return meta
    except IngestError:
        raise
    except Exception as exc:
        raise IngestError(f"Cannot extract {source_id}: {exc}") from exc


def extract_from_manifest(manifest_path, out_root, *, only: str | None = None, repo_root=".", on_result=None) -> list[dict]:
    """Extract only explicitly cleared, downloaded sources; never grant rights."""
    try:
        manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        validator_path = Path(__file__).resolve().parents[1] / "scripts" / "validate_manifest.py"
        spec = importlib.util.spec_from_file_location("ingest_manifest_validator", validator_path)
        validator = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(validator)
        errors = validator.validate(manifest)
        if errors:
            raise IngestError("Invalid manifest:\n" + "\n".join(errors))
        sources = manifest["sources"]
        root = Path(repo_root).resolve()
        paths = {}
        for source in sources:
            if "local_path" not in source:
                continue
            local = Path(source["local_path"])
            resolved = (root / local).resolve()
            if local.is_absolute() or ".." in local.parts or not resolved.is_relative_to(root):
                raise IngestError(f"Source {source['source_id']!r}: local_path must stay under repo_root and be relative")
            paths[source["source_id"]] = resolved
        selected = sources if only is None else [s for s in sources if s.get("source_id") == only]
        if only is not None and len(selected) != 1:
            raise IngestError(f"Source {only!r} must occur exactly once in manifest")
        results = []
        for source in selected:
            reasons = [field + " is not true" for field in ("allowed_for_internal_extraction", "downloaded")
                       if source.get(field) is not True]
            if reasons:
                if only is not None:
                    raise IngestError(f"Source {only!r} not cleared: {', '.join(reasons)}")
                continue
            meta = extract(paths[source["source_id"]], source["source_id"],
                           out_root, expected_sha256=source["sha256"])
            results.append(meta)
            if on_result is not None:
                on_result(meta)
        return results
    except IngestError:
        raise
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise IngestError(f"Invalid manifest {manifest_path}: {exc}") from exc
