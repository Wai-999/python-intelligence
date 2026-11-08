# ADR-0001 — Dual-agent orchestrator: local Python + SQLite, worktree-isolated, human-gated

- Status: **Proposed** (dry-run prototype implemented; live execution disabled pending owner approval)
- Date: 2026-11-08
- Deciders: owner (approval), Claude Code (author)
- Inputs: `MASTER_ARCHITECTURE.md`, `docs/audit/00-repository-audit.md`

## Context

Two subscription-authenticated CLI agents (Claude Code 2.1.319, Codex 0.167.0-alpha) will build the platform. Each task is implemented by one agent and reviewed by the other. The architecture requires the following:

- Resumable state
- Worktree isolation
- Concurrency ≤ 2
- Retry cap 2
- Independent review
- No silent merge or deploy

The audit added these constraints:

- No spend telemetry under subscription auth
- User-global instructions leak into workers
- Codex reads piped stdin into the prompt
- No git remote yet

## Decision

A **stdlib-only Python 3.11+ package `orchestrator/`** with SQLite state. It runs locally and is never deployed.

### 1. Components

| Module | Responsibility |
|---|---|
| `spec.py` | Load `tasks/*.toml` and validate them: unique IDs, known dependencies, **acyclic DAG**, reviewer ≠ owner, retry cap, allowed paths. Also `check_scope()` for diffs. |
| `states.py` | `Status` enum, allowed transition table, human-gated states. |
| `db.py` | Schema, plus `transition()`, the **only** way status changes. It is atomic (`BEGIN IMMEDIATE`) and guarded by a compare-and-set (`WHERE status = <expected>`). It enforces gates and redacts event details. |
| `agents.py` | Builds argv lists (never `shell=True`) for `claude` and `codex`. Each list is built for one role (implement or review). Forbidden flags are rejected at build time. |
| `worktree.py` | Plans `git worktree` commands. Naming: `worktrees/task-<id>-<agent>-d<n>`, branch `agent/<agent>/<id>-d<n>`, where `n` is a dispatch counter that only ever increases. Attempts can be refunded after a crash, so attempt numbers would collide. This deliberately refines the architecture's naming so that a retry never inherits a failed attempt's tree or branch. |
| `controller.py` | Scheduler: promote, dispatch and advance tasks, plus startup recovery. Dry-run only. Live mode raises `LiveExecutionDisabled`. |
| `redact.py` | Masks tokens (GitHub, OpenAI, Anthropic, bearer) before anything is stored. |
| `cli.py` | `python -m orchestrator {init,load,status,tick,approve,unblock,preflight,events}` |

### 2. State machine

```
queued → ready → running → implemented → testing → review → awaiting_approval ⇒ merged ⇒ released
                    │                        │          │            │
                    └──────────► repair ◄────┴──────────┴────────────┘
                                   │  attempts < max → ready
                                   └─ attempts ≥ max → blocked ──(human unblock)──► ready
```

- `⇒` marks a **human gate**. The transition succeeds only if an unconsumed approval row exists for *(task, gate, commit_sha)*. Approving a commit does not approve a later one. The approval is consumed in the same transaction as the transition.
- Leaving `blocked` requires an actor of the form `human:<name>`. The controller cannot unblock itself.
- `tick()` has no code path to `merged` or `released`. The only callers that reach those states are the `approve` CLI command and tests. Tests assert this.

### 3. Isolation model

- **One writer per worktree.** The implementer gets a fresh worktree on its own branch.
- **The reviewer never shares the implementer's worktree.** It gets a *detached, read-only checkout at the implementer's commit SHA* (`worktrees/review-<id>-<agent>`), plus a controller-generated `REVIEW_DIFF.patch`. The review therefore targets an immutable commit.
- **The controller runs the tests itself**, in the worktree, after the agent exits. The agent's self-report counts as evidence only. `check_scope()` rejects any diff that touches paths outside `allowed_paths`, or that touches always-denied paths (`.git/`, `.env*`, `sources/`, `.github/workflows/`, `.orchestrator/`).
- Worker processes run with `stdin=DEVNULL`, a wall-clock timeout, their own process group (so a timeout can kill the whole group), and a scrubbed environment.

### 4. Command templates (flags verified via `--help` on 2026-11-08)

| Role | Claude Code | Codex |
|---|---|---|
| implement | `claude -p <prompt> --output-format json --no-session-persistence --permission-mode dontAsk --setting-sources project,local --allowedTools Read Edit Write Glob Grep "Bash(git status:*)" "Bash(git diff:*)" "Bash(python -m pytest:*)"` | `codex exec -s workspace-write -C <wt> --json -o <out> --ephemeral --ignore-user-config <prompt>` |
| review | `claude -p <prompt> --output-format json --no-session-persistence --permission-mode dontAsk --setting-sources project,local --tools Read Glob Grep --json-schema <findings-schema>` | `codex exec -s read-only -C <review-wt> --json -o <out> --ephemeral --ignore-user-config --output-schema <findings-schema.json> <prompt>` |

**Never emitted** (unit-tested):

- `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `bypassPermissions`
- `--dangerously-bypass-approvals-and-sandbox`, `--dangerously-bypass-hook-trust`, `danger-full-access`
- `--bare` (it breaks subscription auth)

Structured review findings use the same JSON Schema for both agents: `severity`, `file`, `line`, `summary`, `reproduction`, `proposed_fix`.

### 5. Resumability

All state lives in SQLite (WAL). On startup, `recover_orphans()` finds tasks left in an in-flight state (`running`, `testing`, `review`) whose process cannot still be alive, because this is a single-controller design. It moves them to a safe state and logs an event. Each attempt is recorded in the `runs` table with its argv, cwd, timestamps and exit code, so a restart never re-runs work silently.

### 6. Scheduling

- A task becomes `ready` when every dependency is `merged` or `released`.
- At most `concurrency` (default 2, max 2) tasks are in flight.
- No two in-flight tasks share an owner. Each agent runs one session at a time, which reduces account rate-limit risk.

## Consequences

- **+** No dependencies, inspectable state (`sqlite3 .orchestrator/state.sqlite3`), and deterministic dry-run tests.
- **+** Gates are enforced at the data layer, not by convention.
- **−** Single controller only. Running two controllers on one DB is unsupported (`BEGIN IMMEDIATE` prevents corruption, not logical races across hosts).
- **−** Spend is unmeasurable under subscription auth. The proxy is runs × duration, and the owner should watch account dashboards.
- **−** Codex alpha flags may drift. Preflight must compare `codex --version` against the pinned version and refuse live mode on mismatch.

## Alternatives considered

- **Use each CLI's built-in `--worktree`.** Rejected: it gives inconsistent naming and cleanup, and the controller loses control of the review checkout.
- **A JSON file as state.** Rejected: it can't do atomic compare-and-set transitions or a crash-safe event log.
- **Let agents run tests and report.** Rejected: their reports are self-attested, and that conflicts with "do not invent success".
- **A Claude subagent as reviewer of Claude.** Rejected: the architecture requires a reviewer that is a different agent from the implementer.

## Open questions (resolved in Phase 1)

1. Does `--ignore-user-config` stop `~/.codex/AGENTS.md` from loading? If not, the fallback is a dedicated `CODEX_HOME` with copied auth. That needs owner consent, because it duplicates credentials.
2. `--allowedTools` rule syntax (`Bash(git diff:*)` vs `Bash(git diff *)`) under `dontAsk`.
3. Rate-limit error shapes for both CLIs, needed for the retry-vs-block policy.
