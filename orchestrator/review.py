"""Parse and judge structured cross-agent review output (schema: agents.FINDINGS_SCHEMA)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

BLOCKING = frozenset({"critical", "high"})
SEVERITIES = ("critical", "high", "medium", "low")


class ReviewParseError(ValueError):
    pass


@dataclass(frozen=True)
class Review:
    verdict: str
    findings: tuple[dict, ...]

    @property
    def blocking(self) -> list[dict]:
        return [f for f in self.findings if f["severity"] in BLOCKING]

    @property
    def passes(self) -> bool:
        return self.verdict == "approve" and not self.blocking

    def feedback(self) -> str:
        lines = [f"- [{f['severity']}] {f['file']}:{f['line']}: {f['summary']} | fix: {f['proposed_fix']}"
                 for f in sorted(self.findings, key=lambda f: SEVERITIES.index(f["severity"]))]
        return "Reviewer findings:\n" + ("\n".join(lines) or "- (verdict request_changes, no itemised findings)")


def _first_json_object(text: str) -> dict:
    text = text.strip()
    if text.startswith("```"):
        text = text.strip("`").split("\n", 1)[-1]
    start = text.find("{")
    if start < 0:
        raise ReviewParseError("no JSON object in reviewer output")
    obj, _ = json.JSONDecoder().raw_decode(text[start:])
    return obj


def validate(obj: dict) -> Review:
    if obj.get("verdict") not in ("approve", "request_changes"):
        raise ReviewParseError(f"bad verdict: {obj.get('verdict')!r}")
    raw = obj.get("findings")
    if not isinstance(raw, list):
        raise ReviewParseError("findings must be a list")
    out = []
    for f in raw:
        if not isinstance(f, dict) or f.get("severity") not in SEVERITIES:
            raise ReviewParseError(f"bad finding: {f!r}")
        out.append({"severity": f["severity"], "file": str(f.get("file", "?")), "line": int(f.get("line", 0) or 0),
                    "summary": str(f.get("summary", "")), "reproduction": str(f.get("reproduction", "")),
                    "proposed_fix": str(f.get("proposed_fix", ""))})
    return Review(obj["verdict"], tuple(out))


def parse_claude(stdout: str) -> Review:
    """claude -p --output-format json --json-schema ...  -> {"structured_output": {...}, "result": "..."}"""
    env = _first_json_object(stdout)
    if env.get("is_error"):
        raise ReviewParseError(f"claude reported error: {str(env.get('result'))[:300]}")
    so = env.get("structured_output")
    return validate(so if isinstance(so, dict) else _first_json_object(str(env.get("result", ""))))


def parse_codex(last_message_file: str | Path) -> Review:
    p = Path(last_message_file)
    if not p.exists():
        raise ReviewParseError(f"codex wrote no last message at {p}")
    return validate(_first_json_object(p.read_text()))
