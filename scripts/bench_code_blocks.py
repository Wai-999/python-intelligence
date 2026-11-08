"""Real-book benchmark for the extractor's code-block detection (local only: needs the cleared PDFs).

Usage: python scripts/bench_code_blocks.py [--pdf-root DIR] [--min SOURCE_ID=PERCENT ...]

Extracts every cleared, downloaded source into a temporary directory with the ingest package on sys.path
(so a worktree can benchmark its own code against the owner's PDFs via --pdf-root), and reports, per book,
how many multi-line non-REPL code blocks parse as Python after dedenting. With --min, exits 1 if any book
falls below its floor, which makes it usable as an acceptance command. Prints numbers only, never book text.
"""

from __future__ import annotations

import argparse
import ast
import json
import sys
import tempfile
import textwrap
import warnings
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def parses(block: str) -> bool:
    try:
        ast.parse(textwrap.dedent(block))
        return True
    except SyntaxError:
        return False


def bench(pdf_root: Path) -> dict[str, dict]:
    from ingest.extract import extract  # the ingest package of THIS checkout
    manifest = json.loads((ROOT / "docs" / "audit" / "source_manifest.json").read_text())
    out: dict[str, dict] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for s in manifest["sources"]:
            if not (s.get("allowed_for_internal_extraction") and s.get("downloaded")):
                continue
            extract(pdf_root / s["local_path"], s["source_id"], Path(tmp), expected_sha256=s["sha256"])
            pages = (Path(tmp) / s["source_id"] / "pages.jsonl").read_text().splitlines()
            blocks = [b for line in pages for b in json.loads(line)["code_blocks"]]
            scripts = [b for b in blocks if b.count("\n") >= 2 and ">>>" not in b]
            ok = sum(map(parses, scripts))
            out[s["source_id"]] = {"blocks": len(blocks), "scripts": len(scripts), "parse_ok": ok,
                                   "percent": round(100 * ok / len(scripts), 1) if scripts else 0.0}
    return out


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--pdf-root", type=Path, default=ROOT, help="repo root that holds sources/pdfs (default: this one)")
    ap.add_argument("--min", action="append", default=[], metavar="SOURCE_ID=PERCENT")
    a = ap.parse_args(argv)
    warnings.filterwarnings("ignore")
    res = bench(a.pdf_root)
    for sid, r in res.items():
        print(f"{sid:45} blocks={r['blocks']:5} scripts={r['scripts']:4} parse_ok={r['parse_ok']:4} ({r['percent']}%)")
    failed = []
    for spec in a.min:
        sid, _, pct = spec.partition("=")
        got = res.get(sid, {}).get("percent", 0.0)
        if got < float(pct):
            failed.append(f"{sid}: {got}% < required {pct}%")
    for f in failed:
        print(f"✗ {f}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
