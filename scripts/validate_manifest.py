"""Validate the source rights manifest (docs/audit/source_manifest.json).

Usage: python scripts/validate_manifest.py PATH
Exit codes: 0 valid, 1 invalid (each error printed), 2 unreadable file or invalid JSON.

Stdlib only. The core rule: no source may be cleared for publication or internal
extraction unless its rights are verified AND a human decision (by/date/basis) is recorded.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
import sys
from pathlib import Path

_HEX40_LOWER = re.compile(r"[0-9a-f]{40}")
_HEX40 = re.compile(r"[0-9a-fA-F]{40}")
_HEX64_LOWER = re.compile(r"[0-9a-f]{64}")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")

_STR_FIELDS = ("repo", "path", "rights_status")
_BOOL_FIELDS = ("rights_verified", "allowed_to_publish", "allowed_for_internal_extraction")
_PERMISSIONS = ("allowed_to_publish", "allowed_for_internal_extraction")


def _nonempty_str(v: object) -> bool:
    return isinstance(v, str) and v.strip() != ""


def _valid_date(v: object) -> bool:
    if not isinstance(v, str) or not _DATE.fullmatch(v):
        return False
    try:
        _dt.date.fromisoformat(v)
    except ValueError:
        return False
    return True


def _validate_source(i: int, src: object, seen: set[str]) -> list[str]:
    if not isinstance(src, dict):
        return [f"sources[{i}]: must be an object, got {type(src).__name__}"]

    sid = src.get("source_id")
    label = f"sources[{i}] ({sid})" if _nonempty_str(sid) else f"sources[{i}]"
    errs: list[str] = []

    if not _nonempty_str(sid):
        errs.append(f"{label}: source_id must be a non-empty string")
    elif sid in seen:
        errs.append(f"{label}: duplicate source_id {sid!r}")
    else:
        seen.add(sid)

    for f in _STR_FIELDS:
        if f not in src:
            errs.append(f"{label}: missing required field {f!r}")
        elif not isinstance(src[f], str):
            errs.append(f"{label}: {f} must be a string")

    if "commit_sha" not in src:
        errs.append(f"{label}: missing required field 'commit_sha'")
    elif not (isinstance(src["commit_sha"], str) and _HEX40_LOWER.fullmatch(src["commit_sha"])):
        errs.append(f"{label}: commit_sha must be 40 lowercase hex characters")

    if "git_blob_sha1" not in src:
        errs.append(f"{label}: missing required field 'git_blob_sha1'")
    elif not (isinstance(src["git_blob_sha1"], str) and _HEX40.fullmatch(src["git_blob_sha1"])):
        errs.append(f"{label}: git_blob_sha1 must be 40 hex characters")

    size = src.get("size_bytes")
    if "size_bytes" not in src:
        errs.append(f"{label}: missing required field 'size_bytes'")
    elif isinstance(size, bool) or not isinstance(size, int) or size <= 0:
        errs.append(f"{label}: size_bytes must be an integer > 0")

    for f in _BOOL_FIELDS:
        if f not in src:
            errs.append(f"{label}: missing required field {f!r}")
        elif not isinstance(src[f], bool):
            errs.append(f"{label}: {f} must be a boolean")

    granted = [f for f in _PERMISSIONS if src.get(f) is True]
    if granted:
        names = " / ".join(granted)
        if src.get("rights_verified") is not True:
            errs.append(f"{label}: {names} is true but rights_verified is not true")
        decision = src.get("decision")
        if not isinstance(decision, dict):
            errs.append(f"{label}: {names} is true but no 'decision' object is recorded")
        else:
            for k in ("by", "basis"):
                if not _nonempty_str(decision.get(k)):
                    errs.append(f"{label}: decision.{k} must be a non-empty string")
            if not _valid_date(decision.get("date")):
                errs.append(f"{label}: decision.date must be a valid YYYY-MM-DD date")

    if src.get("downloaded") is True:
        sha = src.get("sha256")
        if not (isinstance(sha, str) and _HEX64_LOWER.fullmatch(sha)):
            errs.append(f"{label}: downloaded is true so sha256 must be 64 lowercase hex characters")

    return errs


def validate(manifest: dict) -> list[str]:
    """Return human-readable errors; an empty list means the manifest is valid."""
    if not isinstance(manifest, dict):
        return [f"manifest must be a JSON object, got {type(manifest).__name__}"]
    sources = manifest.get("sources")
    if not isinstance(sources, list) or not sources:
        return ["manifest must have a non-empty 'sources' list"]
    seen: set[str] = set()
    errs: list[str] = []
    for i, src in enumerate(sources):
        errs.extend(_validate_source(i, src, seen))
    return errs


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python scripts/validate_manifest.py PATH", file=sys.stderr)
        return 2
    path = Path(argv[0])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError) as e:
        print(f"error: cannot read {path}: {e}", file=sys.stderr)
        return 2
    except json.JSONDecodeError as e:
        print(f"error: invalid JSON in {path}: {e}", file=sys.stderr)
        return 2
    errs = validate(data)
    if errs:
        for e in errs:
            print(e)
        print(f"manifest invalid: {len(errs)} error(s)", file=sys.stderr)
        return 1
    print(f"manifest valid: {len(data['sources'])} source(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
