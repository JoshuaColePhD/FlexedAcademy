"""Recall gate for the current-corpus golden set.

Unlike the historical 143-case baseline, this file is generated from the
standards currently loaded and uses canonical course identities. It is the
release gate for future corpus changes; the historical gate remains useful for
diagnosing what changed but is not allowed to obscure corpus drift.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
GOLDEN = PROJECT_ROOT / "data" / "eval" / "current_golden_cases.json"
BASELINE = PROJECT_ROOT / "eval" / "current_baseline.json"
sys.path.insert(0, str(PROJECT_ROOT))

from backend import retrieval


def main() -> int:
    if not GOLDEN.is_file():
        print(f"SKIP — {GOLDEN.relative_to(PROJECT_ROOT)} has not been generated yet.")
        return 0
    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))
    top5 = 0
    deep = 0
    misses = []
    for case in cases:
        hits = retrieval.retrieve_raw(
            case["query"], n=20, course=case["course"], grade=int(case["grade"])
        )
        codes = [retrieval._norm_code(str((hit.get("metadata") or {}).get("code") or hit["id"])) for hit in hits]
        expected = retrieval._norm_code(case["expected_code"])
        if expected in codes:
            deep += 1
            if codes.index(expected) < 5:
                top5 += 1
        else:
            misses.append(f"{case['course']}:{case['expected_code']}")

    now = {"cases": len(cases), "recall_at_5": top5, "recall_at_20": deep, "never_found": sorted(misses)}
    print(json.dumps(now, indent=2))
    if not BASELINE.is_file():
        BASELINE.write_text(json.dumps(now, indent=2) + "\n", encoding="utf-8")
        print("Baseline created from the current corpus.")
        return 0
    previous = json.loads(BASELINE.read_text(encoding="utf-8"))
    if now["recall_at_5"] < previous["recall_at_5"] or set(now["never_found"]) - set(previous["never_found"]):
        print("FAIL — current-corpus retrieval regressed against its baseline.")
        return 1
    print(f"PASS — current-corpus recall@5 {top5}/{len(cases)}; recall@20 {deep}/{len(cases)}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
