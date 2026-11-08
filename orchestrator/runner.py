"""Subprocess execution: own process group, stdin closed, scrubbed env, wall-clock timeout, redacted logs."""

from __future__ import annotations

import os
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

from .redact import redact

# Variables passed through to workers. Everything else (tokens, API keys, cloud creds) is dropped.
# ANTHROPIC_API_KEY in particular must never leak in: it would silently switch Claude off subscription auth.
ENV_ALLOW = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR",
             "__CF_USER_TEXT_ENCODING", "SSH_AUTH_SOCK", "XPC_FLAGS", "XPC_SERVICE_NAME")


def scrubbed_env(extra: dict[str, str] | None = None, base: dict[str, str] | None = None) -> dict[str, str]:
    src = os.environ if base is None else base
    env = {k: v for k, v in src.items() if k in ENV_ALLOW}
    env["PI_WORKER"] = "1"
    env.update(extra or {})
    return env


@dataclass
class Handle:
    proc: subprocess.Popen
    log_path: Path
    deadline: float
    started: float

    @property
    def pid(self) -> int:
        return self.proc.pid

    def poll(self) -> int | None:
        return self.proc.poll()

    def timed_out(self) -> bool:
        return self.proc.poll() is None and time.monotonic() > self.deadline


def start(argv: list[str] | tuple[str, ...], *, cwd: str | Path, log_path: str | Path, timeout_s: float,
          env: dict[str, str] | None = None) -> Handle:
    log_path = Path(log_path)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    out = open(log_path, "wb")
    try:
        proc = subprocess.Popen(list(argv), cwd=str(cwd), env=env if env is not None else scrubbed_env(),
                                stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.STDOUT,
                                start_new_session=True)  # own process group -> killpg reaches grandchildren
    finally:
        out.close()  # child holds its own descriptor
    now = time.monotonic()
    return Handle(proc, log_path, now + timeout_s, now)


def kill_group(pgid: int, grace_s: float = 3.0) -> bool:
    """SIGTERM the group, then SIGKILL after grace. Returns True if anything was signalled."""
    try:
        os.killpg(pgid, signal.SIGTERM)
    except (ProcessLookupError, PermissionError):
        return False
    end = time.monotonic() + grace_s
    while time.monotonic() < end:
        try:
            os.killpg(pgid, 0)
        except ProcessLookupError:
            return True
        except PermissionError:
            # macOS returns EPERM when the group leader is an unreaped zombie; members may linger.
            break
        time.sleep(0.05)
    try:
        os.killpg(pgid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    return True


def wait(h: Handle, poll_s: float = 0.1) -> tuple[int, bool]:
    """Block until exit or timeout. Returns (exit_code, timed_out)."""
    while h.poll() is None:
        if h.timed_out():
            kill_group(h.pid)
            h.proc.wait()
            return h.proc.returncode, True
        time.sleep(poll_s)
    return h.proc.returncode, False


def read_log(path: str | Path, tail: int | None = None) -> str:
    text = redact(Path(path).read_text(errors="replace")) if Path(path).exists() else ""
    return text[-tail:] if tail else text


@dataclass
class Result:
    code: int
    output: str
    timed_out: bool


def run(argv, *, cwd, timeout_s: float = 600, env: dict[str, str] | None = None,
        log_path: str | Path | None = None) -> Result:
    """Synchronous run with the same guarantees. Output is redacted."""
    if log_path is None:
        import tempfile
        fd, tmp = tempfile.mkstemp(prefix="pi-run-", suffix=".log")
        os.close(fd)
        log_path, cleanup = Path(tmp), True
    else:
        cleanup = False
    h = start(argv, cwd=cwd, log_path=log_path, timeout_s=timeout_s, env=env)
    code, to = wait(h)
    out = read_log(log_path)
    if cleanup:
        Path(log_path).unlink(missing_ok=True)
    else:  # persist the redacted form only
        Path(log_path).write_text(out)
    return Result(code, out, to)
