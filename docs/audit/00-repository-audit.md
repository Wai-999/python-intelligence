# Phase 0 — Repository, Environment and Source Audit

Date: 2026-11-08 · Auditor: Claude Code (Opus 5.5), interactive session · Status: **complete, pending owner decisions**

Every result below came from a command run in this session. Nothing is inferred from the planning docs.

## 1. Repository

| Item | Finding |
|---|---|
| Location | `~/Downloads/My Porfolio/python-intelligence/python_intelligence_cli_package/` (also a copy as `../Python_Intelligence_CLI_Starter_Package.zip`) |
| Contents before audit | 7 Markdown planning docs + `.gitignore`. **No code, no tests, no CI.** |
| Git | It was not a repository. Ran `git init -b main` (per `SETUP.md`). **No commits yet**, no remote. |
| `.gitignore` | Covers `sources/ .env* .venv/ node_modules/ dist/ *.sqlite3 logs/ worktrees/`. This audit adds `.orchestrator/`. |
| Note | The folder path contains a space and a typo ("My Porfolio"). Code must quote all paths. Consider renaming before adding a remote. |

## 2. Local environment

| Tool | Command | Result |
|---|---|---|
| macOS | `sw_vers` | 26.7.2 (25G332), arm64 |
| git | `git --version` | 2.50.1; global `user.name`/`user.email` set |
| Python | `python3 --version` | 3.13.5 (Anaconda, first on PATH); several other interpreters installed. Recommend a project `.venv`. |
| SQLite | `sqlite3.sqlite_version` | 3.45.3 (WAL and `BEGIN IMMEDIATE` supported) |
| PyMuPDF | `import fitz` | 1.27.2.3 already installed in the Anaconda env |
| pytest | `python3 -m pytest --version` | 8.3.4 |
| Node / npm | `node --version` | v24.16.0 / 11.13.0 |
| GitHub CLI | `gh auth status` | logged in as `Wai-999` (keyring, https) |
| Disk | `df -h ~` | 527 GiB free |

### Agent CLIs

| | Claude Code | Codex |
|---|---|---|
| Binary | `~/.local/bin/claude` (on PATH) | **Not on PATH.** Found bundled at `/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex` |
| Version | `2.1.319 (Claude Code)` | `codex-cli 0.167.0-alpha.3.2` (**alpha build**, so flags may change) |
| Auth | `claude auth status` → `loggedIn: true, authMethod: claude.ai` (expires 2026-12-05) | `codex login status` → `Logged in using ChatGPT` |
| Headless smoke test | `claude -p '…' --tools Read --permission-mode dontAsk --no-session-persistence --output-format json` → exit 0, `subtype: success`, 1 turn, ~10 s | `codex exec -s read-only --ephemeral --json -o last.txt -C <repo> '…' </dev/null` → exit 0, JSONL events `thread.started, turn.started, item.completed, turn.completed`, ~11 s |
| Wrote files? | No (`git status` showed only redirected output files) | No |

The smoke tests ran in a disposable git repo in the session scratchpad, never in this repository.

### Verified CLI facts relevant to orchestration (from `--help`)

- **Claude**: `-p/--print`, `--output-format json|stream-json`, `--json-schema <inline JSON>` (structured output), `--permission-mode dontAsk|acceptEdits|plan|…`, `--allowedTools/--disallowedTools`, `--tools`, `--setting-sources user,project,local`, `--no-session-persistence`, `--add-dir`, `-w/--worktree`, `--max-budget-usd` (*API-billing only*). `--bare` reads **only** `ANTHROPIC_API_KEY`, so it is **incompatible with subscription auth**, which confirms the warning in `SETUP.md`.
- **Codex**: `exec [PROMPT]`, `-s read-only|workspace-write|danger-full-access`, `-C <dir>`, `--json` (JSONL), `-o <file>` (last message), `--output-schema <file>`, `--ephemeral`, `--ignore-user-config` (auth still works), `--worktree`, `exec review` subcommand, `--skip-git-repo-check`. **If stdin is a pipe, Codex reads it and appends it to the prompt.** Workers must run with `stdin=DEVNULL`.

## 3. Findings that change the architecture

1. **Global user instructions leak into workers (verified).** Codex's summary of `AGENTS.md` included "Prefer knowledge-graph tools for code discovery", which is not in this repo's `AGENTS.md`. It came from `~/.codex/AGENTS.md`. Codex also tried to start user-level MCP servers (one failed with an auth error). Claude worker runs likewise load user settings, hooks and plugins by default. **Mitigation:** Claude workers get `--setting-sources project,local`, and Codex workers get `--ignore-user-config`. Whether `~/.codex/AGENTS.md` still leaks under `--ignore-user-config` is **unverified** and is the first check in Phase 1 (task P1-2).
2. **Codex is an alpha build bundled in an app.** The controller must resolve the binary explicitly (env `PI_CODEX_BIN`, then PATH, then the app path), then record and pin its version in preflight. An app auto-update could change flags without warning.
3. **No usage/spend telemetry under subscription auth.** `--max-budget-usd` applies only to API billing. "Spending/usage monitoring" from the architecture can only be approximated by counting runs, wall-clock time and turns. Account rate limits will show up as failures, not warnings.
4. **No remote = no PR/merge queue yet.** Until the owner creates a GitHub repo, integration means a local `git merge --no-ff` executed only after a recorded human approval.
5. **Tests must be run by the controller, not self-reported by the agent.** Both CLIs return free-text or JSON claims. The gate must execute the acceptance commands itself in the task worktree.

## 4. PDF source audit (`Ravikisha/PythonCentralHub`)

- `gh api repos/Ravikisha/PythonCentralHub`: public, not archived, default branch `main`, ~345 MB, **MIT license**. The license covers "Copyright (c) 2023 Ravi Kishan" software. It **cannot license the third-party books** stored in the repo. The README's only licensing text is "MIT. See LICENSE."
- Pinned commit: **`d1590b79e98eb9975548da88001387bdedcd930a`** (2026-10-06).
- Clone: `sources/PythonCentralHub` (gitignored), `git clone --filter=blob:none --no-checkout --depth 1`. It holds **trees only (300 KB), and no PDF bytes are on disk**. Verified with `GIT_NO_LAZY_FETCH=1 git cat-file -e <blob>` → absent.
- Inventory: **14 PDFs in `books/` + 1 at repo root (`mml-book.pdf`) = 15**, 299 MB total. Full table with git blob SHAs, sizes and presumed rights: [`source_manifest.json`](source_manifest.json).

| Presumed rights status | Count | Titles |
|---|---|---|
| Commercial, all rights reserved | 6 | Deep Learning with Python, Effective Python, Fluent Python, Hands-On ML 2e, Python for Data Analysis, Python Cookbook 3e |
| Commercial, **likely unauthorized copy** (`PDFDrive.com` in filename) | 3 | Head First Python, Learn Python 3 the Hard Way, Python Crash Course |
| Open upstream, but this copy's origin unknown | 2 | Automate the Boring Stuff, Big Book of Small Python Projects (author's online editions: CC BY-NC-SA 3.0) |
| Open license presumed | 2 | Think Python 2e (CC BY-NC 3.0), Dive Into Python 3 (CC BY-SA 3.0) |
| Free for personal use only | 1 | Mathematics for Machine Learning (`mml-book.pdf`) |
| Unknown | 1 | `learning-python.pdf` (ambiguous title) |

**These statuses are presumptions from general knowledge, not legal review.** Every entry has `allowed_to_publish: false` and `allowed_for_internal_extraction: false` until the owner records a decision.

**Recommendation:** do not download or extract the 9 commercial PDFs at all, not even for "internal" use. For the open titles, fetch the copies from the **authors' official sites** rather than this repo, since this repo's copies have unverified provenance. Statistics and ML coverage will need other openly licensed sources (for example *Think Stats*, *Think Bayes*, *OpenIntro Statistics*, scikit-learn docs). Each needs its license checked. Note that CC **SA** and **NC** terms flow into derived lesson text, and BY-SA and BY-NC-SA works can't be merged into one adaptation. License must therefore be tracked per lesson.

### Audit error and correction (transparency)

My first clone used `git ls-tree -l` to read file sizes. In a partial clone this **lazily fetched all 14 PDF blobs** (~235 MB of packed objects). No files were checked out or opened. I detected this from `.git` size and one-object packs, deleted that clone, re-cloned tree-only, and took sizes from the GitHub API instead. Lesson for the ingest pipeline: in partial clones, use `GIT_NO_LAZY_FETCH=1` for all inventory commands.

## 5. Not yet verified (deferred, by design)

- Whether `--setting-sources project,local` / `--ignore-user-config` fully isolate workers (P1-2).
- Exact `--allowedTools` rule syntax behaviour under `dontAsk` (P1-2).
- Worker behaviour on timeout and kill, account rate-limit errors, and long prompts (P1-2, P1-4).
- Anything about the frontend (Vite/Pyodide/IndexedDB). Phase 2 has not started.
- Nothing has been deployed, merged, pushed or published.
