# Phased Task Plan

Estimates are **rough wall-clock time including human review**. They are not agent compute time and should be re-estimated after Phase 1 gives real throughput data. ⛔ marks an owner gate: work stops until the owner approves.

Machine-readable specs for Phase 1 are in [`tasks/phase1.toml`](../tasks/phase1.toml) and are loaded by the orchestrator.

## Phase 0 — Audit ✅ (this session)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| P0-1 | Environment + CLI audit | Versions, auth, headless smoke tests recorded with commands | ✅ `docs/audit/00-repository-audit.md` |
| P0-2 | Source inventory | Pinned SHA, 15 PDFs with blob SHA/size/presumed rights; no PDF bytes retained | ✅ `docs/audit/source_manifest.json` |
| P0-3 | ADR + risk register | Design covers state machine, isolation, gates, recovery | ✅ `docs/adr/0001…`, `docs/RISK_REGISTER.md` |
| P0-4 | Dry-run controller prototype + tests | `pytest` green; no live execution path | ✅ except recovery policy (owner contribution) |
| P0-5 ⛔ | **Owner rights decisions** | For each source: use / don't use / fetch official copy; recorded in manifest | Waiting on owner |

## Phase 1 — Controller MVP (≈ 5–7 days)

| ID | Owner → Reviewer | Task | Acceptance criteria | Est. |
|---|---|---|---|---|
| P1-1 | Claude → Codex | Initial commit + repo hygiene (`.venv`, `pyproject.toml`, pre-commit secret scan) | `git log` has 1 commit; `pytest` passes in fresh `.venv`; secret scan clean | 0.5 d |
| P1-2 | Claude → Codex | **Live CLI contract tests** in disposable repo: isolation flags, `--allowedTools` syntax, JSON/JSONL parsing, timeout/kill, rate-limit error capture | Each ADR open question answered with captured output; `~/.codex/AGENTS.md` leak verified fixed or fallback documented | 1 d |
| P1-3 | Codex → Claude | Live worktree manager: add/remove, refuse dirty main, detached review checkout, cleanup on restart | Tests on a temp repo: create→commit→review checkout→remove; no stray worktrees after crash test | 1 d |
| P1-4 | Codex → Claude | Subprocess runner: process group, timeout, `stdin=DEVNULL`, scrubbed env, JSONL log capture, redaction | Timeout kills child tree (tested with `sleep`); logs contain no seeded fake token | 1 d |
| P1-5 | Codex → Claude | Controller-executed test gate + `check_scope` on real `git diff --name-only` | Out-of-scope edit fixture → `repair`; failing test fixture → `repair`; 3rd failure → `blocked` | 1 d |
| P1-6 | Claude → Codex | Structured cross-review: shared findings JSON Schema, prompt templates, findings persisted | Both CLIs return schema-valid findings on a seeded-bug fixture; findings visible via `events` | 1 d |
| P1-7 ⛔ | Owner | **First supervised live run**: one Claude task + one Codex review on a toy task | Owner watches; run logs, review findings, approval record inspected; no merge without `approve` | 0.5 d |

## Phase 2 — One vertical lesson: *Functions* (≈ 7–10 days)

| ID | Owner | Task | Acceptance |
|---|---|---|---|
| P2-1 | Codex | Vite + React + TS scaffold, GitHub Pages base path | `npm run build` → `dist/` works under `/<repo>/` in `vite preview --base` |
| P2-2 | Codex | Pyodide (pinned) in Web Worker; timeout + interrupt; restart worker on hang | e2e: `while True: pass` is interrupted and UI recovers |
| P2-3 | Claude | Lesson JSON schema + original *Functions* lesson (all 9 stages from architecture) | Schema-valid; every snippet executes in Pyodide CI; educational review checklist signed by owner |
| P2-4 | Codex | IndexedDB progress, drafts, last position; export/import JSON | e2e: complete → refresh → resume at exact step; export→clear→import restores |
| P2-5 | Claude | 3-node prerequisite graph + next-lesson recommendation + remediation rule | Unit tests on graph; broken edge blocks build |
| P2-6 ⛔ | Owner | Phase 2 review; decide whether to create GitHub remote | — |

## Phase 3 — Ingest MVP (≈ 5–7 days, **requires P0-5**)

Use two owner-approved, openly licensed books fetched from **official sources**. The current candidates are *Think Python 2e* (CC BY-NC 3.0) and *Dive Into Python 3* (CC BY-SA 3.0). Their licenses can't be combined in one lesson, so lesson licensing is tracked separately.

- PyMuPDF extraction with `source_id, sha256, page_start/end, extraction_quality`. A low-confidence page goes to a human review queue.
- Provenance gate: every book-grounded lesson cites `source_id` + page range, and an uncited claim fails the build.
- `dist/` license gate: the build fails if any PDF or extract with `allowed_to_publish: false` is reachable.

## Phase 4 — Curriculum graph (≈ 3–5 weeks)

Core Python path → NumPy/pandas → probability and statistics → linear algebra/calculus for ML → supervised/unsupervised ML → evaluation → applied projects. Statistics and ML need **additional licensed sources** (to be selected in P0-5).

## Phase 5 — Release (≈ 1–2 weeks)

Accessibility audit, performance/size budget, offline caching, GitHub Actions deploy, base-path smoke test on the live URL. ⛔ **Owner approves every production deploy.**
