"""Task state machine. `db.transition` is the only code that applies these rules."""

from enum import StrEnum


class Status(StrEnum):
    QUEUED = "queued"
    READY = "ready"
    RUNNING = "running"
    IMPLEMENTED = "implemented"
    TESTING = "testing"
    REVIEW = "review"
    AWAITING_APPROVAL = "awaiting_approval"
    MERGED = "merged"
    RELEASED = "released"
    REPAIR = "repair"
    BLOCKED = "blocked"


S = Status

TRANSITIONS: dict[Status, frozenset[Status]] = {
    S.QUEUED: frozenset({S.READY, S.BLOCKED}),
    S.READY: frozenset({S.RUNNING, S.BLOCKED}),
    S.RUNNING: frozenset({S.IMPLEMENTED, S.REPAIR, S.BLOCKED}),
    S.IMPLEMENTED: frozenset({S.TESTING, S.BLOCKED}),
    S.TESTING: frozenset({S.REVIEW, S.REPAIR, S.BLOCKED}),
    S.REVIEW: frozenset({S.AWAITING_APPROVAL, S.REPAIR, S.BLOCKED}),
    S.AWAITING_APPROVAL: frozenset({S.MERGED, S.REPAIR, S.BLOCKED}),
    S.MERGED: frozenset({S.RELEASED}),
    S.RELEASED: frozenset(),
    S.REPAIR: frozenset({S.READY, S.BLOCKED}),
    S.BLOCKED: frozenset({S.READY, S.AWAITING_APPROVAL}),  # the latter only via Controller.accept
}

# Entering these requires an unconsumed approval bound to the task's commit SHA.
HUMAN_GATED: frozenset[Status] = frozenset({S.MERGED, S.RELEASED})
# Leaving these requires a human actor ("human:<name>").
HUMAN_EXIT_ONLY: frozenset[Status] = frozenset({S.BLOCKED})
# States in which an agent or test subprocess would be running.
IN_FLIGHT: frozenset[Status] = frozenset({S.RUNNING, S.IMPLEMENTED, S.TESTING, S.REVIEW})
# Subset of IN_FLIGHT where a subprocess may have died mid-way (IMPLEMENTED is a resting waypoint).
ORPHANABLE: frozenset[Status] = frozenset({S.RUNNING, S.TESTING, S.REVIEW})
# Dependencies count as satisfied only once integrated.
DEP_SATISFIED: frozenset[Status] = frozenset({S.MERGED, S.RELEASED})


def is_human(actor: str) -> bool:
    return actor.startswith("human:") and len(actor) > len("human:")
