"""Release gate for the built site. Usage: python scripts/check_dist.py dist

Fails (exit 1) if dist/ contains: any PDF or e-book file; anything derived from sources/;
credential-shaped strings; orchestrator state/logs; or exceeds the size budget.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orchestrator.redact import _PATTERNS  # noqa: E402

FORBIDDEN_SUFFIXES = {".pdf", ".epub", ".mobi", ".djvu", ".sqlite3", ".log"}
FORBIDDEN_PARTS = {"sources", ".orchestrator", "logs", "worktrees"}
BUDGET_BYTES = 2_000_000  # Pyodide itself is loaded from the pinned CDN, not shipped in dist/


def main(dist: str) -> int:
    root = Path(dist)
    if not (root / "index.html").is_file():
        print(f"✗ {root}/index.html missing")
        return 1
    errs, total = [], 0
    for p in root.rglob("*"):
        if not p.is_file():
            continue
        total += p.stat().st_size
        rel = p.relative_to(root)
        if p.suffix.lower() in FORBIDDEN_SUFFIXES:
            errs.append(f"forbidden file type: {rel}")
        if FORBIDDEN_PARTS & set(rel.parts):
            errs.append(f"forbidden path: {rel}")
        if p.suffix in {".js", ".css", ".html", ".json", ".txt", ".map"}:
            text = p.read_text(errors="ignore")
            if any(pat.search(text) for pat in _PATTERNS[:5]):
                errs.append(f"credential-shaped string in {rel}")
            if "/sources/" in text or "PythonCentralHub/books" in text:
                errs.append(f"reference to restricted source material in {rel}")
    if total > BUDGET_BYTES:
        errs.append(f"dist is {total:,} bytes, over budget {BUDGET_BYTES:,}")
    if errs:
        print("\n".join(f"✗ {e}" for e in errs))
        return 1
    print(f"✓ dist gate passed: {sum(1 for p in root.rglob('*') if p.is_file())} files, {total:,} bytes, no PDFs or restricted sources")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "dist"))
