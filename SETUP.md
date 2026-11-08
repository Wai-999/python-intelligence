# Setup on macOS
Prerequisites: git, Python 3.11+, Node.js LTS, Claude Code CLI, Codex CLI, authenticated accounts, GitHub access.

```bash
mkdir python-intelligence && cd python-intelligence
git init -b main
# Copy all files in this package to this folder.
claude --version
codex --version
claude --help
codex exec --help
# Log in to each CLI interactively following its official documentation.
# Start ONE agent interactively for the initial architecture audit:
claude
# Paste the content of BOOTSTRAP_PROMPT.md as the first task.
```

Before unattended orchestration: test `claude -p 'Summarize AGENTS.md'` and `codex exec 'Summarize AGENTS.md'` in a disposable test repo. Confirm credentials, permissions, output behavior, timeouts, and any account limits. Do not use `claude --bare` when relying on subscription authentication; check the current Claude docs. Keep `.env`, `sources/`, `.venv/`, logs and local task state ignored. Add a remote GitHub repository only after choosing a destination you control. The external PDF repository is a **source**, not the deployment target.
