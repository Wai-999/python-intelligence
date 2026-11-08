"""Deterministic, provenance-preserving internal PDF extraction."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import shutil
import unicodedata
import errno
import sys
import re
import time
from functools import lru_cache

import pymupdf

QUALITY_THRESHOLD = 0.6
CALLOUTS = re.compile(r"[\u2460-\u2473\u2776-\u277f]")


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


@lru_cache(maxsize=256)
def _mono_font(name):
    lowered = name.casefold()
    if any(token in lowered for token in (
        "mono", "courier", "consol", "menlo", "inconsolata", "sourcecodepro",
        "dejavusansmono", "lucidaconsole", "andale", "firacode",
        "liberationmono", "ubuntumono", "roboto mono",
    )):
        return True
    try:
        return bool(pymupdf.Font(name).is_monospaced)
    except Exception:
        return False


def _is_mono(span):
    return bool(span.get("flags", 0) & 8) or _mono_font(span.get("font", ""))


def _baseline(line):
    origins = [s["origin"][1] for s in line.get("spans", []) if s.get("origin")]
    return sorted(origins)[len(origins) // 2] if origins else line["bbox"][3]


def _ink_box(line):
    box = line.get("bbox")
    glyphs = [c for s in line.get("spans", []) for c in s.get("chars", [])
              if not c["c"].isspace() and not CALLOUTS.fullmatch(c["c"])]
    return (box[0], box[1], max(c["bbox"][2] for c in glyphs), box[3]) if box and glyphs else box


def _trim_fragment(spans):
    # Remove editorial suffixes before a following fragment makes them interior.
    text = "".join(s.get("text", "") for s in spans)
    trimmed = re.sub(r"(?:\s*[①-⑳❶-❿])+\s*$", "", text).rstrip()
    had_callout = bool(CALLOUTS.search(text[len(trimmed):]))
    remaining = len(trimmed)
    for span in spans:
        original = span.get("text", "")
        span["text"] = original[:remaining]
        if "chars" in span:
            span["chars"] = span["chars"][:remaining]
        remaining = max(0, remaining - len(original))
    return had_callout


def _visual_lines(lines):
    """Reassemble raw fragments by baseline proximity, then x position."""
    groups = []
    for raw in lines:
        line = dict(raw)
        line["spans"] = [dict(s, text="".join(c["c"] for c in s["chars"]))
                         if "chars" in s else dict(s) for s in raw.get("spans", [])]
        box = line.get("bbox")
        group = next((g for g in groups if box and g[0].get("bbox") and
                      abs(_baseline(line) - _baseline(g[0])) <
                      .5 * min(box[3] - box[1], g[0]["bbox"][3] - g[0]["bbox"][1])), None)
        if group is None:
            groups.append([line])
        else:
            group.append(line)
    for group in groups:
        group.sort(key=lambda line: line.get("bbox", (0,))[0])
        merged = None
        edge = None
        for line in group:
            spans = line["spans"]
            box = line.get("bbox")
            text = "".join(s.get("text", "") for s in spans)
            glyphs = [c for s in spans for c in s.get("chars", [])
                      if not c["c"].isspace() and not CALLOUTS.fullmatch(c["c"])]
            widths = sorted(c["bbox"][2] - c["bbox"][0] for c in glyphs
                            if c["bbox"][2] > c["bbox"][0])
            width = widths[len(widths)//2] if widths else next(
                (.6 * s["size"] for s in spans if s.get("size")), 1)
            gap = box[0] - edge if box and edge is not None else None
            limit = 24 if text.lstrip().startswith("#") else 10
            if merged is not None and gap is not None and -.1 <= gap <= limit * width:
                had_callout = _trim_fragment(merged["spans"])
                spaces = 1 if had_callout else max(0, round(gap / width))
                merged["spans"].append(dict(text=" " * spaces, flags=8))
                merged["spans"].extend(spans)
                old = merged["bbox"]
                merged["bbox"] = (old[0], min(old[1], box[1]), box[2], max(old[3], box[3]))
            else:
                if merged is not None:
                    yield merged
                merged = line
            edge = max((c["bbox"][2] for c in glyphs), default=box[2] if box else None)
        if merged is not None:
            yield merged


def _code_blocks(page):
    blocks, current, pitches = [], [], []
    previous = None
    previous_callout = False

    def flush():
        nonlocal previous, previous_callout
        if current:
            measured = [origin for _, origin, _ in current if origin is not None]
            baseline = min(measured) if measured else 0
            blocks.append("\n".join(
                " " * (max(0, round((origin - baseline) / width))
                       if origin is not None else 0) + text
                for text, origin, width in current))
            current.clear()
        pitches.clear()
        previous = None
        previous_callout = False

    layout = page.get_text("rawdict")
    lines = [line for block in layout["blocks"] for line in block.get("lines", [])]
    bullets = [line for line in lines if "".join(
        "".join(c["c"] for c in s["chars"]) if "chars" in s else s.get("text", "")
        for s in line.get("spans", [])).strip() in {"•", "◦", "▪", "–"}]
    for block in layout["blocks"]:
        for line in _visual_lines(block.get("lines", [])):
            spans = [dict(span) for span in line.get("spans", [])]
            for span in spans:
                if "chars" in span:
                    span["text"] = "".join(c["c"] for c in span["chars"])
            text = _normalize("".join(span.get("text", "") for span in spans))
            if not CALLOUTS.sub("", text).strip():
                continue
            total = sum(sum(not c.isspace() for c in CALLOUTS.sub("", s["text"])) for s in spans)
            mono = sum(sum(not c.isspace() for c in CALLOUTS.sub("", s["text"])) for s in spans if _is_mono(s))
            bbox = line.get("bbox")
            bullet_line = any(bbox and b.get("bbox") and b["bbox"][0] <= bbox[0]
                              and abs(_baseline(b) - _baseline(line)) <
                              .5 * min(b["bbox"][3] - b["bbox"][1], bbox[3] - bbox[1])
                              for b in bullets)
            if total and mono / total >= 0.8 and not bullet_line and not text.lstrip().startswith(("•", "◦", "▪", "–")):
                bbox = line.get("bbox")
                first = next((s for s in spans if _is_mono(s) and any(
                    c.isascii() and not c.isspace() for c in CALLOUTS.sub("", s["text"]))),
                    next(s for s in spans if _is_mono(s) and s["text"].strip()))
                widths = [c["bbox"][2] - c["bbox"][0]
                          for c in first.get("chars", [])
                          if not c["c"].isspace() and c["bbox"][2] > c["bbox"][0]]
                width = sorted(widths)[len(widths) // 2] if widths else 0
                origin = first.get("bbox", (None,))[0] if width else None
                if origin is not None:
                    # Prefix text is already present literally; do not count its
                    # width again as positioned indentation. Ignore annotations.
                    prefix = spans[:next(i for i, s in enumerate(spans) if s is first)]
                    origin -= sum(len(CALLOUTS.sub("", s["text"])) for s in prefix) * width
                # Callouts are editorial annotations, retained in page text.
                trimmed = re.sub(r"(?:\s*[①-⑳❶-❿])+\s*$", "", text).rstrip()
                trailing_callout = bool(CALLOUTS.search(text[len(trimmed):]))
                text = trimmed
                if not text.strip():
                    continue
                # MuPDF can also place adjacent fragments in separate blocks.
                if previous and bbox and current and width:
                    overlap = min(previous[3], bbox[3]) - max(previous[1], bbox[1])
                    gap = bbox[0] - previous[2]
                    limit = 24 if text.lstrip().startswith("#") else 10
                    if (overlap > .5 * min(previous[3] - previous[1], bbox[3] - bbox[1])
                            and -.1 <= gap <= limit * width):
                        old_text, old_origin, old_width = current[-1]
                        spaces = 1 if previous_callout else max(0, round(gap / width))
                        if old_text[-1:].isidentifier() and text[:1].isidentifier():
                            spaces = max(1, spaces)
                        current[-1] = (old_text + " " * spaces + text, old_origin, old_width)
                        previous = (previous[0], min(previous[1], bbox[1]), _ink_box(line)[2],
                                    max(previous[3], bbox[3]))
                        previous_callout = trailing_callout
                        continue
                page_box = getattr(page, "rect", None) or getattr(page, "mediabox", None)
                page_width = (page_box.width if hasattr(page_box, "width") else
                              page_box[2] - page_box[0] if page_box else 612)
                if previous and bbox and abs(bbox[0] - previous[0]) > .4 * page_width:
                    flush()
                if previous and bbox:
                    delta = bbox[1] - previous[1]
                    fallback = max(previous[3] - previous[1], 1.2 * first.get("size", 0))
                    pitch = sorted(pitches)[len(pitches) // 2] if pitches else fallback
                    # Full font bboxes can overlap even on consecutive baselines.
                    # Without a measured pitch, a first gap may be two blank lines.
                    if delta <= 0.01 or delta > (3.5 * pitch if pitches else 4.5 * fallback):
                        flush()
                    elif delta <= 1.5 * fallback:
                        pitches.append(delta)
                current.append((text, origin, width or 1))
                previous = _ink_box(line)
                previous_callout = trailing_callout
            else:
                flush()
                previous = None
    flush()
    return blocks


def _fsync_directory(path):
    """Directory syncing is unavailable on some operating systems/filesystems."""
    try:
        fd = os.open(path, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as exc:
        if exc.errno not in {errno.EINVAL, errno.ENOTSUP, errno.EBADF, errno.EACCES}:
            raise


def _publish(target, artifacts):
    """Publish complete generations; retain a nested backup if rollback fails.

    The two portable renames briefly hide the target. Interrupted swaps are
    recovered on the next publication. Backups never expose pages.jsonl as a
    direct child of the output root, where provenance consumers discover books.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() or (target.exists() and not target.is_dir()):
        raise IngestError(f"Output target must be a directory, not a file or symlink: {target}")
    prefix = f".{target.name}.tmp-"
    for leftover in sorted(target.parent.iterdir()):
        if not leftover.name.startswith(prefix) or not leftover.is_dir() or leftover.is_symlink():
            continue
        marker = leftover / "target.json"
        try:
            try:
                if json.loads(marker.read_text(encoding="utf-8")) != target.name:
                    continue
            except (OSError, ValueError):
                # An older unmarked workspace may hold the only previous output.
                if (leftover / "old").exists() and not target.exists():
                    continue
                if not marker.exists() and time.time() - leftover.stat().st_mtime > 3600:
                    shutil.rmtree(leftover)
                continue
            backup = leftover / "old"
            if backup.exists() and not target.exists():
                os.replace(backup, target)
                _fsync_directory(target.parent)
            shutil.rmtree(leftover)
        except OSError as cleanup_error:
            print(f"Warning: output cleanup failed at {leftover}: {cleanup_error}", file=sys.stderr)
    workspace = Path(tempfile.mkdtemp(prefix=prefix, dir=target.parent))
    staged, backup = workspace / "new", workspace / "old"
    preserve = False
    try:
        (workspace / "target.json").write_text(json.dumps(target.name), encoding="utf-8")
        staged.mkdir()
        for name, text in artifacts.items():
            with open(staged / name, "w", encoding="utf-8", newline="\n") as stream:
                stream.write(text)
                stream.flush()
                os.fsync(stream.fileno())
        _fsync_directory(staged)
        had_target = target.exists()
        if had_target:
            os.replace(target, backup)
            _fsync_directory(workspace)
        try:
            os.replace(staged, target)
        except BaseException:
            if had_target:
                try:
                    os.replace(backup, target)
                    _fsync_directory(target.parent)
                except OSError as rollback_error:
                    preserve = True
                    raise IngestError(f"Output rollback failed; previous output saved at {backup}") from rollback_error
            raise
        _fsync_directory(target.parent)
    finally:
        if backup.exists() and not target.exists():
            preserve = True
        primary = sys.exception()
        if not preserve:
            try:
                shutil.rmtree(workspace)
                _fsync_directory(target.parent)
            except Exception as cleanup_error:
                if primary is None:
                    print(f"Warning: output cleanup failed at {workspace}: {cleanup_error}", file=sys.stderr)
                else:
                    primary.add_note(f"Output cleanup failed at {workspace}: {cleanup_error}")


def extract(pdf_path, source_id, out_dir, *, expected_sha256: str) -> dict:
    """Hash before opening; publish a complete directory of internal artifacts."""
    if not isinstance(source_id, str) or not source_id or source_id in {".", ".."} or "/" in source_id or "\\" in source_id or source_id.startswith(".") or any(unicodedata.category(c).startswith("C") for c in source_id):
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
        artifacts = {"pages.jsonl": "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records)}
        for name, value in (("meta.json", meta), ("review_queue.json", queue)):
            artifacts[name] = json.dumps(value, ensure_ascii=False, indent=2) + "\n"
        _publish(target, artifacts)
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
        seen = set()
        for source in sources:
            folded = unicodedata.normalize("NFC", source["source_id"]).casefold()
            if folded in seen:
                raise IngestError("Case-colliding source_ids in manifest")
            seen.add(folded)
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
