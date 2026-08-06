#!/usr/bin/env python3
"""Cross-course grounding sweep: does every course retrieve ITS OWN standards?

The bug this exists to catch: an AP Physics 1 week whose ACT Alignment row cited
R.WME.501 (ACT Reading — word meanings in a prose passage) and R6 (Alabama ELA
recurring — grammar, mechanics and usage, sourced to alcos_ela.pdf). Neither is
wrong-in-the-abstract; both are simply another subject's standards, retrieved
because the ACT strata skipped course filtering entirely.

Run:  ./venv/bin/python scratch/test_cross_course_grounding.py

This talks to the live corpus and the embeddings API. It reads only.
"""
from __future__ import annotations

import sys
from collections import Counter

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from backend import retrieval  # noqa: E402

# A realistic week query per course, in the teacher's own register — not in
# standards language, because that is what the app actually embeds.
CASES: list[tuple[str, str, str | None]] = [
    # (course, week query, expected ACT companion section or None)
    ("AP Physics 1", "forces, free-body diagrams, and justifying a claim from experimental data", "Science"),
    ("AP Physics C", "rotational motion lab, analyzing graphs of angular velocity", "Science"),
    ("AP Chemistry", "stoichiometry and limiting reactants, designing an experiment", "Science"),
    ("AP Biology", "cellular respiration lab and interpreting data tables", "Science"),
    ("AP Environmental Science", "population dynamics and evaluating conflicting models", "Science"),
    ("Science", "Newton's laws investigation with evidence-based conclusions", "Science"),
    ("AP Calculus AB & BC", "related rates and interpreting the derivative in context", "Math"),
    ("AP Statistics", "sampling distributions and margin of error", "Math"),
    ("AP Precalculus", "modeling with exponential and logarithmic functions", "Math"),
    ("Math", "solving systems of equations and graphing the solution", "Math"),
    ("AP_Lang", "rhetorical analysis of Letter from Birmingham Jail, tone and appeals", "ELA"),
    ("ELA", "argument writing with credible evidence and counterclaim", "ELA"),
    ("AP English Literature and Composition", "close reading of poetry, imagery and speaker", "ELA"),
    ("AP US History", "causes of the Civil War, sourcing and corroborating documents", None),
    ("AP Psychology", "operant conditioning and research methods", None),
    ("AP Computer Science A", "arrays, loops, and tracing method calls", None),
    ("Social_Studies", "the Constitution and separation of powers", None),
    ("Arts", "developing a portfolio piece and critique", None),
    ("PE", "fitness testing and personal goal setting", None),
    ("World_Languages", "past tense narration and cultural comparison", None),
]

# Which ACT sections legitimately belong to which companion area.
ACT_SECTIONS = {"Science": {"Science"}, "Math": {"Math"}, "ELA": {"English", "Reading", "Writing"}}

GRADE = 11
failures: list[str] = []
rows: list[tuple] = []


def check(course: str, query: str, expect_act: str | None) -> None:
    result = retrieval.retrieve_grounded(query, subject_code=course, grade=GRADE)
    by_type = Counter((c["metadata"] or {}).get("source_type") for c in result.chunks)

    act_codes, foreign, primary_codes = [], [], []
    for c in result.chunks:
        m = c["metadata"] or {}
        st, code, chunk_course = m.get("source_type"), m.get("code"), m.get("course")
        section = m.get("source_page_or_section", "")

        if st == "act_standards":
            act_codes.append(code)
            allowed = ACT_SECTIONS.get(expect_act or "", set())
            if expect_act is None:
                failures.append(
                    f"{course}: ACT has no section for this subject, but retrieval "
                    f"returned ACT {code} ({section})"
                )
            elif section not in allowed:
                failures.append(
                    f"{course}: expected ACT {expect_act} standards, got {code} "
                    f"from the {section} section"
                )
        elif st == "act_recurring":
            # Alabama ELA recurring standards. ELA-family courses only.
            if expect_act != "ELA":
                failures.append(
                    f"{course}: got Alabama ELA recurring standard {code} "
                    f"in a non-ELA course"
                )
        else:
            primary_codes.append(code)
            # A primary standard must belong to this course, or be a
            # course-agnostic College Board / AP skills chunk for it.
            if chunk_course != course:
                foreign.append(f"{code}({chunk_course})")

    if foreign:
        failures.append(f"{course}: primary standards from another course: {', '.join(foreign[:4])}")

    rows.append((course, len(result.chunks), dict(by_type),
                 ", ".join(str(c) for c in act_codes[:2]) or "—",
                 ", ".join(str(c) for c in primary_codes[:2]) or "—"))


def main() -> int:
    print(f"{'COURSE':40} {'N':>3}  {'ACT COMPANION':22} PRIMARY")
    print("-" * 110)
    for course, query, expect_act in CASES:
        try:
            check(course, query, expect_act)
            c, n, _types, act, primary = rows[-1]
            print(f"{c:40} {n:>3}  {act:22} {primary}")
        except Exception as e:  # noqa: BLE001 — a sweep reports, it does not abort
            failures.append(f"{course}: raised {type(e).__name__}: {e}")
            print(f"{course:40}  !! {type(e).__name__}: {e}")

    print()
    if failures:
        print(f"FAIL — {len(failures)} problem(s):")
        for f in failures:
            print(f"  * {f}")
        return 1
    print(f"PASS — {len(CASES)} courses, no cross-subject standards retrieved.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
