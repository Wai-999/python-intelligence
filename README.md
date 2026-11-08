# Python Intelligence

A static GitHub Pages learning platform for Python, data science, statistics and ML, built by two coordinated CLI agents (Claude Code + Codex) under a local, human-gated orchestrator.

| Read this | For |
|---|---|
| `MASTER_ARCHITECTURE.md` | The owner's requirements and constraints |
| `docs/audit/00-repository-audit.md` | Phase 0 audit: environment, CLIs, PDF source rights |
| `docs/adr/0001-dual-agent-orchestrator.md` | How the orchestrator works |
| `docs/TASKS.md` | Phased plan and status |
| `docs/RISK_REGISTER.md` | Open risks |

## Orchestrator quick start

```bash
python3 -m pytest                                  # unit tests (no network, no agents)
python3 -m orchestrator preflight                  # binaries, pinned versions, git
python3 -m orchestrator load tasks/phase1.toml
python3 -m orchestrator tick -n 5                  # dry-run: plans and records commands only
python3 -m orchestrator status
python3 -m orchestrator approve P1-1 --by <you>    # human gate: required before any merge
python3 -m orchestrator events --task P1-1         # audit trail
```

State lives in `.orchestrator/state.sqlite3` (gitignored). The orchestrator is local-only and is never deployed.
