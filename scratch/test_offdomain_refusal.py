#!/usr/bin/env python3
"""The looser ACT floor must not answer a request the strict floor would refuse.

settings.act_max_distance (0.85) is deliberately far looser than the primary
floor (0.65), because subject correctness for the ACT stratum is guaranteed
structurally by act_sections_for() rather than by distance. The guard is that an
ACT chunk is only ever kept alongside a primary standard that already cleared the
strict floor.

This test is that guard. If it fails, an off-domain query is being answered from
an ACT standard and retrieval.no_grounded_standards_error() has stopped firing.

Run:  ./venv/bin/python scratch/test_offdomain_refusal.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import retrieval  # noqa: E402
from backend.config import settings  # noqa: E402

# (course, query) pairs that must retrieve NOTHING and be refused.
OFF_DOMAIN = [
    ("AP_Lang", "balancing redox half-reactions and calculating cell potential"),
    ("AP_Lang", "implementing a red-black tree rotation in Java"),
    ("AP_Lang", "asdfgh qwerty zxcvbn nonsense tokens"),
    ("Math", "analyzing the tone and diction of a Toni Morrison passage"),
    ("AP Physics 1", "conjugating irregular preterite verbs in Spanish"),
    ("AP Biology", "the fiscal multiplier and crowding out"),
    ("AP US History", "titrating a weak acid with a strong base"),
]

# Must still be answered — the guard should not cost real coverage.
IN_DOMAIN = [
    ("AP_Lang", "rhetorical analysis of Letter from Birmingham Jail"),
    ("AP Physics 1", "forces and free-body diagrams"),
    ("AP US History", "sourcing and corroborating primary documents"),
]


def main() -> int:
    failures: list[str] = []
    print(f"primary floor = {settings.retrieval_max_distance}   "
          f"ACT floor = {settings.act_max_distance}\n")

    print("--- must be REFUSED ---")
    for course, query in OFF_DOMAIN:
        r = retrieval.retrieve_grounded(query, subject_code=course, grade=11)
        kept = [f"{(c['metadata'] or {}).get('code')}@{c['distance']:.3f}" for c in r.chunks]
        status = "refused" if r.empty else "ANSWERED"
        print(f"  {status:9} {course:16} {query[:44]:46} {kept}")
        if not r.empty:
            failures.append(
                f"{course} / {query[:40]!r} was answered with {kept} — "
                f"the off-domain refusal is broken"
            )

    print("\n--- must be ANSWERED ---")
    for course, query in IN_DOMAIN:
        r = retrieval.retrieve_grounded(query, subject_code=course, grade=11)
        status = "ok" if not r.empty else "REFUSED"
        print(f"  {status:9} {course:16} {query[:44]:46} {len(r.chunks)} chunks")
        if r.empty:
            failures.append(f"{course} / {query[:40]!r} was refused but is in domain")

    print()
    if failures:
        print(f"FAIL — {len(failures)} problem(s):")
        for f in failures:
            print(f"  * {f}")
        return 1
    print(f"PASS — {len(OFF_DOMAIN)} off-domain refused, {len(IN_DOMAIN)} in-domain answered.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
