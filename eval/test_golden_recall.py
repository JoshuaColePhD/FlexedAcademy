#!/usr/bin/env python3
"""Golden-set recall, measured against a recorded baseline.

data/eval/golden_cases.json holds 143 synthetic teacher phrasings, each paired
with the standard it was written from. The question this asks is: does the
teacher's own wording still surface the standard it came from?

It reports a NUMBER, not a pass/fail per case, because a handful of these cases
are genuinely unwinnable and always have been. The corpus is full of standards
whose codes differ by one character and whose text differs by one word —
PE19.BK1.2.2.APE and PE19.BK2.2.2.APE, or 7A / 7A1 / 7D / 7D1 in AP Chinese. A
one-sentence paraphrase cannot pick between them, and pretending otherwise
would mean either deleting the hard cases or living with a red suite.

So the contract is: recall@5 must not fall below BASELINE, and no case may
regress from "found" to "not found anywhere in the top 60" without being
recorded here. That catches a real retrieval regression while tolerating the
cases that were never separable.

Run:  ./venv/bin/python eval/test_golden_recall.py
      ./venv/bin/python eval/test_golden_recall.py --update-baseline
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import retrieval as R  # noqa: E402

GOLDEN = PROJECT_ROOT / "data" / "eval" / "golden_cases.json"
BASELINE = Path(__file__).parent / "baseline.json"
DEEP_N = 60


def rank_of(case: dict, n: int) -> int | None:
    """1-based rank of the expected code, or None if it is not in the top n."""
    hits = R.retrieve_raw(case["query"], n=n, course=case["course"], grade=case["grade"])
    codes = [R._norm_code(str((c.get("metadata") or {}).get("code") or c["id"])) for c in hits]
    want = R._norm_code(case["expected_code"])
    return codes.index(want) + 1 if want in codes else None


def measure() -> dict:
    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))
    top5, deep, misses = 0, 0, []
    for i, case in enumerate(cases, 1):
        r = rank_of(case, DEEP_N)
        if r is not None and r <= 5:
            top5 += 1
        if r is not None:
            deep += 1
        else:
            misses.append(f"{case['course']}:{case['expected_code']}")
        if r is None or r > 5:
            print(f"  [{i:3}/{len(cases)}] rank={str(r):>4}  "
                  f"{case['course']}: {case['expected_code']}")
    return {
        "cases": len(cases),
        "recall_at_5": top5,
        f"recall_at_{DEEP_N}": deep,
        "never_found": sorted(misses),
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--update-baseline", action="store_true",
                    help="record the current numbers as the new baseline")
    args = ap.parse_args()

    print(f"Golden set: {GOLDEN.relative_to(PROJECT_ROOT)}")
    print("Cases below rank 5 (the hard ones — listed, not hidden):\n")
    now = measure()
    print(f"\n  cases         {now['cases']}")
    print(f"  recall@5      {now['recall_at_5']}/{now['cases']}")
    print(f"  recall@{DEEP_N}     {now[f'recall_at_{DEEP_N}']}/{now['cases']}")
    print(f"  never found   {len(now['never_found'])}  {now['never_found']}")

    if args.update_baseline or not BASELINE.is_file():
        BASELINE.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
        print(f"\nBaseline written to {BASELINE.relative_to(PROJECT_ROOT)}.")
        return 0

    was = json.loads(BASELINE.read_text(encoding="utf-8"))
    failures = []
    if now["recall_at_5"] < was["recall_at_5"]:
        failures.append(
            f"recall@5 fell from {was['recall_at_5']} to {now['recall_at_5']}"
        )
    newly_lost = set(now["never_found"]) - set(was["never_found"])
    if newly_lost:
        failures.append(
            f"{len(newly_lost)} standard(s) dropped out of the top {DEEP_N} entirely: "
            f"{sorted(newly_lost)}"
        )
    recovered = set(was["never_found"]) - set(now["never_found"])
    if recovered:
        print(f"\n  (improved: {sorted(recovered)} now found — "
              f"rerun with --update-baseline to lock it in)")

    print()
    if failures:
        print(f"FAIL — {len(failures)} regression(s) against the baseline:")
        for f in failures:
            print(f"  * {f}")
        return 1
    print(f"PASS — recall@5 {now['recall_at_5']}/{now['cases']}, "
          f"at or above the baseline of {was['recall_at_5']}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
