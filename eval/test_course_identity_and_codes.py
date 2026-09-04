#!/usr/bin/env python3
"""Course identity, AP grounding policy, and exact-code lookup.

Covers the four fixes made 2026-08-06 after the cross-subject ACT bug:

  1. An AP course grounds in AP skills, not the state course of study.
     Josh's rule: "If it's an AP class, I don't need regular standards."
  2. One course filed under several `course` values is ONE course.
  3. audit_grounding checks a code against THIS course, not the whole corpus.
  4. A code named in the query retrieves itself.

Run:  ./venv/bin/python eval/test_course_identity_and_codes.py
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
        # Both are taught as close reading of sources and argument from them,
        # which is what the ACT Reading section tests.
        ("AP Seminar", ("R",)), ("AP Research", ("R",)),
        ("AP Seminar Curriculum Framework", ("R",)),
    ]:
        check(f"act_sections_for({course!r})", R.act_sections_for(course), want)
    # A world language is not an English course, whatever its title says.
    for course in ("AP Spanish Literature and Culture", "AP Spanish Language and Culture",
                   "AP Latin", "AP Japanese Language and Culture", "World_Languages"):
        check(f"act_sections_for({course!r}) is empty", R.act_sections_for(course), ())

    print("\n--- 2. course identity: variants join, real courses stay apart ---")
    # As of 2026-08-22 the whole AP/college_board corpus was re-ingested by
    # scripts/01c_ingest_ap_ceds.py directly from official College Board CED
    # PDFs, one PDF -> one canonical course name via an explicit lookup table
    # (_FILENAME_TO_COURSE in that script). That eliminates the entire class
    # of bug this section used to guard against: a course's content used to
    # arrive scattered across several oddly-named raw `course` values (the
    # Common Standards Project import's "APHuG", "Advanced English",
    # "AP Biology Big Ideas", "AP Calculus Skills Standards", a separate
    # "AP US Government and Politics" foundational-documents file, etc.) that
    # backend/retrieval.py's _COURSE_ALIASES/_SHARED_VARIANTS had to stitch
    # back together after the fact. None of those raw values exist anymore —
    # each course's skills/practices/foundational-documents content is simply
    # part of that one course's own CED chunks now (confirmed: AP US
    # Government & Politics's own chunks include the Federalist Papers and
    # Anti-Federalist material directly; AP Physics 1 and AP US History each
    # carry their own Science Practices / historical-thinking Skill codes
    # inline, with no separate "AP Physics 1/2" or "AP Historical Thinking
    # Skills" document needed). The old aliases stay in retrieval.py in case
    # a future ingest ever reintroduces a split like this, but nothing in the
    # current corpus should need them.
    for course, must_equal in [
        # The new ingest genuinely produces this as its own raw course value
        # (from ap-english-language-and-composition-...pdf) and relies on the
        # "ap english language and composition" -> "ap lang" alias to join it.
        ("AP_Lang", {"AP_Lang", "AP English Language and Composition"}),
        ("AP English Literature and Composition", {"AP English Literature and Composition"}),
        ("AP US History", {"AP US History"}),
        ("AP Human Geography", {"AP Human Geography"}),
        ("AP Biology", {"AP Biology"}),
        ("AP Seminar", {"AP Seminar"}),
        ("AP Environmental Science", {"AP Environmental Science"}),
        ("AP Calculus AB & BC", {"AP Calculus AB & BC"}),
        ("AP US Government & Politics", {"AP US Government & Politics"}),
        ("AP World History", {"AP World History"}),
        ("AP European History", {"AP European History"}),
        ("AP Physics 1", {"AP Physics 1"}),
        ("AP Physics 2", {"AP Physics 2"}),
    ]:
        check(f"course_variants({course!r}) is just itself now (single-PDF ingest)",
              set(R.course_variants(course)), must_equal)

    # Distinct courses must never be merged.
    for a, b in [
        ("AP Physics 1", "AP Physics 2"), ("AP Physics 1", "AP Physics C"),
        ("Pre-AP Algebra 1", "Pre-AP Algebra 2"),
        ("AP Microeconomics", "AP Macroeconomics"),
        ("AP English Literature and Composition", "AP_Lang"),
        ("AP US History", "AP World History"), ("AP US History", "AP European History"),
        ("AP World History", "AP European History"),
    ]:
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
        {"days": [{"name": "Mon", "standards": "2.C", "act_alignment": "R.WME.301"}]},
        set(), subject_code="AP_Lang",
    )
    check("audit flags 2.C in an AP Lang plan", bool(warned), True)
    # The 2026-08-22 CED re-ingest spells Key Concept codes with a hyphen
    # ("KC-1.1.I.B"), matching the official CED's own formatting. It's also an
    # independent extraction pass from a different source pipeline, so it
    # doesn't reproduce the exact same sub-codes the old CSP import happened
    # to have (that import's "KC 5.3.I.B" specifically isn't present here) —
    # this checks a code confirmed to actually exist in the current corpus.
    check("AP US History owns a Key Concept code",
          "KC-1.1.I.B" in R.codes_for_course("AP US History"), True)

    print("\n--- 4. a code named in the query retrieves itself ---")
    for course, query, want in [
        # Real codes confirmed present in the 2026-08-22 CED re-ingest — the
        # old CSP-import codes these used to check (LO.3.A.3.1, CHA-3.E.1,
        # PSO-2.F.1) don't exist in this independently-extracted corpus.
        ("AP Physics 1", "1.1.A.2", "1.1.A.2"),
        ("Science", "SC23.PHYS.2", "SC23.PHYS.2"),
        ("ELA", "plan week 3 around ELA21.11.24", "ELA21.11.24"),
        ("AP US History", "KC-1.1.I.B", "KC-1.1.I.B"),
        ("AP Calculus AB & BC", "CHA-1.A.2", "CHA-1.A.2"),
        ("AP Human Geography", "IMP-1.A.3", "IMP-1.A.3"),
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
