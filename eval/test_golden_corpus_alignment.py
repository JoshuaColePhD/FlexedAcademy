"""Check that golden expectations still describe the current corpus.

This is intentionally separate from retrieval recall. A recall miss can mean
the ranking is bad, but it can also mean a source was re-ingested under a new
course identity, a code was retired, or a golden case points at a code that no
longer exists. Those need different fixes.

Run: ./venv/bin/python eval/test_golden_corpus_alignment.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROCESSED = PROJECT_ROOT / "data" / "processed"
GOLDEN = PROJECT_ROOT / "data" / "eval" / "golden_cases.json"

sys.path.insert(0, str(PROJECT_ROOT))

from backend.retrieval import _norm_code, normalize_course


def norm(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip().casefold()


def load_rows() -> list[dict]:
    rows: list[dict] = []
    for path in sorted(PROCESSED.glob("*chunks.json")):
        rows.extend(json.loads(path.read_text(encoding="utf-8")))
    return rows


def main() -> int:
    if not GOLDEN.is_file():
        print(f"FAIL — missing {GOLDEN.relative_to(PROJECT_ROOT)}")
        return 1

    rows = load_rows()
    if not rows:
        print("FAIL — no processed chunk files found")
        return 1

    by_code: dict[str, list[dict]] = defaultdict(list)
    by_course_code: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for row in rows:
        code = _norm_code(str(row.get("code") or row.get("id")))
        course = normalize_course(row.get("course"))
        if code:
            by_code[code].append(row)
            by_course_code[(course, code)].append(row)

    cases = json.loads(GOLDEN.read_text(encoding="utf-8"))
    counts: Counter[str] = Counter()
    details: list[tuple[str, dict, list[dict]]] = []
    for case in cases:
        code = _norm_code(str(case.get("expected_code") or ""))
        course = normalize_course(case.get("course"))
        exact_course = by_course_code.get((course, code), [])
        anywhere = by_code.get(code, [])
        if exact_course:
            status = "exact_course"
        elif anywhere:
            status = "code_exists_other_course_or_variant"
        else:
            status = "missing_code"
        counts[status] += 1
        if status != "exact_course":
            details.append((status, case, anywhere))

    print(f"Corpus rows: {len(rows)}")
    print(f"Golden cases: {len(cases)}")
    for status in ("exact_course", "code_exists_other_course_or_variant", "missing_code"):
        print(f"  {status}: {counts[status]}")

    if details:
        print("\nCases needing review before interpreting retrieval recall:")
        for status, case, matches in details:
            locations = sorted({str(row.get("course")) for row in matches})[:4]
            suffix = f"; found under: {', '.join(locations)}" if locations else ""
            print(
                f"  [{status}] {case.get('course')}:{case.get('expected_code')}"
                f"{suffix}"
            )

    missing = counts["missing_code"]
    if missing:
        print(
            f"\nWARNING — {missing} golden expectation(s) name code(s) absent "
            "from the current corpus; refresh or retire those cases before "
            "using recall as a release gate."
        )
    else:
        print("\nPASS — every golden expected code exists in the current corpus.")
    print("PASS — alignment report generated; retrieval recall remains a separate signal.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
