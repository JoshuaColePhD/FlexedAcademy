"""Deterministic synthetic week data for verifying a generated builder spec.

Not LLM-generated: determinism means every attempt in a codegen retry loop
renders directly comparable output, and there's no reason to spend a call on
filler content. Every day gets clearly-labeled, day-specific placeholder text
(e.g. "MONDAY-STANDARDS-TEST") — a wrong-row or wrong-column mapping becomes
visually obvious to the vision judge, directly targeting the failure mode
this whole pipeline exists to catch: a generated builder silently putting one
day's content in another day's box.
"""
from __future__ import annotations

from ..schema import DAY_NAMES, ENGAGEMENT_OPTIONS


def synthetic_week_fixture(analysis: dict | None = None) -> dict:
    """Returns a plan dict shaped like backend/schema.py's validated plan
    (week_of + days, each with every DAY_CONTENT_FIELDS key), fully populated
    with day-specific placeholder text. `analysis` is accepted but currently
    unused — reserved for a future version that seeds placeholder text from
    the template's own section descriptions; kept in the signature now so
    call sites don't need to change when that lands."""
    days = []
    for day_name in DAY_NAMES:
        tag = day_name.upper()
        days.append({
            "name": day_name,
            "no_school": False,
            "learning_targets": f"I can identify the {tag}-LEARNING-TARGET-TEST skill.",
            "standards": f"{tag}-STANDARDS-TEST",
            "act_alignment": f"{tag}-ACT-TEST",
            "engagement_strategy": ENGAGEMENT_OPTIONS[DAY_NAMES.index(day_name) % len(ENGAGEMENT_OPTIONS)],
            "do_now": f"{tag}-DO-NOW-TEST: bell-ringer placeholder for {day_name}.",
            "during": f"{tag}-DURING-TEST: main-instruction placeholder for {day_name}.",
            "assessment": f"{tag}-ASSESSMENT-TEST: exit-ticket placeholder for {day_name}.",
        })

    return {
        "teacher": "FIXTURE-TEACHER-TEST",
        "course": "FIXTURE-COURSE-TEST",
        "period": "FIXTURE-PERIOD-TEST",
        "week_of": "FIXTURE-WEEK-TEST",
        "days": days,
    }


def fixture_expectations(fixture: dict) -> list[str]:
    """Flat list of the placeholder strings a vision judge should be able to
    find, each in its own expected cell — handed to llm.judge_builder_render
    as `fixture_expectations` so the judge knows what to look for without
    having to infer it from the raw fixture dict."""
    expected = [
        f"{fixture['teacher']} (in a Teacher/identity header cell)",
        f"{fixture['week_of']} (in a Week/identity header cell)",
    ]
    for day in fixture["days"]:
        tag = day["name"].upper()
        expected.append(f"{tag}-STANDARDS-TEST (Standards row, {day['name']} column)")
        expected.append(f"{tag}-DO-NOW-TEST (Lesson/Do Now row, {day['name']} column)")
        expected.append(f"{tag}-ASSESSMENT-TEST (Lesson/Assessment row, {day['name']} column)")
    return expected
