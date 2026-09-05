#!/usr/bin/env python3
"""Prove Alabama's retrieval is unchanged across the per-state corpus split.

Migration 77 is the one migration that touches the live Alabama corpus. Its
safety argument is that Alabama is copied rather than rebuilt — same rows, same
vectors, same ids, and a state predicate that never widens what an Alabama query
can see — so its results should be identical afterwards, not merely similar.

"Should be" is worth nothing without a measurement, and the measurement has to
straddle the migration. So this is two commands, run against the live database:

    # BEFORE deploying migration 77
    python eval/alabama_parity.py capture --out eval/alabama_parity_baseline.json

    # AFTER
    python eval/alabama_parity.py compare --baseline eval/alabama_parity_baseline.json

It records the ordered result of every calibrated golden case — the chunk ids,
the citable codes, AND the distances to 12 decimal places. Distances are the
part that matters: a change in which rows are in the corpus shows up there long
before it changes an ordering, so comparing codes alone would let real drift
through. Anything but an exact match exits non-zero.

Deliberately NOT part of the normal test run: it needs a live corpus and a
baseline captured against a specific deployment. It is a cutover gate, and it
belongs in the release runbook next to the post-cutover checks.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GOLDEN = PROJECT_ROOT / "data" / "eval" / "current_golden_cases.json"
sys.path.insert(0, str(PROJECT_ROOT))

STATE = "AL"
TOP_N = 20
# Distances are float8 out of Postgres. Full repr would make the comparison
# sensitive to the last bit of a float that survived a round trip; 12 places is
# far finer than any real corpus change and stable across a dump/reload.
PLACES = 12


def _snapshot() -> dict:
    from backend import retrieval

    if not GOLDEN.is_file():
        raise SystemExit(f"missing {GOLDEN.relative_to(PROJECT_ROOT)} — generate the golden set first")
    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))

    results: dict[str, list] = {}
    for index, case in enumerate(cases):
        key = f"{index:03d}:{case['course']}:{case['grade']}:{case['expected_code']}"
        hits = retrieval.retrieve_raw(
            case["query"], n=TOP_N, course=case["course"],
            grade=int(case["grade"]), state=STATE,
        )
        results[key] = [
            [
                hit["id"],
                str((hit.get("metadata") or {}).get("code") or ""),
                round(float(hit["distance"]), PLACES),
            ]
            for hit in hits
        ]
    return {"state": STATE, "top_n": TOP_N, "cases": len(cases), "results": results}


def _diff(baseline: dict, current: dict) -> list[str]:
    problems: list[str] = []
    if baseline.get("top_n") != current.get("top_n"):
        problems.append(f"top_n changed: {baseline.get('top_n')} -> {current.get('top_n')}")

    old, new = baseline.get("results", {}), current.get("results", {})
    for key in sorted(set(old) | set(new)):
        if key not in old:
            problems.append(f"{key}: case is new since the baseline")
            continue
        if key not in new:
            problems.append(f"{key}: case disappeared since the baseline")
            continue
        if old[key] == new[key]:
            continue
        # Say WHICH way it moved. "results differ" sends someone hunting; naming
        # the first divergent rank and whether the code or only the distance
        # changed usually identifies the cause on sight.
        if [row[:2] for row in old[key]] == [row[:2] for row in new[key]]:
            worst = max(
                (abs(a[2] - b[2]), i) for i, (a, b) in enumerate(zip(old[key], new[key]))
            )
            problems.append(
                f"{key}: same rows and order, but distances moved "
                f"(largest {worst[0]:.3g} at rank {worst[1]})"
            )
            continue
        for rank, (a, b) in enumerate(zip(old[key], new[key])):
            if a[:2] != b[:2]:
                problems.append(
                    f"{key}: rank {rank} was {a[1] or a[0]}, is now {b[1] or b[0]}"
                )
                break
        else:
            problems.append(
                f"{key}: result count changed {len(old[key])} -> {len(new[key])}"
            )
    return problems


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="command", required=True)

    cap = sub.add_parser("capture", help="record Alabama's current retrieval results")
    cap.add_argument("--out", type=Path, required=True)

    cmp_ = sub.add_parser("compare", help="re-run and require an exact match")
    cmp_.add_argument("--baseline", type=Path, required=True)
    cmp_.add_argument("--out", type=Path, default=None,
                      help="also write the current snapshot, for inspection")

    args = ap.parse_args(argv)
    current = _snapshot()

    if args.command == "capture":
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")
        print(f"Captured {current['cases']} cases (top {TOP_N}) to {args.out}")
        return 0

    if not args.baseline.is_file():
        print(f"PARITY FAIL — no baseline at {args.baseline}. Capture one before migrating.")
        return 1
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    if args.out:
        args.out.write_text(json.dumps(current, indent=2) + "\n", encoding="utf-8")

    problems = _diff(baseline, current)
    if problems:
        print(f"PARITY FAIL — Alabama retrieval changed in {len(problems)} case(s):")
        for line in problems[:40]:
            print(f"  {line}")
        if len(problems) > 40:
            print(f"  ... and {len(problems) - 40} more")
        return 1

    print(f"PARITY PASS — all {current['cases']} Alabama cases identical "
          f"to the baseline, including distances to {PLACES} places.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
