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

RETRIEVAL_TEST_CASES = [
    {
        "query": "Students need practice synthesizing graphic texts like charts and dashboards.",
        "expected_code": "Grade11-2",
    },
    {
        "query": "I want a lesson plan on explaining how an argument understands the audience's beliefs.",
        "expected_code": "1.B",
    },
    {"query": "We are focusing on deleting irrelevant material in an essay.", "expected_code": "TOD 201"},
    {
        "query": "I need a lesson about evaluating tone and credibility through active listening.",
        "expected_code": "Grade11-10",
    },
]

# Real teacher phrasings that must always retrieve something. The SPACE CAT one
# is here deliberately: it sits at distance ~0.71 because proper nouns and
# internal framework names don't appear in standards text, so a plausible-looking
# 0.70 floor would break Josh's most natural way of asking.
FLOOR_POSITIVES = [
    "Week 3 SPACE CAT analysis of Letter from Birmingham Jail",
    "rhetorical analysis of a speech",
    "students need help with line of reasoning and evidence",
    "timed synthesis essay from six sources",
    "comma splices and subordination in student drafts",
    *[c["query"] for c in RETRIEVAL_TEST_CASES],
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


def run_retrieval_evals(top_k: int = 5) -> bool:
    _hdr(f"RETRIEVAL — expected code within top {top_k}")
    passed = 0
    for i, case in enumerate(RETRIEVAL_TEST_CASES, 1):
        codes = [c["id"] for c in retrieval.retrieve_raw(case["query"], n=top_k)]
        ok = case["expected_code"] in codes
        passed += ok
        print(f"[{i}/{len(RETRIEVAL_TEST_CASES)}] {'PASS' if ok else 'FAIL'}  {case['expected_code']}")
        if not ok:
            print(f"        query: {case['query']}")
            print(f"        got:   {codes}")
    print(f"\nRecall@{top_k}: {passed}/{len(RETRIEVAL_TEST_CASES)}")
    return passed == len(RETRIEVAL_TEST_CASES)


def run_floor_evals() -> bool:
    _hdr(f"RELEVANCE FLOOR — {settings.retrieval_max_distance}")
    ok = True

    for q in FLOOR_POSITIVES:
        r = retrieval.retrieve_grounded(q)
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
        result = service.prepare(query)
        print(f"  retrieved: {sorted(result.codes)}")
        plan, warnings = schema.validate_plan(llm.generate_plan(query, result))
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
