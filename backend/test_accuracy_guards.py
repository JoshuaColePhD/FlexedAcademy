"""Regression tests for the four "does this generate an accurate, complete
plan" guards added 2026-08-27, prompted by a teacher directly asking whether
a third-grade request is guaranteed to (a) ground on real third-grade
standards and (b) never leave a template cell blank. Answering that live,
by hand, in a Python REPL against the production DB is how the gaps below
were originally found — this file is what stops them from reopening
silently the next time one of these functions is touched.

Run (from the project root, so `backend.*` resolves as a package — the same
convention builder/test_generic_renderer.py already uses):

  pytest backend/test_accuracy_guards.py
"""
from __future__ import annotations

import os

import pytest

from backend import schema
from backend.retrieval import RetrievalResult, act_only_grounding_error, audit_grounding
from backend.schema import SchemaError

# Needs DATABASE_URL — same requirement as the app itself, and skipped rather
# than failing hard when it's absent (e.g. CI without a DB configured), so
# this file can still be collected and the DB-free tests below still run.
_HAS_DB = bool(os.environ.get("DATABASE_URL"))
requires_db = pytest.mark.skipif(not _HAS_DB, reason="no DATABASE_URL configured")


def _full_day(**overrides) -> dict:
    """A day with every field genuinely filled — the baseline every test
    below mutates one field of, so a failure always points at the ONE field
    that broke rather than requiring the reader to diff the whole fixture."""
    day = {
        "name": "Monday",
        "no_school": False,
        "title": "Intro",
        "learning_targets": "I can analyze rhetoric.",
        "standards": "RHS-1A",
        "act_alignment": "",
        "engagement_strategy": ["Think-Pair-Share"],
        "do_now": "Warm-up question",
        "during": "Main activity",
        "assessment": "Exit ticket",
    }
    day.update(overrides)
    return day


# ---------------------------------------------------------------------------
# Gap 1 — a blank standards/do_now/assessment cell used to pass validation
# silently (schema.py only hard-checked learning_targets and during).
# ---------------------------------------------------------------------------


def test_validate_day_accepts_a_fully_filled_day():
    schema.validate_day(_full_day())


@pytest.mark.parametrize("field", ["standards", "do_now", "assessment", "learning_targets", "during"])
def test_validate_day_rejects_blank_content_fields(field):
    with pytest.raises(SchemaError) as exc:
        schema.validate_day(_full_day(**{field: ""}))
    assert exc.value.code == "day_empty_field"


def test_validate_day_still_allows_blank_act_alignment():
    """Correct output for any course with no ACT companion section — a
    course-blind check here would wrongly reject it. See act_alignment's own
    exclusion comment in validate_day."""
    schema.validate_day(_full_day(act_alignment=""))


@pytest.mark.parametrize("field", schema.WEEDEN_SECTION_FIELDS)
def test_weeden_plan_rejects_a_blank_required_template_row(field):
    """A new Weeden document must not be saved with a visible empty row."""
    with pytest.raises(SchemaError) as exc:
        schema.validate_day(
            _full_day(**{field: ""}), require_weeden_sections=True
        )
    assert exc.value.code == "day_empty_field"


# ---------------------------------------------------------------------------
# Gap 2 — audit_grounding used to only WARN about a missing ACT alignment,
# even for a course whose companion ACT section makes it mandatory; the
# plan built and persisted anyway with a genuinely empty cell.
# ---------------------------------------------------------------------------


def _week(day: dict) -> dict:
    return {"week_of": "2026-01-05", "course": "Test Course", "days": [day]}


def test_audit_grounding_raises_when_act_alignment_missing_and_expected():
    # AP Lang has a real companion ACT English/Reading/Writing section.
    plan = _week(_full_day(act_alignment=""))
    with pytest.raises(SchemaError) as exc:
        audit_grounding(plan, allowed=set(), subject_code="AP_Lang")
    assert exc.value.code == "day_empty_field"


def test_audit_grounding_does_not_raise_when_act_has_no_companion_section():
    # Counseling is one of act_sections_for's own documented empty cases.
    plan = _week(_full_day(act_alignment=""))
    warnings = audit_grounding(plan, allowed=set(), subject_code="Counseling")
    assert not any("ACT" in w for w in warnings)


def test_audit_grounding_does_not_raise_when_act_alignment_present():
    plan = _week(_full_day(act_alignment="R4"))
    # Should not raise even though R4 isn't in `allowed` — that's a
    # different (warning-only) hallucination check, not this one.
    audit_grounding(plan, allowed=set(), subject_code="AP_Lang")


# ---------------------------------------------------------------------------
# Gap 3 — a request could ground entirely on ACT companion material (which
# deliberately skips grade filtering) with zero real course standards for
# that grade, and RetrievalResult.empty alone couldn't see it: `chunks` was
# non-empty, just entirely the wrong stratum.
# ---------------------------------------------------------------------------


def test_only_act_true_when_every_chunk_is_act_sourced():
    result = RetrievalResult(chunks=[
        {"metadata": {"source_type": "act_standards"}},
        {"metadata": {"source_type": "act_recurring"}},
    ])
    assert result.only_act is True


def test_only_act_false_when_any_real_standard_present():
    result = RetrievalResult(chunks=[
        {"metadata": {"source_type": "state_course_of_study"}},
        {"metadata": {"source_type": "act_standards"}},
    ])
    assert result.only_act is False


def test_only_act_false_when_empty():
    """A different, pre-existing check (RetrievalResult.empty) owns this
    case — only_act must not double-fire on it."""
    assert RetrievalResult(chunks=[]).only_act is False


def test_act_only_grounding_error_is_a_422():
    err = act_only_grounding_error("query", RetrievalResult(chunks=[{"metadata": {"source_type": "act_standards"}}]), grade=3)
    assert err.status == 422
    assert "grade 3" in err.message


# ---------------------------------------------------------------------------
# Gap 4 — a class's `subject` was only ever guaranteed to resolve to a real,
# retrievable course by FrameworkPicker.jsx's constrained combobox — a
# frontend convention, never enforced by the API itself.
# ---------------------------------------------------------------------------


@requires_db
def test_validate_subject_accepts_a_real_course_code():
    from backend.routes.classes import _validate_subject

    _validate_subject("AP_Lang")  # must not raise


@requires_db
def test_validate_subject_accepts_known_aliases():
    from backend.routes.classes import _validate_subject

    _validate_subject("AP Language & Composition")  # display-name alias
    _validate_subject("English_Language_Arts")  # retired course-code alias


@requires_db
def test_validate_subject_rejects_an_unresolvable_subject():
    from backend.errors import AppError
    from backend.routes.classes import _validate_subject

    with pytest.raises(AppError) as exc:
        _validate_subject("Definitely Not A Real Subject")
    assert exc.value.code == "unknown_subject"


@requires_db
def test_grade_3_has_real_standards_for_core_subjects():
    """The specific claim made to the teacher: a grade-3 request in these
    subjects grounds on real grade-3 content, not a silent fallback to
    whatever grade happens to have the most chunks."""
    from backend import db

    for subject in ("ELA", "Math", "Science", "Social_Studies"):
        rows = db._rows(
            "SELECT count(*) AS n FROM chunks "
            "WHERE metadata->>'course' = ? AND metadata->>'grade' = '3'",
            (subject,),
        )
        assert rows[0]["n"] > 0, f"expected some grade-3 chunks for {subject}"
