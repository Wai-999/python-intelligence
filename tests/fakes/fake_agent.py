"""Stand-in for `claude` / `codex` used by live-controller tests.

Behaviour is chosen by FAKE_PLAN (a JSON file path in the env of the *test process*, written into a
side file because workers get a scrubbed env). The plan maps role -> list of actions consumed in order.
"""

import json
import os
import sys
import time
from pathlib import Path

AGENT = Path(sys.argv[0]).name  # "claude" or "codex"
args = sys.argv[1:]
plan_file = Path(__file__).with_name("plan.json") if not os.environ.get("HOME") else None
plan_file = Path(os.environ["HOME"]) / "fake_plan.json"  # tests point HOME at tmp dir
plan = json.loads(plan_file.read_text())

if AGENT == "claude":
    role = "review" if "--json-schema" in args else "implement"
    cwd = Path.cwd()
else:  # codex exec -s <mode> -C <dir> ...
    role = "review" if args[args.index("-s") + 1] == "read-only" else "implement"
    cwd = Path(args[args.index("-C") + 1])

key = f"{AGENT}:{role}"
queue = plan.get(key, [])
action = queue.pop(0) if queue else {"do": "ok"}
plan[key] = queue
plan.setdefault("calls", []).append({"agent": AGENT, "role": role, "cwd": str(cwd),
                                     "codex_home": os.environ.get("CODEX_HOME"),
                                     "anthropic_key_leaked": "ANTHROPIC_API_KEY" in os.environ})
plan_file.write_text(json.dumps(plan))

do = action.get("do", "ok")
if do in ("sleep", "fail") and role == "implement" and "write" in action:  # misbehave first, then fail/hang
    for rel, content in action["write"].items():
        p = cwd / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
if do == "sleep":
    time.sleep(action.get("seconds", 60))
if do == "fail":
    print("fake failure", file=sys.stderr)
    sys.exit(3)

if role == "implement":
    for rel, content in action.get("write", {"src/feature.py": "def f():\n    return 1\n"}).items():
        p = cwd / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
    if AGENT == "claude":
        print(json.dumps({"type": "result", "subtype": "success", "is_error": False, "result": "done",
                          "permission_denials": []}))
    else:
        print('{"type":"turn.completed"}')
    sys.exit(0)

review = action.get("review", {"verdict": "approve", "findings": []})
if AGENT == "claude":
    print(json.dumps({"type": "result", "is_error": False, "result": json.dumps(review),
                      "structured_output": review}))
else:
    Path(args[args.index("-o") + 1]).write_text(json.dumps(review))
    print('{"type":"turn.completed"}')
