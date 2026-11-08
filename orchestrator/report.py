"""Read-only Markdown summaries of persisted orchestrator state."""

from collections import Counter
import sqlite3

from .states import Status


def markdown_status(conn: sqlite3.Connection) -> str:
    """Render tasks in ID order without changing their persisted state."""
    rows = conn.execute(
        "SELECT id, title, status, owner, reviewer, attempts, max_attempts, commit_sha"
        " FROM tasks ORDER BY id"
    ).fetchall()
    lines = ["# Orchestrator status", ""]
    if not rows:
        return "\n".join([*lines, "_No tasks._", ""])

    lines.extend([
        "| Task | Title | Status | Owner | Reviewer | Attempts | Commit |",
        "| --- | --- | --- | --- | --- | --- | --- |",
    ])
    for row in rows:
        title = row["title"].replace("|", "\\|")
        commit = row["commit_sha"][:10] if row["commit_sha"] is not None else "—"
        cells = [row["id"], title, row["status"], row["owner"], row["reviewer"],
                 f"{row['attempts']}/{row['max_attempts']}", commit]
        lines.append("| " + " | ".join(cells) + " |")

    counts = Counter(row["status"] for row in rows)
    totals = ", ".join(f"{status} {counts[status]}" for status in Status if counts[status])
    lines.extend(["", "Totals: " + totals, ""])
    return "\n".join(lines)
