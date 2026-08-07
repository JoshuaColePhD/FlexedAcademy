#!/usr/bin/env python3
"""Step 5 — Eval harness.

Four suites. The first three need no API key; only generation calls OpenAI, so
`--offline` gives you a full correctness check for free:

  retrieval — do known queries surface their expected standard within top_k
  floor     — does the relevance floor keep real queries and reject off-domain
  docx      — does the canonical builder still emit the district document
  generation— does a live model response validate against backend/schema.py

The docx suite is the one that matters most historically: the app spent its
first day emitting v1-shaped plans through a forked builder while the district
template had moved to v2, and no test looked at the actual .docx. This one does,
and it needs no key.

The old generation eval asserted `"curriculum" in day1`. That key exists in
neither v1's nor v2's ROWS — it was copied from the retired v1 docstring (the
same phantom key that broke v1's No School gate). Replaced with the real
validator so the eval and the server can never disagree about what valid means.

Usage:
    python scripts/05_eval_harness.py            # everything
    python scripts/05_eval_harness.py --offline  # skip generation
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import zipfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

from backend import docx_build, retrieval, schema  # noqa: E402
from backend.config import settings  # noqa: E402

# Hand-written cases, kept alongside the generated golden set rather than
# replaced by it — see the loader below.
#
# Two AP Lang cases were retired on 2026-08-06: they expected Grade11-2 and
# Grade11-10, Alabama course-of-study codes. AP courses ground in AP skills only
# now, so no ALCOS code is reachable from AP_Lang by design. See
# eval/retired_cases.json.
RETRIEVAL_TEST_CASES = [
    {
        "course": "AP_Lang",
        "grade": 11,
        "query": "I want a lesson plan on explaining how an argument understands the audience's beliefs.",
        "expected_code": "1.B",
    },
    {
        "course": "AP_Lang",
        "grade": 11,
        "query": "We are focusing on deleting irrelevant material in an essay.",
        "expected_code": "TOD 201"
    },
    {
        "course": "AP Biology",
        "grade": 11,
        "query": "How species diversity within an ecosystem influences ecosystem stability.",
        "expected_code": "LO 4.27",
    },
    {
        "course": "AP Biology",
        "grade": 11,
        "query": "predict effects of variation within populations on survival and fitness.",
        "expected_code": "LO 4.26",
    },
]

# Load the generated golden dataset ALONGSIDE the hand-written cases above.
#
# This used to assign over RETRIEVAL_TEST_CASES rather than extend it, so from
# the moment data/eval/golden_cases.json first existed every hand-written case
# above stopped running — silently, since the count printed was the golden set's
# and looked like more coverage rather than less.
GOLDEN_DATASET_PATH = PROJECT_ROOT / "data" / "eval" / "golden_cases.json"
if GOLDEN_DATASET_PATH.is_file():
    try:
        with open(GOLDEN_DATASET_PATH, "r", encoding="utf-8") as f:
            golden = json.load(f)
        RETRIEVAL_TEST_CASES = RETRIEVAL_TEST_CASES + golden
        print(f"Loaded {len(golden)} golden cases from {GOLDEN_DATASET_PATH.name} "
              f"(+{len(RETRIEVAL_TEST_CASES) - len(golden)} hand-written)")
    except Exception as e:
        print(f"Failed to load golden cases: {e}")

# Real teacher phrasings that must always retrieve something. The SPACE CAT one
# is here deliberately: it sits at distance ~0.71 because proper nouns and
# internal framework names don't appear in standards text, so a plausible-looking
# 0.70 floor would break Josh's most natural way of asking.
FLOOR_POSITIVES = [
    ("AP_Lang", "Week 3 SPACE CAT analysis of Letter from Birmingham Jail"),
    ("AP_Lang", "rhetorical analysis of a speech"),
    ("AP_Lang", "students need help with line of reasoning and evidence"),
    ("AP_Lang", "timed synthesis essay from six sources"),
    ("AP_Lang", "comma splices and subordination in student drafts"),
    *[ (c["course"], c["query"]) for c in RETRIEVAL_TEST_CASES ],
]

FLOOR_NEGATIVES_OFFDOMAIN = [
    "balancing chemical equations in stoichiometry",
    "solve quadratic equations by factoring",
    "pizza recipe with sourdough crust",
    "asdf qwerty zxcv",
]

# These pass the floor by design — documented, not a failure. See retrieval.py.
FLOOR_NEGATIVES_KNOWN_GAP = [
    "Unit 8 skills on style and complexity",
    "ACT Reading CLR 501 close reading standard",
]

EXAMPLE_WEEK = Path(settings.builder_path).parent / "example-week.json"


def _hdr(title: str) -> None:
    print("\n" + "=" * 78)
    print(title)
    print("=" * 78)


# Every case above is an AP Lang, Grade 11 question, so the eval must search the
# way production searches — retrieve_grounded() always filters on the selected
# course and grade (see backend/service.py). This used to call retrieve_raw with
# no filter, which was indistinguishable from the real thing while the store held
# one course. Once the Alabama Course of Study frameworks went in (20,773 chunks
# across 12 frameworks), the unscoped query started returning Arts Education and
# Grade-3 ELA chunks and the eval failed on a corpus that production handles
# correctly. Scoping here keeps the eval a test of retrieval quality rather than
# of how many other subjects happen to be loaded.
EVAL_SCOPE = {"course": "AP_Lang", "grade": 11}


# Scoping used to be a Chroma `where` dict. Retrieval moved to pgvector, where
# course/grade are explicit arguments, and this file was not updated — so the
# harness has been raising TypeError since that rewrite rather than reporting a
# recall number.


# Recall required for a pass, rather than "every case must pass".
#
# Six cases are genuinely unwinnable and demanding 147/147 would mean either
# deleting them or living with a permanently red suite, which is the same as
# having no suite. They are printed every run, never hidden:
#
#   AP_Lang: 1.B ................ rank 4 of 22 WITHIN ap_skills, and only the
#                                 best of each stratum is force-included. The
#                                 AP Lang CED (reachable since 2026-08-06)
#                                 outranks it on a rhetoric query.
#   PE: PE19.BK2.2.2.APE ........ siblings differ by one character (BK1/BK2)
#   APHuG: V .................... the expected "code" is a bare roman numeral
#   AP Human Geography...: 5 .... bare numeric code, no distinguishing text
#   AP Chinese: 7D .............. siblings 7A / 7A1 / 7D1
#   AP Seminar Curricular Requirements: CR 1 .. competes with all three AP
#                                 Seminar partitions since course_variants()
#                                 reunited them
#
# Raise this when retrieval genuinely improves; never lower it to go green.
MIN_RECALL = 141


def run_retrieval_evals(top_k: int = 5) -> bool:
    _hdr(f"RETRIEVAL — expected code within top {top_k} (Multi-Subject)")
    passed = 0
    for i, case in enumerate(RETRIEVAL_TEST_CASES, 1):
        hits = retrieval.retrieve_raw(
            case["query"], n=top_k, course=case["course"], grade=case["grade"]
        )
        # The standard's own code, not the chunk id. Ids are
        # `{course}:{grade}:{code}` so one standard can be stored once per grade
        # it covers; comparing ids here would fail every case for a formatting
        # reason rather than a retrieval one.
        codes = [(c.get("metadata") or {}).get("code") or c["id"] for c in hits]
        ok = case["expected_code"] in codes
        via = "flat"

        # A flat top-k is NOT how production searches. retrieve_grounded() runs
        # one search per source type and force-includes the best of each, so a
        # standard can be handed to the model while sitting well below rank 5 in
        # a single ranking — AP Lang's skill 1.B is rank 30 flat and rank 4
        # within ap_skills, because the AP Lang CED now competes with it. Asking
        # only the flat question reported a failure for a standard the teacher
        # actually receives. Ask the real question before calling it a miss.
        #
        # (The flat ranking is still measured, with a recorded baseline, by
        #  eval/test_golden_recall.py. The two are complementary: that one
        #  guards retrieval quality, this one guards what the teacher gets.)
        if not ok:
            grounded = retrieval.retrieve_grounded(
                case["query"], subject_code=case["course"], grade=case["grade"]
            )
            gcodes = [str((c.get("metadata") or {}).get("code") or c["id"]) for c in grounded.chunks]
            if case["expected_code"] in gcodes:
                ok, via, codes = True, "stratified", gcodes

        passed += ok
        label = "PASS" if ok else "FAIL"
        suffix = f"  (via {via})" if ok and via != "flat" else ""
        print(f"[{i}/{len(RETRIEVAL_TEST_CASES)}] {label}  {case['course']}: {case['expected_code']}{suffix}")
        if not ok:
            print(f"        query: {case['query']}")
            print(f"        got:   {codes}")
    total = len(RETRIEVAL_TEST_CASES)
    print(f"\nRecall@{top_k}: {passed}/{total}  (floor for a pass: {MIN_RECALL})")
    if passed < MIN_RECALL:
        print(f"FAIL — recall fell below {MIN_RECALL}.")
    return passed >= MIN_RECALL


def run_floor_evals() -> bool:
    _hdr(f"RELEVANCE FLOOR — {settings.retrieval_max_distance}")
    ok = True

    for course, q in FLOOR_POSITIVES:
        r = retrieval.retrieve_grounded(q, subject_code=course, grade=11)
        good = not r.empty
        ok &= good
        best = r.chunks[0]["distance"] if r.chunks else float("nan")
        print(f"  {'PASS' if good else 'FAIL'}  kept={len(r.chunks)} best={best:.3f}  {q[:52]}")

    print()
    for q in FLOOR_NEGATIVES_OFFDOMAIN:
        r = retrieval.retrieve_grounded(q)
        good = r.empty
        ok &= good
        near = r.rejected[0]["distance"] if r.rejected else float("nan")
        print(f"  {'PASS' if good else 'FAIL'}  rejected, nearest={near:.3f}  {q[:52]}")

    print("\n  Known-gap queries (expected to pass the floor — prompt rules and the")
    print("  grounding audit are what catch these; see retrieval.py):")
    for q in FLOOR_NEGATIVES_KNOWN_GAP:
        r = retrieval.retrieve_grounded(q)
        best = r.chunks[0]["distance"] if r.chunks else float("nan")
        print(f"    kept={len(r.chunks)} best={best:.3f}  {q[:52]}")

    return ok


def run_docx_evals() -> bool:
    """Assert on the actual bytes the district gets. No API key needed."""
    _hdr("DOCX CONTRACT — canonical florence-docx-v2 builder")
    if not EXAMPLE_WEEK.is_file():
        print(f"FAIL  example week not found at {EXAMPLE_WEEK}")
        return False

    template = docx_build.builder_template()
    print(f"  builder: {settings.builder_path}")
    print(f"  template: {template}")
    if template != "florence-docx-v2":
        print("FAIL  builder is not the v2 template")
        return False

    raw = json.loads(EXAMPLE_WEEK.read_text(encoding="utf-8"))
    plan, warnings = schema.validate_plan(raw)
    plan = schema.with_identity(
        plan, teacher="Eval Teacher", course="AP Language & Composition", period="1st period"
    )
    # Flag Monday off so the No School path is actually exercised.
    plan["days"] = [{"name": "Monday", "no_school": True}] + plan["days"][1:]

    import tempfile

    out = Path(tempfile.mkdtemp()) / "eval.docx"
    docx_build.build_docx(plan, out)

    size = out.stat().st_size
    xml = zipfile.ZipFile(out).read("word/document.xml").decode("utf-8")
    rows = xml.count("<w:tr>")
    first_row_cells = len(re.findall(r"<w:tc>", xml.split("</w:tr>")[0]))

    checks = [
        ("opens as a zip with word/document.xml", True),
        ("7 table rows", rows == 7),
        ("landscape page setup", 'w:orient="landscape"' in xml),
        ("'No School' stamped for the flagged day", "No School" in xml),
        ("engagement dropdown control present", "dropDownList" in xml),
        (f"stripped to <15KB (got {size:,}B)", size < 15_000),
        ("teacher identity injected", "Eval Teacher" in xml),
    ]
    ok = True
    for label, passed in checks:
        ok &= passed
        print(f"  {'PASS' if passed else 'FAIL'}  {label}")
    print(f"  (rows={rows}, first-row cells={first_row_cells}, warnings={len(warnings)})")
    out.unlink(missing_ok=True)
    return ok


def run_generation_evals() -> bool:
    _hdr("GENERATION — live model output must satisfy validate_plan()")
    if not settings.has_api_key:
        print("SKIP  OPENAI_API_KEY not set")
        return True

    from backend import llm, service

    query = "Draft a Week 3 lesson plan on using transition words and line of reasoning in essays."
    print(f"  query: {query}")
    try:
        result = service.prepare("default_user", query)
        print(f"  retrieved: {sorted(result.codes)}")
        plan, warnings = schema.validate_plan(llm.generate_plan("default_user", query, result))
        print(f"  PASS  {len(plan['days'])} days, {len(warnings)} schema warning(s)")
        audit = retrieval.audit_grounding(plan, result.codes)
        for w in audit:
            print(f"        grounding warning: {w}")
        return True
    except schema.SchemaError as e:
        print(f"  FAIL  schema violation [{e.code}] {e.message} (at {e.path})")
        return False
    except Exception as e:  # noqa: BLE001
        print(f"  FAIL  {type(e).__name__}: {e}")
        return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="skip the suite that calls OpenAI")
    args = ap.parse_args()

    results = {
        "retrieval": run_retrieval_evals(),
        "floor": run_floor_evals(),
        "docx": run_docx_evals(),
    }
    if not args.offline:
        results["generation"] = run_generation_evals()

    _hdr("SUMMARY")
    for name, ok in results.items():
        print(f"  {name:12s} {'PASS' if ok else 'FAIL'}")
    return 0 if all(results.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
