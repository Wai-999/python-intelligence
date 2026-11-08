"""Fetch an owner-cleared web source (e.g. the official Python docs) into the internal extract format.

Usage: python scripts/fetch_web_source.py [--only SOURCE_ID] [--update-sha]

Reads docs/audit/web_sources.json. For each source with allowed_for_internal_extraction, downloads its pinned
URL and writes sources/extracts/<source_id>/{pages.jsonl, meta.json, review_queue.json} like `python -m ingest`
does for PDFs. Each Sphinx <section> becomes one "page" (numbered in document order) whose text is the section's
own prose, so citations use [n, n] page ranges plus the section heading, and the copy check and hashed index
cover the page exactly like a book. The fetched HTML's sha256 must match the registry; pass --update-sha to
record a new one after reviewing that the page still says what lessons cite it for.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REGISTRY = ROOT / "docs" / "audit" / "web_sources.json"
OUT = ROOT / "sources" / "extracts"
SKIP_TAGS = {"script", "style", "nav", "header", "footer"}
HEADINGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4}


class SectionParser(HTMLParser):
    """Splits a Sphinx page into sections: (level, title, anchor, own text)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.sections: list[dict] = []
        self.depth = 0          # <section> nesting depth
        self.skip = 0           # inside script/style/nav...
        self.heading: str | None = None
        self.in_headerlink = False
        self.main = False       # inside the document body (div role=main)
        self.main_depth = 0

    def _cur(self):
        return self.sections[-1] if self.sections else None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "div" and a.get("role") == "main":
            self.main, self.main_depth = True, 0
        if self.main and tag == "div":
            self.main_depth += 1
        if not self.main:
            return
        if tag in SKIP_TAGS:
            self.skip += 1
        elif tag == "section":
            self.depth += 1
            self.sections.append({"level": self.depth, "anchor": a.get("id", ""), "title": "", "text": []})
        elif tag in HEADINGS and self._cur() is not None and not self._cur()["title"]:
            self.heading = tag
        elif tag == "a" and "headerlink" in (a.get("class") or ""):
            self.in_headerlink = True

    def handle_endtag(self, tag):
        if not self.main:
            return
        if tag == "div":
            self.main_depth -= 1
            if self.main_depth <= 0:
                self.main = False
        elif tag in SKIP_TAGS and self.skip:
            self.skip -= 1
        elif tag == "section":
            self.depth -= 1
        elif tag == self.heading:
            self.heading = None
        elif tag == "a":
            self.in_headerlink = False

    def handle_data(self, data):
        cur = self._cur()
        if not self.main or self.skip or cur is None or self.in_headerlink:
            return
        if self.heading:
            cur["title"] += data
        else:
            cur["text"].append(data)


def to_records(html: str, source_id: str, sha: str) -> tuple[list[dict], list[list]]:
    p = SectionParser()
    p.feed(html)
    records, toc = [], []
    for i, s in enumerate(p.sections, 1):
        title = " ".join(s["title"].split())
        text = "\n".join(line.strip() for line in "".join(s["text"]).splitlines() if line.strip())
        records.append({"source_id": source_id, "sha256": sha, "page": i, "label": None, "text": text,
                        "chars": len(text), "extraction_quality": 1.0, "flags": [], "code_blocks": [],
                        "anchor": s["anchor"]})
        toc.append([min(s["level"], 4), title, i])
    return records, toc


def fetch(src: dict, update_sha: bool) -> dict:
    req = urllib.request.Request(src["url"], headers={"User-Agent": "python-intelligence-ingest/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    sha = hashlib.sha256(raw).hexdigest()
    if src.get("sha256") and src["sha256"] != sha and not update_sha:
        raise SystemExit(f"✗ {src['source_id']}: page changed (sha256 {sha[:12]} != registry {src['sha256'][:12]}); "
                         "review it, then re-run with --update-sha")
    src["sha256"] = sha
    records, toc = to_records(raw.decode("utf-8"), src["source_id"], sha)
    d = OUT / src["source_id"]
    d.mkdir(parents=True, exist_ok=True)
    (d / "pages.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records))
    (d / "meta.json").write_text(json.dumps({"source_id": src["source_id"], "sha256": sha, "page_count": len(records),
                                             "extractor": "fetch_web_source (html.parser)", "toc": toc,
                                             "anchors": {r["page"]: r["anchor"] for r in records},
                                             "quality": {"mean": 1.0, "low_pages": 0}, "review_threshold": 0.6},
                                            ensure_ascii=False, indent=1) + "\n")
    (d / "review_queue.json").write_text("[]\n")
    return {"source_id": src["source_id"], "sections": len(records), "sha256": sha}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--update-sha", action="store_true")
    a = ap.parse_args(argv)
    reg = json.loads(REGISTRY.read_text())
    for src in reg["sources"]:
        if a.only and src["source_id"] != a.only:
            continue
        if not src.get("allowed_for_internal_extraction"):
            print(f"· {src['source_id']}: not cleared for internal extraction, skipped")
            continue
        r = fetch(src, a.update_sha)
        print(f"✓ {r['source_id']}: {r['sections']} sections, sha256 {r['sha256'][:12]}")
    REGISTRY.write_text(json.dumps(reg, indent=1, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
