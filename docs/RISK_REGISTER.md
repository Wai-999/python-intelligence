# Risk Register

Scales: L(ikelihood) and I(mpact) are each 1–3. Score = L×I. Owner is the person or agent responsible for the mitigation.

| ID | Risk | L | I | Score | Mitigation | Owner | Status |
|---|---|---|---|---|---|---|---|
| R1 | Using or republishing copyrighted PDFs (9 of 15 presumed commercial, 3 with piracy-site markers) | 3 | 3 | **9** | Manifest is blocked by default. Don't download commercial titles. Fetch open titles from official sites. `dist/` license gate. | Owner + Claude | Owner decided 2026-11-08: only open/free titles downloaded (gitignored); commercial titles not downloaded; dist gate unchanged |
| R2 | User-global instructions/MCP leak into workers, making behaviour non-reproducible | 3 | 2 | **6** | Claude: `--setting-sources project,local --strict-mcp-config --disable-slash-commands`. Codex: dedicated `CODEX_HOME` with symlinked auth (`--ignore-user-config` alone leaks). | Claude | **Mitigated + verified** (docs/audit/01-cli-contract.md) |
| R3 | An agent self-reports success that isn't real | 2 | 3 | **6** | Controller runs acceptance commands. Cross-agent review against an immutable SHA. | Controller | Implemented and exercised live |
| R4 | Silent merge/deploy | 1 | 3 | 3 | Approval bound to SHA, enforced in `db.transition`. `tick()` cannot reach gated states (tested). Pages deploys automatically on push to main by owner decision (2026-11-08), only after every CI gate passes. | Controller | Implemented and exercised live (S1, S2, P2-4) |
| R5 | Codex alpha CLI flag drift / app auto-update | 2 | 2 | 4 | Pin version in preflight. Refuse live mode on mismatch. | Codex | Designed |
| R6 | Subscription rate limits / no spend telemetry | 2 | 2 | 4 | Concurrency ≤ 2, one session per agent, retry cap 2, record run durations. | Owner | Accepted |
| R7 | Agent escapes task scope (edits CI, secrets, other worktrees) | 2 | 3 | **6** | Worktree per task, `check_scope()` deny-list, workspace-write sandbox, no bypass flags (tested). | Controller | Implemented and exercised live (S1, S2, P2-4) |
| R8 | Crash leaves orphaned in-flight tasks / half-made worktrees | 2 | 2 | 4 | SQLite WAL, CAS transitions, `recover_orphans()` at startup. | Controller | Implemented: first crash refunds the attempt, repeats count, high-risk tasks block |
| R9 | License incompatibility between SA and NC sources in one lesson | 2 | 2 | 4 | Per-lesson `license` field. Schema check blocks mixing. | Claude | Phase 3 |
| R10 | Pyodide isn't a security boundary; learners run hostile code | 2 | 1 | 2 | Web Worker, timeouts, clear disclosure, no secrets in page. | Codex | Phase 2 |
| R11 | Secrets in logs (tokens appear in CLI output) | 2 | 3 | **6** | `redact()` applied before DB writes. Logs gitignored. Secret scan gate. | Controller | Implemented (basic patterns) |
| R12 | Path contains spaces ("My Porfolio") and breaks shell commands | 2 | 1 | 2 | argv lists only, never `shell=True`. | All | Implemented |
| R13 | Mistaken full download of source PDFs via lazy fetch | 2 | 2 | 4 | `GIT_NO_LAZY_FETCH=1` for inventory. Documented in audit (it happened once and was corrected). | Claude | Mitigated |
| R14 | Each Claude worker call loaded ~390k tokens of user-level context (MCP/plugins/skills) | 3 | 2 | 6 | `--strict-mcp-config --disable-slash-commands` brings it to ~3k (verified) | Controller | Mitigated |
| R15 | Lesson snippets validated on local CPython 3.13, while the browser runs 3.12.7 | 1 | 2 | 2 | CI pins Python 3.12; locally the content gate uses a project-local CPython 3.12 (.venv312) with the browser's numpy/pandas versions, and refuses mismatched package versions. | Claude | **Closed** |
| R16 | Lesson or site text copies a cited book (licence/copyright breach) on an auto-deployed site | 2 | 3 | **6** | 12-word shingle check of lessons and `dist/`: exact pages locally, committed hashed index in CI; evidence files on the agent deny list; cross-reviewed by Codex | Claude | Mitigated |
| R17 | Reference-only books (MML: personal-use PDF; Big Book: PDF of unconfirmed origin) used beyond citation | 2 | 3 | **6** | Manifest `reference_only` (not the generated catalog) is the authority; gate rejects `adapted` use; shingle copy check covers both books; lessons are original; PDFs gitignored, never published. If the owner wants to adapt, obtain licences first | Claude | Mitigated |
