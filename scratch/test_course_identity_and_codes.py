#!/usr/bin/env python3
"""Course identity, AP grounding policy, and exact-code lookup.

Covers the four fixes made 2026-08-06 after the cross-subject ACT bug:

  1. An AP course grounds in AP skills, not the state course of study.
     Josh's rule: "If it's an AP class, I don't need regular standards."
  2. One course filed under several `course` values is ONE course.
  3. audit_grounding checks a code against THIS course, not the whole corpus.
  4. A code named in the query retrieves itself.

Run:  ./venv/bin/python scratch/test_course_identity_and_codes.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import retrieval as R  # noqa: E402

failures: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'ok ' if ok else 'FAIL'} {label:56} {got}")
    if not ok:
        failures.append(f"{label}: expected {want}, got {got}")


def main() -> int:
    print("--- 1. is_ap_course ---")
    for c in ("AP_Lang", "AP Physics 1", "AP US History", "Pre-AP Algebra 1", "Pre AP English 1"):
        check(f"is_ap_course({c!r})", R.is_ap_course(c), True)
    for c in ("ELA", "Science", "Math", "Social_Studies", "PE", "Health", "Apex Learning"):
        check(f"is_ap_course({c!r})", R.is_ap_course(c), False)

    print("\n--- 1b. an AP course still gets its ACT standards ---")
    # Dropping the state course of study must not cost an AP course its ACT
    # companion. Josh, 2026-08-06: "AP courses don't need to have ALCOS
    # correlations, but they do need to be able to write lesson plans that also
    # include their respective ACT standards."
    for course, want in [
        ("AP Physics 1", ("S",)), ("AP Chemistry", ("S",)), ("Pre-AP Biology", ("S",)),
        ("AP Calculus AB & BC", ("M",)), ("AP Statistics", ("M",)),
        ("AP_Lang", ("E", "R", "W")), ("AP English Literature and Composition", ("E", "R", "W")),
        ("AP US History", ("R",)), ("AP Psychology", ("R",)),
    ]:
        check(f"act_sections_for({course!r})", R.act_sections_for(course), want)
    # A world language is not an English course, whatever its title says.
    for course in ("AP Spanish Literature and Culture", "AP Spanish Language and Culture",
                   "AP Latin", "AP Japanese Language and Culture", "World_Languages"):
        check(f"act_sections_for({course!r}) is empty", R.act_sections_for(course), ())

    print("\n--- 2. course identity: variants join, real courses stay apart ---")
    for course, must_include in [
        ("AP US History", {"AP US History Key Concepts", "AP United States History",
                           "AP US History Themes 2014-2015"}),
        ("AP Human Geography", {"APHuG", "AP Human Geography 2019 Updated CED Standards"}),
        ("AP Biology", {"AP Biology Big Ideas", "AP Biology Science Practices"}),
        ("AP Seminar", {"AP Seminar Curriculum Framework"}),
        ("AP_Lang", {"AP English Language and Composition"}),
    ]:
        got = set(R.course_variants(course))
        missing = must_include - got
        check(f"course_variants({course!r}) joins its partitions", missing, set())

    # Distinct courses that share a name stem must NOT be merged.
    for a, b in [("AP Physics 1", "AP Physics 2"), ("AP Physics 1", "AP Physics C"),
                 ("Pre-AP Algebra 1", "Pre-AP Algebra 2"),
                 ("AP Microeconomics", "AP Macroeconomics"),
                 ("AP English Literature and Composition", "AP_Lang")]:
        overlap = set(R.course_variants(a)) & set(R.course_variants(b))
        check(f"{a!r} and {b!r} stay separate", overlap, set())

    print("\n--- 3. audit is scoped to the course ---")
    # "2.C" is the fabrication retrieval.py's STRATA comment records. It is not
    # an AP Lang code, but it IS a real AP Spanish one — a corpus-wide check
    # would wave it through.
    check("'2.C' is not an AP_Lang code", "2.C" in R.codes_for_course("AP_Lang"), False)
    check("'2.C' IS an AP Spanish code",
          "2.C" in R.codes_for_course("AP Spanish Language and Culture"), True)
    warned = R.audit_grounding(
        {"days": [{"name": "Mon", "standards": "2.C", "act_alignment": ""}]},
        set(), subject_code="AP_Lang",
    )
    check("audit flags 2.C in an AP Lang plan", bool(warned), True)
    # A variant's codes still count as this course's own.
    check("AP US History owns a Key Concepts code",
          "KC 5.3.I.B" in R.codes_for_course("AP US History"), True)

    print("\n--- 4. a code named in the query retrieves itself ---")
    for course, query, want in [
        ("AP Physics 1", "LO.3.A.3.1", "LO.3.A.3.1"),
        ("Science", "SC23.PHYS.2", "SC23.PHYS.2"),
        ("ELA", "plan week 3 around ELA21.11.24", "ELA21.11.24"),
        ("AP US History", "KC-5.3.I.B", "KC 5.3.I.B"),        # hyphen/space spelling
        ("AP Calculus AB & BC", "CHA-3.E.1", "CHA-3.E.1"),
        ("AP Human Geography", "PSO-2.F.1", "PSO-2.F.1"),
    ]:
        r = R.retrieve_grounded(query, subject_code=course, grade=11)
        got = {R._norm_code(str((c["metadata"] or {}).get("code"))) for c in r.chunks}
        hit = R._norm_code(want) in got or R._norm_code(want).replace("-", " ") in got
        check(f"{course}: {query[:30]!r} retrieves {want}", hit, True)

    print()
    if failures:
        print(f"FAIL — {len(failures)} problem(s):")
        for f in failures:
            print(f"  * {f}")
        return 1
    print("PASS — AP grounding, course identity, scoped audit and code lookup all hold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
