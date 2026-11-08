"""Fail if staged/tracked text files contain credential-shaped strings. Usage: python scripts/secret_scan.py [files...]"""
import subprocess, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from orchestrator.redact import _PATTERNS  # noqa: E402

files = sys.argv[1:] or subprocess.run(["git", "ls-files"], capture_output=True, text=True, check=True).stdout.split()
hits = []
for f in files:
    p = Path(f)
    if not p.is_file() or p.suffix in {".png", ".jpg", ".pdf", ".woff2", ".ico"} or p.parts[:1] == ("tests",):
        continue
    for n, line in enumerate(p.read_text(errors="ignore").splitlines(), 1):
        if any(pat.search(line) for pat in _PATTERNS[:5]):  # token patterns only (not key=value prose)
            hits.append(f"{f}:{n}")
print("\n".join(hits) or "secret scan: clean")
sys.exit(1 if hits else 0)
