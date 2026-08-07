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
# Expected ACT sections, as the letter each section's codes start with.
S, M, E, R, W = "S", "M", "E", "R", "W"

CASES: list[tuple[str, str, tuple[str, ...]]] = [
    # (course, week query, the ACT sections that may legitimately be cited)
    ("AP Physics 1", "forces, free-body diagrams, and justifying a claim from experimental data", (S,)),
    ("AP Physics C", "rotational motion lab, analyzing graphs of angular velocity", (S,)),
    ("AP Chemistry", "stoichiometry and limiting reactants, designing an experiment", (S,)),
    ("AP Biology", "cellular respiration lab and interpreting data tables", (S,)),
    ("AP Environmental Science", "population dynamics and evaluating conflicting models", (S,)),
    ("Science", "Newton's laws investigation with evidence-based conclusions", (S,)),
    ("Pre-AP Chemistry", "atomic structure and periodic trends", (S,)),
    ("AP Calculus AB & BC", "related rates and interpreting the derivative in context", (M,)),
    ("AP Statistics", "sampling distributions and margin of error", (M,)),
    ("AP Precalculus", "modeling with exponential and logarithmic functions", (M,)),
    ("Math", "solving systems of equations and graphing the solution", (M,)),
    ("Pre-AP Algebra 1", "slope and linear equations from a table", (M,)),
    ("AP_Lang", "rhetorical analysis of Letter from Birmingham Jail, tone and appeals", (E, R, W)),
    ("ELA", "argument writing with credible evidence and counterclaim", (E, R, W)),
    ("AP English Literature and Composition", "close reading of poetry, imagery and speaker", (E, R, W)),
    ("Pre AP English 1", "narrative structure and word choice", (E, R, W)),
    # Social studies and humanities -> ACT Reading.
    ("AP US History", "causes of the Civil War, sourcing and corroborating documents", (R,)),
    ("AP World History", "trade networks and comparing civilizations", (R,)),
    ("AP European History", "the Reformation and interpreting primary sources", (R,)),
    ("AP US Government & Politics", "federalism and the separation of powers", (R,)),
    ("AP Human Geography", "urban models and population pyramids", (R,)),
    ("AP Macroeconomics", "fiscal policy and aggregate demand", (R,)),
    ("AP Psychology", "operant conditioning and research methods", (R,)),
    ("Social_Studies", "the Constitution and separation of powers", (R,)),
    ("Arts", "developing a portfolio piece and critique", (R,)),
    ("AP Music Theory", "harmonic analysis and part writing", (R,)),
    # The ACT tests none of these.
    ("AP Computer Science A", "arrays, loops, and tracing method calls", ()),
    ("AP Computer Science Principles", "data representation and algorithms", ()),
    ("PE", "fitness testing and personal goal setting", ()),
    ("Health", "nutrition and decision-making skills", ()),
    ("World_Languages", "past tense narration and cultural comparison", ()),
    ("Counseling", "post-secondary planning and self-advocacy", ()),
]

SECTION_NAME = {"E": "English", "R": "Reading", "M": "Math", "S": "Science", "W": "Writing"}


def section_of(code: str) -> str:
    """The ACT section a code belongs to — see act_sections_for()."""
    return code[0] if len(code) > 1 and code[1] == "." and code[0] in SECTION_NAME else "E"

GRADE = 11
failures: list[str] = []
rows: list[tuple] = []


def check(course: str, query: str, expect: tuple[str, ...]) -> None:
    result = retrieval.retrieve_grounded(query, subject_code=course, grade=GRADE)
    by_type = Counter((c["metadata"] or {}).get("source_type") for c in result.chunks)

    act_codes, foreign, primary_codes = [], [], []
    for c in result.chunks:
        m = c["metadata"] or {}
        st, code, chunk_course = m.get("source_type"), m.get("code"), m.get("course")

        if st == "act_standards":
            act_codes.append(code)
            got = section_of(str(code))
            if not expect:
                failures.append(
                    f"{course}: the ACT tests nothing this course teaches, but "
                    f"retrieval returned ACT {code} ({SECTION_NAME[got]})"
                )
            elif got not in expect:
                want = "/".join(SECTION_NAME[s] for s in expect)
                failures.append(
                    f"{course}: expected ACT {want}, got {code} "
                    f"from the {SECTION_NAME[got]} section"
                )
        elif st == "act_recurring":
            # Alabama ELA recurring standards. ELA-family courses only — a
            # history course maps to ACT Reading, which does not make Alabama's
            # ELA recurring standards its own.
            if "E" not in expect:
                failures.append(
                    f"{course}: got Alabama ELA recurring standard {code} "
                    f"in a non-ELA course"
                )
        else:
            primary_codes.append(code)
            # A primary standard must belong to this course. "Belong to" means
            # any `course` value that IS this course — the College Board ingest
            # files one course under several names taken from its source
            # documents ("AP US History Key Concepts", "APHuG"), and
            # course_variants() is what reunites them.
            if chunk_course not in retrieval.course_variants(course):
                foreign.append(f"{code}({chunk_course})")
            # An AP course grounds in AP skills, not the state course of study.
            if retrieval.is_ap_course(course) and st == "state_course_of_study":
                failures.append(
                    f"{course}: AP course cited state course of study {code}"
                )

    if foreign:
        failures.append(f"{course}: primary standards from another course: {', '.join(foreign[:4])}")

    rows.append((course, len(result.chunks), dict(by_type),
                 ", ".join(str(c) for c in act_codes[:2]) or "—",
                 ", ".join(str(c) for c in primary_codes[:2]) or "—"))


def main() -> int:
    print(f"{'COURSE':40} {'N':>3}  {'ACT COMPANION':22} PRIMARY")
    print("-" * 110)
    for course, query, expect in CASES:
        try:
            check(course, query, expect)
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
