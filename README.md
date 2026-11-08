# Python Intelligence

A static GitHub Pages learning platform for Python, data science, statistics and ML, built by two coordinated CLI agents (Claude Code + Codex) under a local, human-gated orchestrator.

| Read this | For |
|---|---|
| `MASTER_ARCHITECTURE.md` | The owner's requirements and constraints |
| `docs/audit/00-repository-audit.md` | Phase 0 audit: environment, CLIs, PDF source rights |
| `docs/adr/0001-dual-agent-orchestrator.md` | How the orchestrator works |
| `docs/TASKS.md` | Phased plan and status |
| `docs/RISK_REGISTER.md` | Open risks |

## Learning site quick start

```bash
npm ci
npm run dev            # http://localhost:5173
npm test               # unit tests (vitest)
npm run build          # content gate -> typecheck -> vite build -> dist gate
npm run test:e2e       # Playwright against dist/ served under /python-intelligence/
```

Lessons are JSON in `content/lessons/`, validated by `scripts/validate_content.py`. Every example, solution and
starter is executed with the same `src/py/harness.py` that the browser runs in Pyodide.

## Book sources (internal only, never published)

```bash
python3 -m venv .venv && .venv/bin/pip install "pytest>=8" "pymupdf==1.28.2"
.venv/bin/python -m ingest --manifest docs/audit/source_manifest.json   # -> sources/extracts/ (gitignored)
python3 scripts/fetch_web_source.py       # official docs in docs/audit/web_sources.json -> sources/extracts/
python3 scripts/build_source_catalog.py   # -> content/sources.json (+ source_sections.json): facts only
```

Only sources the rights manifest clears are extracted. Book-grounded lessons cite `sources[]` by PDF page range and
section heading; the build fails on a false citation, an uncited claim step, or 12+ words copied from an extract.
A local build with extracts also regenerates `content/provenance/` (hashes of every 12-word run in the books, no
text); commit it when sources change. CI scans lessons and the deployed bundle against it.

## Orchestrator quick start

```bash
python3 -m pytest                                  # unit tests (no network, no agents)
python3 -m orchestrator preflight                  # binaries, pinned versions, git
python3 -m orchestrator load tasks/phase1.toml
python3 -m orchestrator tick -n 5                  # dry-run: plans and records commands only
python3 -m orchestrator status
python3 -m orchestrator approve P1-1 --by <you>    # human gate: required before any merge
python3 -m orchestrator events --task P1-1         # audit trail
python3 -m orchestrator run --live                 # REALLY run claude/codex until a human gate
python3 -m orchestrator reject P2-4 --by <you> --with-findings --feedback "..."  # send back
python3 -m orchestrator accept P3-4 --by <you> --reason "..."   # blocked but tested -> gate (still needs approve)
```

State lives in `.orchestrator/state.sqlite3` (gitignored). The orchestrator is local-only and is never deployed.
