"""Verbatim-copy detection against local source extracts (sources/extracts/<id>/pages.jsonl).

Lessons must be original prose and code that *cite* books, never copy them. We compare word n-grams
("shingles") of lesson or bundle text with every page of every local extract: any shared run of SHINGLE
consecutive normalised words is reported with the source page it came from.

Extracts are internal (gitignored, never published), so this check runs where they exist (the owner's
machine). A passing run records each lesson file's sha256 in content/provenance_attestation.json; where
extracts are absent (CI), validate_content.py requires every lesson to match that record, so a lesson
that changed without being copy-checked cannot be released. Page ranges, sections and licences are
checked everywhere against content/sources.json.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# PI_EXTRACTS lets agent worktrees (which have no sources/) point at the owner's extracts, read-only.
EXTRACTS = Path(os.environ.get("PI_EXTRACTS") or ROOT / "sources" / "extracts")
SHINGLE = 12
_WORD = re.compile(r"[a-z0-9_]+")
_ESCAPE = re.compile(r"\\(?:u\{?([0-9a-fA-F]{4,6})\}?|x([0-9a-fA-F]{2})|[nrtbfv0'\"`\\/])")


def unescape_js(text: str) -> str:
    """Decode string-literal escapes found in bundled JS/JSON so copied prose can't hide behind them."""
    def sub(m: re.Match) -> str:
        code = m.group(1) or m.group(2)
        if code:
            try:
                return chr(int(code, 16))
            except ValueError:
                return " "
        return " " if m.group(0)[1] in "nrtbfv0" else m.group(0)[1]
    return _ESCAPE.sub(sub, text)


def words(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def shingles(ws: list[str], n: int = SHINGLE):
    for i in range(len(ws) - n + 1):
        yield " ".join(ws[i:i + n])


@dataclass(frozen=True)
class Match:
    source_id: str
    page: int
    phrase: str


class ExtractIndex:
    """Maps each shingle of the local extracts to its first (source_id, page)."""

    def __init__(self, root: Path = EXTRACTS, n: int = SHINGLE):
        self.n = n
        self.index: dict[str, tuple[str, int]] = {}
        self.sources: list[str] = []
        self.shas: dict[str, str] = {}  # source_id -> sha256 of the PDF the extract came from
        if not root.is_dir():
            return
        for pages in sorted(root.glob("*/pages.jsonl")):
            sid = pages.parent.name
            self.sources.append(sid)
            meta = pages.parent / "meta.json"
            if meta.is_file():
                self.shas[sid] = json.loads(meta.read_text(encoding="utf-8"))["sha256"]
            for line in pages.read_text(encoding="utf-8").splitlines():
                rec = json.loads(line)
                for sh in shingles(words(rec["text"]), n):
                    self.index.setdefault(sh, (sid, rec["page"]))

    @property
    def available(self) -> bool:
        return bool(self.index)

    def find(self, text: str, limit: int = 3) -> list[Match]:
        out: list[Match] = []
        seen_pages: set[tuple[str, int]] = set()
        for sh in shingles(words(text), self.n):
            hit = self.index.get(sh)
            if hit and hit not in seen_pages:
                seen_pages.add(hit)
                out.append(Match(hit[0], hit[1], sh))
                if len(out) >= limit:
                    break
        return out


def strings_in(obj) -> list[str]:
    """Every string value in a JSON-like object, in document order."""
    if isinstance(obj, str):
        return [obj]
    if isinstance(obj, dict):
        return [s for v in obj.values() for s in strings_in(v)]
    if isinstance(obj, list):
        return [s for v in obj for s in strings_in(v)]
    return []
