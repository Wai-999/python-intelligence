# Phased Task Plan

Estimates are **rough wall-clock time including human review**. They are not agent compute time and should be re-estimated after Phase 1 gives real throughput data. ⛔ marks an owner gate: work stops until the owner approves.

Machine-readable specs for Phase 1 are in [`tasks/phase1.toml`](../tasks/phase1.toml) and are loaded by the orchestrator.

## Phase 0 — Audit ✅ (this session)

| ID | Task | Acceptance | Status |
|---|---|---|---|
| P0-1 | Environment + CLI audit | Versions, auth, headless smoke tests recorded with commands | ✅ `docs/audit/00-repository-audit.md` |
| P0-2 | Source inventory | Pinned SHA, 15 PDFs with blob SHA/size/presumed rights; no PDF bytes retained | ✅ `docs/audit/source_manifest.json` |
| P0-3 | ADR + risk register | Design covers state machine, isolation, gates, recovery | ✅ `docs/adr/0001…`, `docs/RISK_REGISTER.md` |
| P0-4 | Dry-run controller prototype + tests | `pytest` green | ✅ (recovery policy implemented 2026-11-08) |
| P0-5 ⛔ | **Owner rights decisions** | For each source: use / don't use / fetch official copy; recorded in manifest | ✅ 2026-11-08: owner said "download pdf". 5 openly available titles downloaded to `sources/pdfs/` (gitignored); extraction cleared for Think Python 2e, Dive Into Python 3, Automate the Boring Stuff; MML and Big Book are reference-only; 9 commercial / suspected-unauthorized copies not downloaded. Nothing publishable. |

## Phase 1 — Controller MVP ✅ (completed 2026-11-08)

| ID | Owner → Reviewer | Task | Acceptance criteria | Est. |
|---|---|---|---|---|
| P1-1 | Claude → Codex | Initial commit + repo hygiene (`.venv`, `pyproject.toml`, pre-commit secret scan) | `git log` has 1 commit; `pytest` passes in fresh `.venv`; secret scan clean | 0.5 d |
| P1-2 | Claude → Codex | **Live CLI contract tests** in disposable repo: isolation flags, `--allowedTools` syntax, JSON/JSONL parsing, timeout/kill, rate-limit error capture | Each ADR open question answered with captured output; `~/.codex/AGENTS.md` leak verified fixed or fallback documented | 1 d |
| P1-3 | Codex → Claude | Live worktree manager: add/remove, refuse dirty main, detached review checkout, cleanup on restart | Tests on a temp repo: create→commit→review checkout→remove; no stray worktrees after crash test | 1 d |
| P1-4 | Codex → Claude | Subprocess runner: process group, timeout, `stdin=DEVNULL`, scrubbed env, JSONL log capture, redaction | Timeout kills child tree (tested with `sleep`); logs contain no seeded fake token | 1 d |
| P1-5 | Codex → Claude | Controller-executed test gate + `check_scope` on real `git diff --name-only` | Out-of-scope edit fixture → `repair`; failing test fixture → `repair`; 3rd failure → `blocked` | 1 d |
| P1-6 | Claude → Codex | Structured cross-review: shared findings JSON Schema, prompt templates, findings persisted | Both CLIs return schema-valid findings on a seeded-bug fixture; findings visible via `events` | 1 d |
| P1-7 ⛔ | Owner | **First supervised live run**: one Claude task + one Codex review on a toy task | Owner watches; run logs, review findings, approval record inspected; no merge without `approve` | 0.5 d |

## Phase 2 — One vertical lesson: *Functions* ✅ (completed 2026-11-08, not deployed)

Status: Vite/React/TS app; Pyodide 0.27.8 worker with timeout-by-termination; 3 original lessons (Functions has the
full 9-stage arc); prerequisite graph, recommendation and remediation; IndexedDB progress with export/import
(implemented by Codex via the orchestrator over 3 attempts, reviewed by Claude); content gate, dist gate, and
6 Playwright e2e tests against the production build served under a sub-path, all passing. P2-6 (owner review,
create a GitHub remote) remains open.

| ID | Owner | Task | Acceptance |
|---|---|---|---|
| P2-1 | Codex | Vite + React + TS scaffold, GitHub Pages base path | `npm run build` → `dist/` works under `/<repo>/` in `vite preview --base` |
| P2-2 | Codex | Pyodide (pinned) in Web Worker; timeout + interrupt; restart worker on hang | e2e: `while True: pass` is interrupted and UI recovers |
| P2-3 | Claude | Lesson JSON schema + original *Functions* lesson (all 9 stages from architecture) | Schema-valid; every snippet executes in Pyodide CI; educational review checklist signed by owner |
| P2-4 | Codex | IndexedDB progress, drafts, last position; export/import JSON | e2e: complete → refresh → resume at exact step; export→clear→import restores |
| P2-5 | Claude | 3-node prerequisite graph + next-lesson recommendation + remediation rule | Unit tests on graph; broken edge blocks build |
| P2-6 ⛔ | Owner | Phase 2 review; decide whether to create GitHub remote | — |

## Phase 3 — Ingest MVP ✅ core done 2026-11-08 (P0-5 done)

Status: 3 cleared books extracted (1,236 pages, 7 s); provenance gate and citation UI live; 2 book-grounded
lessons (*Decisions*, *Repetition*) cite Think Python 2e and Dive Into Python 3 as references (original prose).

| ID | Owner → Reviewer | Task | Acceptance | Status |
|---|---|---|---|---|
| P3-1 | Codex → Claude | `ingest/`: PyMuPDF page extraction (sha-checked bytes, page labels, quality score, code blocks), review queue, manifest-validated CLI that refuses uncleared sources and non-ignored output dirs | `tests/test_ingest.py` | ✅ merged on attempt 2 (attempt 1 rejected: manifest-validator bypass, path escape, TOCTOU) |
| P3-2 | Claude → Codex | Provenance gate: cleared + catalogued source, page range, section heading in range, every claim step cites, every source cited, adapted-licence rule; 12-word verbatim check of lessons and `dist/` against local extracts | `tests/test_provenance.py`; build | ✅ |
| P3-3 | Claude → Codex | Lessons `py-conditionals`, `py-loops`; per-step source line with printed page numbers; Further reading per book | content gate; e2e citation test | ✅ |
| P3-4 | Codex → Claude | Extractor hardening: indentation-preserving code blocks (font-measured), ≥80%-monospace lines, gap-split listings, set-atomic output directory with fsync, id collision/control-char checks | `tests/test_ingest.py` (50) | ✅ merged via `accept` after 3 attempts (attempt 3: 0 blocking). Real books: parseable multi-line code 8%→79% (Think Python), 10%→29% (Dive Into Python 3) |
| P3-5 ⛔ | Owner | Educational review of the two new lessons; human pass over each `review_queue.json` | — | open |
| P3-6 | Codex → Claude | Extractor follow-ups from P3-4 attempt-3 review: origin=0 fallback skews indentation; column/side-by-side listings merge (negative gap); PEP 8 double blank lines split a listing; no lock for concurrent runs; cleanup errors abort a completed batch; collision check scope. Also: Automate the Boring Stuff yields 0 code blocks (its code font is not flagged monospaced); strip Dive Into Python 3 callout markers (①) | tests + real-book parse rate | open | → ✅ merged (Automate 0→36% parseable listings; Think Python 79→75%, regression tracked in P3-7)
| P3-7 | Codex → Claude | Recover Think Python listings (same-baseline fragments), pitch fallback, column jumps, callout spacing | `tests/test_ingest.py` (88) + `scripts/bench_code_blocks.py` floors | ✅ merged on attempt 2: Think Python 79.1%, Dive Into Python 3 36.1%, Automate 36.0% parseable |
| P3-8 | Codex → Claude | Extractor edge cases from the P3-7 review | tests + benchmark floors | ✅ merged: Dive Into Python 3 40.7%, others held. Backlog (low priority; code blocks are not used in published content): callouts at the start of a merged fragment, cross-block tall-glyph grouping, bullet check without a horizontal limit, prefix width in mixed fonts |

Copy check: the owner's build compares lessons and `dist/` with the local extracts and regenerates
`content/provenance/` (index.json + shingles.bin: 317k 48-bit BLAKE2b hashes of every 12-word run in the cleared books;
no book text). CI, which has no extracts, scans lessons AND the exact deployed bundle against that hashed index, and
fails if it is missing, tampered with, or does not cover every catalogued book. Agents can never edit
`content/provenance/**`, `content/sources.json` or `content/source_sections.json` (orchestrator deny list).
Codex cross-review of P3-2/P3-3: round 1 (1 high, 5 medium) and round 2 (1 high, 2 medium) all addressed; the
round-1 lesson-only "attestation" was replaced by the hashed index because it covered neither the deployed artifact
nor tampering. Round 3 confirmed both fixed; its remaining point (a blocklist can't fully enforce the
arithmetic-only digits exercise) was resolved by wording the exercise honestly instead of claiming enforcement.

## Phase 4 — Curriculum graph (≈ 3–5 weeks) — in progress

Core Python path → NumPy/pandas → probability and statistics → linear algebra/calculus for ML → supervised/unsupervised ML → evaluation → applied projects. Statistics and ML need **additional licensed sources** (owner decision).

| ID | Owner → Reviewer | Task | Status |
|---|---|---|---|
| P4-1 | Claude → Codex | Core path: `py-strings`, `py-lists`, `py-dicts` (book-grounded, 9-step arc); lists now requires strings; map order continues the current chain | ✅ Codex review: 6 medium (3 factual: string-method returns, `pop` return, hashable keys; 2 weak tests; dict order not in cited books) all fixed |
| P4-2 | Claude → Codex | Cite official Python docs: `docs/audit/web_sources.json` registry (PSF licence, pinned 3.12 URL, sha256), `scripts/fetch_web_source.py` (Sphinx sections → numbered pages in the extract format, so range/section/copy checks and the hashed index work unchanged), section deep links in the UI. Cited: dict order + hashable keys, int→str digit limit, truth-value testing | ✅ Codex: 1 high (catalog not bound to registry sha) + 1 medium (parser parent text) fixed; re-review approved, 0 findings |
| P4-3 | Claude → Codex | Core path continued: `py-tuples`, `py-comprehensions`, `py-exceptions` (books + docs) | ✅ Codex: 5 medium (overbroad comprehension rule, unchecked syntax, 3 unsupported citations) fixed; re-review approved, 0 findings |
| P4-5 | Claude → Codex | Core path: `py-modules`, `py-files`, `py-classes` (books + 3 tutorial pages); validator snippets now run in an isolated temp dir; e2e proves file I/O in Pyodide | ✅ Codex: 4 medium (retry failure from persistent browser FS, 2 weak tests, 'math is a .py file') fixed (fresh folder per run in the shared harness); re-review approved, 0 findings |
| P4-4 ⛔ | Owner | Choose licensed sources for NumPy/pandas, statistics and ML (P0-5 style decision) | open |

## Phase 5 — Release (≈ 1–2 weeks)

Accessibility audit, performance/size budget, offline caching, GitHub Actions deploy, base-path smoke test on the live URL. ⛔ **Owner approves every production deploy.**
