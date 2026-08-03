"""AP Lang week -> unit routing, so a stored plan can say which unit it belongs to.

Mirrors the 9-unit map in the Florence workspace CLAUDE.md. Used only to label
plans in the library; nothing depends on it being exhaustive.
"""
from __future__ import annotations

import re

# (first_week, last_week, unit label)
UNIT_MAP: list[tuple[int, int, str]] = [
    (1, 5, "Unit 1 — Rhetorical Analysis"),
    (6, 9, "Unit 2 — Voice, Tone & Rhetorical Devices"),
    (10, 13, "Unit 3 — Power of Language"),
    (14, 18, "Unit 4 — Line of Reasoning & Evidence"),
    (19, 23, "Unit 5 — The American Dream"),
    (24, 28, "Unit 6 — Community & Conformity"),
    (29, 32, "Unit 7 — Duality, Identity & Sources"),
    (33, 37, "Unit 8 — Voice, Gender & Complexity"),
    (38, 41, "Unit 9 — AP Exam Prep"),
]

_WEEK_RE = re.compile(r"week\s*0*(\d{1,2})", re.IGNORECASE)


def week_number(week_label: str) -> int | None:
    m = _WEEK_RE.search(week_label or "")
    return int(m.group(1)) if m else None


def unit_for_week(week_label: str) -> str | None:
    n = week_number(week_label)
    if n is None:
        return None
    for lo, hi, name in UNIT_MAP:
        if lo <= n <= hi:
            return name
    return None
