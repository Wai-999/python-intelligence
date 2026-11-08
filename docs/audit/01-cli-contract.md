# P1-2 — Live CLI contract findings

Date: 2026-11-08. Probes ran in a disposable repo with worktrees in the session scratchpad. CLIs tested: claude 2.1.319, codex-cli 0.167.0-alpha.3.2. The re-runnable version is `tests/contract/test_cli_contract.py`, which is opt-in via `PI_LIVE=1` because it consumes subscription usage.

## Isolation from user-global configuration

The probe prompt: *"do your instructions contain 'knowledge-graph' or 'codebase-memory'? Reply LEAK:YES/NO"*. Both strings come from user-level config: the user's SessionStart hook and `~/.codex/AGENTS.md`.

| Agent | Flags | Answer | Context tokens (cache creation) | Reported `total_cost_usd`* |
|---|---|---|---|---|
| claude | (none) | **LEAK:YES** | 392,466 | 3.14 |
| claude | `--setting-sources project,local` | LEAK:NO | 382,898 | 3.07 |
| claude | `--safe-mode` | LEAK:NO | 3,917 | 0.029 |
| claude | `--setting-sources project,local --strict-mcp-config --disable-slash-commands` | **LEAK:NO** | **3,088** | **0.022** |
| codex | (none) | **LEAK:YES** | — | — |
| codex | `--ignore-user-config` | **LEAK:YES** (flag does not stop `~/.codex/AGENTS.md`) | — | — |
| codex | `CODEX_HOME=<dedicated dir>` with `auth.json` **symlinked** to `~/.codex/auth.json` | **LEAK:NO** | ~3k ("tokens used 2,988") | — |

\* `total_cost_usd` is what the CLI reports. Under claude.ai subscription auth it reflects usage against plan limits, not a bill.

**Decision:**

- Claude workers get `--setting-sources project,local --strict-mcp-config --disable-slash-commands`. That gives ~127× less context per call and still loads the project's `CLAUDE.md`. `--safe-mode` would also skip the project `CLAUDE.md`, so it isn't used.
- Codex workers run with `CODEX_HOME=.orchestrator/codex-home`, where `auth.json` is a symlink. The credentials are not copied.

## Permissions and sandbox

| Probe | Result |
|---|---|
| Claude `dontAsk` + `--allowedTools Read Edit Write "Bash(git status:*)" "Bash(git diff:*)"` | Write ✅, `git status` ✅, `git commit` ❌ (denied, listed in `permission_denials`). `ls -la` ✅: Claude auto-allows read-only commands even when they aren't listed. |
| Codex `-s workspace-write` in a git worktree | File write ✅. `git add` ❌: `.git/worktrees/<wt>/index.lock: Operation not permitted`, because the worktree's git dir is outside the sandbox. |
| Codex network in `workspace-write` | ❌ `curl` exit 6 (DNS blocked). |
| Both | Without `stdin` redirected, Claude waits 3 s ("no stdin data received") and Codex appends stdin to the prompt. Workers must use `stdin=DEVNULL`. |

**Decision:** agents never commit. The controller stages, scope-checks and secret-scans the changes, then commits them as `<agent> agent <agent-…@python-intelligence.local>`. Agents can't install packages either (no network), so the controller links the main repo's `node_modules` into worktrees where it exists.

## Structured output

- `claude -p … --output-format json --json-schema '<schema>'` returns the validated object in **`structured_output`**. `result` holds the same content as text. A `permission_denials` array is always present.
- `codex exec … -o <file>` writes the final message to the file. `--output-schema <file>` constrains it.
