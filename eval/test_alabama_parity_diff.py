"""The Alabama parity differ must actually detect drift.

alabama_parity.py is the gate that decides whether the per-state corpus split
changed Alabama's retrieval. A differ that quietly reports "no problems" would
turn that gate into a rubber stamp at exactly the moment it matters, so its
comparison is exercised here — no database, no baseline, no API.

The distance-drift case is the one worth having. Identical rows in identical
order with a distance that moved by 4e-07 is what a corpus change looks like
BEFORE it is big enough to reorder anything; a comparison on codes alone would
call that a pass.
"""
from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location("alabama_parity", HERE / "alabama_parity.py")
alabama_parity = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(alabama_parity)

BASE = {
    "top_n": 20,
    "results": {
        "000:ELA:11:ELA21.11.R2": [
            ["ELA:11:ELA21.11.R2", "ELA21.11.R2", 0.100000000000],
            ["ELA:11:ELA21.11.R3", "ELA21.11.R3", 0.200000000000],
        ]
    },
}


def _case(name: str, current: dict, *, expect_problem: bool) -> bool:
    problems = alabama_parity._diff(BASE, current)
    ok = bool(problems) == expect_problem
    verdict = "ok" if ok else "FAIL"
    detail = problems[0] if problems else "no problems reported"
    print(f"  [{verdict}] {name}: {detail}")
    return ok


def main() -> int:
    print("Alabama parity differ:")
    results = [
        _case("an identical snapshot passes", BASE, expect_problem=False),
        _case(
            "a different row at rank 1 is caught",
            {"top_n": 20, "results": {"000:ELA:11:ELA21.11.R2": [
                ["ELA:11:ELA21.11.R2", "ELA21.11.R2", 0.1],
                ["ELA:11:ELA21.11.R9", "ELA21.11.R9", 0.2],
            ]}},
            expect_problem=True,
        ),
        _case(
            "a 4e-07 distance move with unchanged order is caught",
            {"top_n": 20, "results": {"000:ELA:11:ELA21.11.R2": [
                ["ELA:11:ELA21.11.R2", "ELA21.11.R2", 0.1],
                ["ELA:11:ELA21.11.R3", "ELA21.11.R3", 0.2000004],
            ]}},
            expect_problem=True,
        ),
        _case(
            "a vanished case is caught",
            {"top_n": 20, "results": {}},
            expect_problem=True,
        ),
        _case(
            "a truncated result list is caught",
            {"top_n": 20, "results": {"000:ELA:11:ELA21.11.R2": [
                ["ELA:11:ELA21.11.R2", "ELA21.11.R2", 0.1],
            ]}},
            expect_problem=True,
        ),
        _case(
            "a changed top_n is caught",
            {"top_n": 5, "results": BASE["results"]},
            expect_problem=True,
        ),
    ]
    failed = results.count(False)
    print(f"PARITY DIFFER {'PASS' if not failed else 'FAIL'} — "
          f"{len(results) - failed}/{len(results)} checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
