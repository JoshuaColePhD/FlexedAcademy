#!/usr/bin/env python3
"""Step 8 — Generation quality audit: real prompts, real generations, real citations checked.

The pieces already existed, just never wired together:

  - "random reasonable prompts per course" is data/eval/golden_cases.json —
    scripts/07_generate_golden_evals.py already samples real standards from
    the corpus and asks an LLM to phrase a natural teacher request for each,
    per course. It's only ever been used to check RETRIEVAL recall (does the
    expected code show up in top-k) — never to check what a full GENERATION
    actually cites.
  - "checking the standards output are accurate" is backend/retrieval.py's
    cited_standards()/audit_grounding() — the exact grounding audit that
    already runs on every real production generation (backend/service.py).
    It's just never been run in aggregate, across courses, outside of one
    request at a time.

This script is the wiring: for each golden case (optionally filtered/limited),
run the real pipeline — service.prepare() then llm.generate_plan(), the same
two calls a real teacher's request makes — then classify every cited code
with cited_standards() and roll the results up per course.

This calls OpenAI once per case (retrieval's own query-expansion call, plus
one generation call) and needs a real corpus. Skips cleanly with a message if
OPENAI_API_KEY is unset, same convention as scripts/05_eval_harness.py's own
generation suite. Nothing here is wired into CI (.github/workflows/quality.yml
runs eval/run_all.py --fast only) for the same reason that suite isn't: this
costs real tokens and needs production-shaped data, not something to run on
every push.

Usage:
    python scripts/08_generation_quality_audit.py                    # every course, up to --limit cases
    python scripts/08_generation_quality_audit.py --course AP_Lang   # one course only
    python scripts/08_generation_quality_audit.py --limit 40         # raise the cost ceiling
    python scripts/08_generation_quality_audit.py --all              # no limit at all
    python scripts/08_generation_quality_audit.py --save             # also write a timestamped JSON report

Read the report as a floor, not a ceiling: a course with too few golden cases
(scripts/07 samples 2 chunks per course) gets a noisy per-course percentage —
treat anything short of ~10 cases as "needs a bigger sample," not "this course
is broken," and widen scripts/07's sample size for that course before trusting
a low grounded-rate number on its own.
"""
from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import errors, retrieval, schema
from backend.config import settings

GOLDEN_CASES_PATH = PROJECT_ROOT / "data" / "eval" / "golden_cases.json"

# The account every eval/audit script in this repo runs as (scripts/05, 06's
# settings_row reads implicitly assume it exists) — a real row in the users
# table, not a synthetic id, so db.get_settings_row/custom_instructions_for
# etc. all resolve normally.
EVAL_USER_ID = "default_user"

# GENERIC_SCHOOL from WelcomePage.jsx's own comment: a real school id with NO
# real calendar or template behind it on purpose, special-cased directly in
# backend/schoolcal.py so it needs no schools-table row. Exactly what an
# audit run wants — nothing here should depend on which real school happens
# to exist in whatever database this runs against.
GENERIC_SCHOOL = "generic"


def load_golden_cases(course: str | None, limit: int | None) -> list[dict]:
    if not GOLDEN_CASES_PATH.is_file():
        print(f"No golden cases file at {GOLDEN_CASES_PATH} — run scripts/07_generate_golden_evals.py first.")
        return []
    cases = json.loads(GOLDEN_CASES_PATH.read_text())
    if course:
        cases = [c for c in cases if c.get("course") == course]
    if limit is not None:
        cases = cases[:limit]
    return cases


def audit_one_case(case: dict) -> dict:
    """Runs the real pipeline for one golden case and classifies every cited
    code. Never raises — a refusal (ungroundable request, out-of-scope grade,
    schema violation, anything else) becomes a recorded outcome for this case,
    not a crash that loses every other course's results."""
    from backend import llm, service  # local import: same reason 05_eval_harness.py's

    course = case["course"]
    grade = str(case.get("grade") or "11")
    query = case["query"]
    cls = {"subject": course, "grade": grade, "name": course}

    outcome: dict = {"course": course, "grade": grade, "query": query, "expected_code": case.get("expected_code")}
    try:
        result = service.prepare(EVAL_USER_ID, query, cls=cls)
        outcome["retrieved_count"] = len(result.chunks)
        outcome["expected_code_retrieved"] = case.get("expected_code") in result.codes

        plan = llm.generate_plan(EVAL_USER_ID, query, result, school_id=GENERIC_SCHOOL, class_id=None)
        plan, schema_warnings = schema.validate_plan(plan)
        outcome["schema_warnings"] = schema_warnings

        # subject_code passed exactly as `course` — prepare()/_resolve_subject_grade
        # never normalizes cls["subject"] through service.subject_code() either
        # (see backend/service.py), so this matches what actually scoped the
        # retrieval this plan was grounded against.
        entries = retrieval.cited_standards(plan, result.codes, subject_code=course)
        outcome["citations"] = entries
        outcome["status"] = "ok"
    except (errors.AppError, schema.SchemaError) as e:
        outcome["status"] = "refused"
        outcome["error"] = str(getattr(e, "message", e))
    except Exception as e:  # noqa: BLE001 — one bad case must not end the sweep
        outcome["status"] = "error"
        outcome["error"] = f"{type(e).__name__}: {e}"
    return outcome


def summarize(outcomes: list[dict]) -> dict[str, Counter]:
    per_course: dict[str, Counter] = defaultdict(Counter)
    for o in outcomes:
        c = per_course[o["course"]]
        c["cases"] += 1
        if o["status"] != "ok":
            c[f"status:{o['status']}"] += 1
            continue
        c["cases_ok"] += 1
        if o.get("expected_code_retrieved"):
            c["expected_code_retrieved"] += 1
        for entry in o.get("citations", []):
            c[f"citation:{entry['status']}"] += 1
    return per_course


def print_report(per_course: dict[str, Counter]) -> None:
    print("\n" + "=" * 78)
    print("PER-COURSE GENERATION QUALITY")
    print("=" * 78)
    total = Counter()
    for course in sorted(per_course):
        c = per_course[course]
        total.update(c)
        cited_total = sum(c[k] for k in c if k.startswith("citation:"))
        grounded = c["citation:grounded"]
        rate = f"{grounded}/{cited_total}" if cited_total else "no citations"
        print(f"\n{course}  ({c['cases']} case{'s' if c['cases'] != 1 else ''})")
        if c["cases_ok"] < c["cases"]:
            for status in ("refused", "error"):
                if c[f"status:{status}"]:
                    print(f"  {status}: {c[f'status:{status}']}")
        if c["cases_ok"]:
            print(f"  citations grounded: {rate}")
            for status in ("not_retrieved", "wrong_course", "hallucinated"):
                if c[f"citation:{status}"]:
                    print(f"    {status}: {c[f'citation:{status}']}")
            print(f"  expected code actually retrieved: {c['expected_code_retrieved']}/{c['cases_ok']}")

    print("\n" + "-" * 78)
    cited_total = sum(total[k] for k in total if k.startswith("citation:"))
    print(f"TOTAL: {total['cases']} cases across {len(per_course)} courses")
    if cited_total:
        print(f"  citations grounded overall: {total['citation:grounded']}/{cited_total}")
    print("=" * 78)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--course", default=None, help="limit to one course code (e.g. AP_Lang)")
    ap.add_argument("--limit", type=int, default=20, help="max cases to run (default 20 — this costs real tokens)")
    ap.add_argument("--all", action="store_true", help="no limit — run every golden case")
    ap.add_argument("--save", action="store_true", help="also write a timestamped JSON report to eval/reports/")
    args = ap.parse_args()

    if not settings.has_api_key:
        print("SKIP: OPENAI_API_KEY not set — this suite needs a live model and a live corpus.")
        return 0

    limit = None if args.all else args.limit
    cases = load_golden_cases(args.course, limit)
    if not cases:
        print("No golden cases matched — nothing to audit.")
        return 1

    print(f"Auditing {len(cases)} case(s)"
          f"{f' for course={args.course}' if args.course else ' across every course'}...\n")
    outcomes = []
    for i, case in enumerate(cases, 1):
        print(f"[{i}/{len(cases)}] {case['course']}: {case['query'][:70]}")
        outcomes.append(audit_one_case(case))

    per_course = summarize(outcomes)
    print_report(per_course)

    if args.save:
        out_dir = PROJECT_ROOT / "eval" / "reports"
        out_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
        out_path = out_dir / f"generation_quality_{ts}.json"
        out_path.write_text(json.dumps(outcomes, indent=2))
        print(f"\nWrote full detail to {out_path.relative_to(PROJECT_ROOT)}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
