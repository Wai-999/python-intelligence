"""python -m orchestrator <command>. Dry-run only."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

from . import __version__, agents, db
from .controller import Controller, LiveExecutionDisabled
from .spec import load_tasks
from .states import Status

DEFAULT_DB = ".orchestrator/state.sqlite3"


def _controller(args) -> Controller:
    conn, repo = db.connect(args.db), Path(args.repo).resolve()
    if getattr(args, "live", False):
        from .live import LiveController  # owner enabled live mode 2026-11-08
        return LiveController(conn, repo)
    return Controller(conn, repo, dry_run=True)


def cmd_preflight(args) -> int:
    ok = True
    for agent in ("claude", "codex"):
        exe = agents.resolve_binary(agent)
        if not exe:
            print(f"✗ {agent}: binary not found"); ok = False; continue
        out = subprocess.run([exe, "--version"], capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=30)
        ver = (out.stdout or out.stderr).strip()
        pinned = agents.PINNED_VERSIONS[agent]
        match = pinned in ver
        print(f"{'✓' if match else '!'} {agent}: {exe}  [{ver}]  pinned={pinned}{'' if match else '  (MISMATCH: live mode would refuse)'}")
        ok &= match
    git = subprocess.run(["git", "-C", args.repo, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True)
    print(f"{'✓' if git.returncode == 0 else '✗'} git repository: {args.repo}"); ok &= git.returncode == 0
    print("· live execution: available with --live (tick/run/approve)")
    return 0 if ok else 1


def cmd_load(args) -> int:
    n = _controller(args).load(load_tasks(args.file))
    print(f"loaded {n} new task(s) from {args.file}")
    return 0


def cmd_status(args) -> int:
    conn = db.connect(args.db)
    rows = conn.execute("SELECT id, status, owner, reviewer, attempts, max_attempts, commit_sha FROM tasks ORDER BY id")
    print(f"{'task':<6} {'status':<18} {'owner':<7} {'review':<7} {'att':<4} commit")
    for r in rows:
        print(f"{r['id']:<6} {r['status']:<18} {r['owner']:<7} {r['reviewer']:<7} "
              f"{r['attempts']}/{r['max_attempts']:<2} {r['commit_sha'] or '-'}")
    return 0


def cmd_tick(args) -> int:
    c = _controller(args)
    if not args.no_recover:
        for tid, frm, to in c.recover():
            print(f"recovered {tid}: {frm} -> {to}")
    for _ in range(args.n):
        for line in c.tick():
            print(line)
    return 0


def cmd_run(args) -> int:
    c = _controller(args)
    for tid, frm, to in c.recover():
        print(f"recovered {tid}: {frm} -> {to}")
    try:
        c.run(max_minutes=args.minutes, poll_s=args.poll, echo=lambda l: print(l, flush=True))
    except KeyboardInterrupt:
        c.shutdown()
        print("interrupted: workers stopped; state will be recovered on next start")
    return 0


def cmd_approve(args) -> int:
    print(_controller(args).approve(args.task, f"human:{args.by}", Status(args.gate)))
    return 0


def cmd_reject(args) -> int:
    fb = args.feedback
    if args.with_findings:
        conn = db.connect(args.db)
        row = conn.execute("SELECT detail_json FROM events WHERE task_id=? AND to_status='awaiting_approval'"
                           " ORDER BY id DESC LIMIT 1", (args.task,)).fetchone()
        if row:
            fs = json.loads(row["detail_json"]).get("findings", [])
            fb += "\n\nAddress these reviewer findings:\n" + "\n".join(
                f"- [{f['severity']}] {f['file']}:{f['line']}: {f['summary']} Fix: {f['proposed_fix']}" for f in fs)
    print(_controller(args).reject(args.task, f"human:{args.by}", fb))
    return 0


def cmd_accept(args) -> int:
    print(_controller(args).accept(args.task, f"human:{args.by}", args.reason))
    return 0


def cmd_unblock(args) -> int:
    print(_controller(args).unblock(args.task, f"human:{args.by}", args.reason))
    return 0


def cmd_events(args) -> int:
    conn = db.connect(args.db)
    q = "SELECT * FROM events" + (" WHERE task_id = ?" if args.task else "") + " ORDER BY id"
    for e in conn.execute(q, (args.task,) if args.task else ()):
        print(json.dumps({k: e[k] for k in e.keys()}, ensure_ascii=False))
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="orchestrator", description=f"Python Intelligence orchestrator {__version__}")
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--repo", default=".")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("preflight").set_defaults(fn=cmd_preflight)
    s = sub.add_parser("load"); s.add_argument("file"); s.set_defaults(fn=cmd_load)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    s = sub.add_parser("tick"); s.add_argument("-n", type=int, default=1)
    s.add_argument("--live", action="store_true", help="really run agents (one tick)")
    s.add_argument("--no-recover", action="store_true"); s.set_defaults(fn=cmd_tick)
    s = sub.add_parser("run", help="live loop until human input is needed")
    s.add_argument("--live", action="store_true", required=True)
    s.add_argument("--minutes", type=float, default=120); s.add_argument("--poll", type=float, default=5)
    s.set_defaults(fn=cmd_run)
    s = sub.add_parser("approve"); s.add_argument("task"); s.add_argument("--by", required=True)
    s.add_argument("--live", action="store_true", help="really merge the branch into main")
    s.add_argument("--gate", default="merged", choices=["merged", "released"]); s.set_defaults(fn=cmd_approve)
    s = sub.add_parser("reject", help="send work at the approval gate back with feedback")
    s.add_argument("task"); s.add_argument("--by", required=True); s.add_argument("--feedback", required=True)
    s.add_argument("--with-findings", action="store_true", help="append the latest review findings")
    s.set_defaults(fn=cmd_reject)
    s = sub.add_parser("unblock"); s.add_argument("task"); s.add_argument("--by", required=True)
    s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_unblock)
    s = sub.add_parser("accept", help="take a blocked task's tested commit to the approval gate as-is")
    s.add_argument("task"); s.add_argument("--by", required=True)
    s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_accept)
    s = sub.add_parser("events"); s.add_argument("--task"); s.set_defaults(fn=cmd_events)
    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except (LiveExecutionDisabled, db.TransitionError, ValueError, KeyError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
