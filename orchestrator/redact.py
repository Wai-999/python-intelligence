"""Mask credentials before anything is persisted. Patterns are conservative, not exhaustive."""

import json
import re
from typing import Any

_PATTERNS = [
    re.compile(r"\b(gh[pousr]_[A-Za-z0-9]{20,})"),
    re.compile(r"\b(github_pat_[A-Za-z0-9_]{20,})"),
    re.compile(r"\b(sk-ant-[A-Za-z0-9_\-]{20,})"),
    re.compile(r"\b(sk-[A-Za-z0-9_\-]{20,})"),
    re.compile(r"(?i)\b(bearer\s+[A-Za-z0-9._\-]{16,})"),
    re.compile(r"(?i)((?:api[_-]?key|token|secret|password)\s*[=:]\s*)([^\s\"']{8,})"),
]

MASK = "[REDACTED]"


def redact(text: str) -> str:
    for pat in _PATTERNS:
        if pat.groups == 2:
            text = pat.sub(lambda m: m.group(1) + MASK, text)
        else:
            text = pat.sub(MASK, text)
    return text


def redact_obj(obj: Any) -> Any:
    """Redact every string inside a JSON-serialisable structure."""
    return json.loads(redact(json.dumps(obj)))
