"""Deterministic quality checks over already-generated plans.

On Josh's own ask: not a thumbs-up/down feedback loop, a check that runs
without a teacher doing anything — does what a plan actually cites hold up
against what it was supposed to be grounded in.

Two checks, both reusing retrieval.py's own course/grade-scoped indexes
rather than a fresh corpus-wide scan (see retrieval.py's own comments on
why "does this code exist anywhere" is the wrong question — codes are not
unique across courses, and each grade re-uses standard numbers 1-30):

  hallucinated — a cited code that doesn't exist ANYWHERE in the corpus.
  mismatched   — a cited code that's real, but for a different course or a
                 different grade than the class this plan belongs to.

This runs over PERSISTED plans (routes/generate.py's live retrieval result
is long gone by the time an admin looks at this), so it re-derives scope
from the plan's own class_id rather than reusing audit_grounding()
verbatim — that function needs the generation's own `allowed` set (which
codes THIS run actually retrieved), which isn't something a plan row keeps.
A code this check flags might be one audit_grounding already warned about
at generation time (same corpus, same rules) or one that slipped through
because subject/grade scoping didn't exist yet when that plan was built.
"""
from __future__ import annotations

import json

from . import db, retrieval

# ACT codes are cross-course by design (a companion block a course's own
# plans cite alongside its real standards, never filed under that course) —
# audit_grounding unions them into `known` for the same reason rather than
# scoping them to course/grade; this check does the same or it would flag
# every legitimate ACT citation as a course mismatch.
_ACT_SOURCE_TYPES = ("act_standards", "act_recurring")


def _act_codes() -> frozenset[str]:
    return frozenset(
        retrieval._norm_code(c["code"])
        for c in retrieval.load_chunks()
        if c.get("source_type") in _ACT_SOURCE_TYPES and c.get("code")
    )


def spot_check_plan(row: dict) -> dict:
    """One row from db.list_plans_for_standards_qa() -> {hallucinated,
    mismatched} lists of codes (empty lists mean a clean plan)."""
    subject, grade = row.get("subject"), row.get("grade")
    raw_ids = row.get("retrieved_ids")
    cited = raw_ids if isinstance(raw_ids, list) else json.loads(raw_ids or "[]")
    codes = {retrieval._norm_code(c) for c in cited if c}

    all_known = retrieval.chunks_by_code()
    own = retrieval.codes_for_course_and_grade(subject, grade)
    act = _act_codes()

    hallucinated = sorted(c for c in codes if c not in all_known)
    mismatched = sorted(c for c in codes if c in all_known and c not in own and c not in act)

    return {"hallucinated": hallucinated, "mismatched": mismatched}


def run_standards_check() -> list[dict]:
    """Every plan with an actual issue, admin-wide — clean plans (the
    overwhelming majority, if the corpus and retrieval are doing their job)
    are left out entirely rather than returned with empty lists, so the
    admin panel only ever has to look at the ones that need attention."""
    flagged = []
    for row in db.list_plans_for_standards_qa():
        result = spot_check_plan(row)
        if result["hallucinated"] or result["mismatched"]:
            flagged.append(
                {
                    "plan_id": row["plan_id"],
                    "email": row["email"],
                    "week_label": row["week_label"],
                    "subject": row["subject"],
                    "grade": row["grade"],
                    **result,
                }
            )
    return flagged
