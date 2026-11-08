# Python Intelligence — Master Architecture and Execution Plan

## Owner decisions
- Scope: complete Python curriculum with emphasis on data science, statistics, and ML.
- PDF input: `https://github.com/Ravikisha/PythonCentralHub/tree/main/books` (third-party; inventory and licensing unverified until cloned).
- Agents: installed **Claude Code CLI** and **Codex CLI**; no API keys required by design, subject to each tool's account access and terms.
- Orchestration: local macOS Python controller, automated tasks/reviews with approval gates.
- Deployment: **GitHub Pages only**; static frontend, Pyodide/Web Worker execution, no server backend.
- Learning: adaptive prerequisite graph, professor-style explanations, practical projects, progress checkpoints, visualizations.

## Non-negotiable constraints
1. Do not clone or publish third-party PDFs to the deployed website without individual permission/license review. MIT license on repository code does not automatically cover PDFs.
2. Never assume PDFs are correctly extracted. Track provenance (repository commit SHA, PDF hash, page, extraction confidence) and require human review for generated instructional content.
3. No embedded model API keys in browser. A live LLM tutor cannot be securely offered with GitHub Pages alone; ship offline guided tutor first. Optional user-provided API access must be separately designed with clear risk disclosure.
4. Browser Python via Pyodide Web Worker, interrupt/time limits where feasible, no privileged host access. Browser execution is not a security boundary for hostile code; do not imply complete isolation.
5. Persist progress with IndexedDB and provide export/import. No cross-device sync promise.
6. Keep the orchestrator local; never deploy it or CLI credentials to GitHub Pages.
7. No force pushes, production deployments, secret access, purchases, or destructive operations without explicit approval.

## Target system
### Build-time knowledge ingestion
- Clone source repo to a separate, ignored `sources/` directory; pin commit SHA.
- Inventory PDF names, size, hash, metadata, likely license; mark each `allowed_to_publish: false` by default.
- Extract with PyMuPDF, inspect layout/tables/code blocks; handle scanned pages with manual review or optional OCR.
- Normalize into structured records: `source_id`, `sha256`, `chapter`, `page_start`, `page_end`, `concept_id`, `extraction_quality`, `rights_status`.
- Create original explanations, verified Python snippets, exercises and citations; keep source extracts internal unless permission exists.
- Build static JSON content bundles with deterministic schema validation and provenance checks.
- Supplement missing statistics/ML coverage only with verified, appropriately licensed sources and cite them.

### Runtime frontend
- Vite + React + TypeScript, GitHub Pages base-path aware routing.
- Pyodide loaded lazily in Web Worker, version-pinned; clear package-compatibility notices.
- Code editor, console, tests, interactive visualizations, debug walkthroughs.
- IndexedDB for lessons, code drafts, mastery estimates, spaced repetition, last-position checkpoints.
- Curriculum directed acyclic graph: prerequisites, concept edges, unlock rules, next-lesson recommendation, remediation.
- AI-professor *experience* in static mode: guided explanations, Socratic question bank, feedback templates, source-grounded search; clearly label non-generative behavior.
- Accessible mobile-first UX; offline caching where practical, not guaranteed for all Pyodide assets.

### Curriculum progression
Python fundamentals → idiomatic Python → algorithms/OOP/testing → NumPy/pandas → probability/statistics → linear algebra/calculus for ML → supervised/unsupervised ML → evaluation/interpretability → applied projects (economics, climate, agriculture, finance).
Each lesson: motivating problem → intuition → visual → formal model → runnable code → guided practice → independent challenge → assessment → recommendation. Provide prerequisite remediation and exact resume point.

## Dual CLI agent architecture
- Controller: Python 3.11+, SQLite job state, subprocess wrappers, task DAG, branch/worktree isolation, JSON logs.
- Workers: Claude Code CLI `claude -p ...`; Codex CLI `codex exec ...`; verify locally installed flags before running.
- Worktrees: `worktrees/task-<id>-<agent>` and unique branches `agent/<agent>/<task-id>`.
- Never run two writers in one worktree. Integrate through PR/merge queue only after tests.
- Task schema: id, title, owner, dependencies, allowed paths, acceptance tests, risk level, max attempts, review owner, status, commit SHA.
- State machine: queued → ready → running → implemented → testing → review → awaiting_approval → merged → released; failures → blocked/repair.
- Reviewer is different agent than implementer; reviewers produce structured findings and evidence, not silent edits.
- Enforce concurrency=2 maximum initially, task timeout, retry cap=2, spending/usage monitoring, redaction, no auto-escalation of permissions.
- CLI authentication and headless execution compatibility must be verified before enabling unattended execution; if CLI auth or policy blocks unattended mode, stop and request owner intervention.

## Security and release gates
- Default no arbitrary network calls from tasks; isolate source PDFs from deployed assets.
- Preflight: clean repo, binaries installed, Git identity, authentication, tests, rights manifest.
- Gate: unit, schema, curriculum continuity, sample lesson educational review, browser e2e, accessibility, secret scanning, license validation, build size.
- Release: protected main, human approval, GitHub Actions deploy, verify deployed base path and smoke test.
- Preserve artifacts: logs, reports, provenance manifest, review decisions, screenshots, build metrics.

## Phased milestones
0. Repo audit: inspect real files and licenses, document uncertainties; no ingestion claims before audit.
1. Controller MVP: dry-run task dispatch and logs, worktrees, one Claude task and one Codex review, approval gates.
2. One vertical lesson: functions → coding → tests → progress save → next lesson; full browser integration.
3. PDF ingest MVP: two permitted books, source tracing, structured curriculum QA.
4. Learning graph and core Python path, then statistics and ML.
5. Accessibility/performance/offline optimization, CI/CD, public release.

## Acceptance criteria
- `npm run build` produces GitHub Pages-compatible static assets.
- No PDFs with unapproved rights are included in `dist/`.
- One learner can complete a lesson, execute Python, save, refresh, resume, and get a valid next recommendation.
- Broken prerequisite links, missing sources, invalid exercises, and failing code snippets block publication.
- CLI orchestrator can stop/restart without losing task state; no task silently merges or deploys.
- Cross-agent review logs are inspectable and independent.

## Official references
- Claude Code programmatic CLI: https://code.claude.com/docs/en/headless
- Codex documentation: https://developers.openai.com/codex/
- GitHub Pages: https://docs.github.com/en/pages
- Pyodide: https://pyodide.org/
