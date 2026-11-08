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
    if getattr(args, "live", False):
        raise LiveExecutionDisabled("--live is disabled in this prototype; owner approval required (P1-7).")
    return Controller(db.connect(args.db), Path(args.repo).resolve(), dry_run=True)


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
    print("· live execution: DISABLED (dry-run prototype)")
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


def cmd_approve(args) -> int:
    print(_controller(args).approve(args.task, f"human:{args.by}", Status(args.gate)))
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
    s.add_argument("--live", action="store_true", help="disabled; present so the refusal is explicit")
    s.add_argument("--no-recover", action="store_true"); s.set_defaults(fn=cmd_tick)
    s = sub.add_parser("approve"); s.add_argument("task"); s.add_argument("--by", required=True)
    s.add_argument("--gate", default="merged", choices=["merged", "released"]); s.set_defaults(fn=cmd_approve)
    s = sub.add_parser("unblock"); s.add_argument("task"); s.add_argument("--by", required=True)
    s.add_argument("--reason", required=True); s.set_defaults(fn=cmd_unblock)
    s = sub.add_parser("events"); s.add_argument("--task"); s.set_defaults(fn=cmd_events)
    args = p.parse_args(argv)
    try:
        return args.fn(args)
    except (LiveExecutionDisabled, db.TransitionError, ValueError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 2
