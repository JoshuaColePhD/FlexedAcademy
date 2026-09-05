"""Run every eval suite. One command, one exit code.

    ./venv/bin/python eval/run_all.py
    ./venv/bin/python eval/run_all.py --fast     # skip the slow live-corpus sweeps

Needs DATABASE_URL and OPENAI_API_KEY (embeddings only — nothing here calls a
chat model, so a full run costs a fraction of a cent). --fast runs only the
suites that need neither.
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
PY = sys.executable

# (script, needs_corpus) — needs_corpus means it queries the live DB + embeddings.
SUITES: list[tuple[str, bool]] = [
    ("test_alabama_ingest_quality.py", False),
    ("test_alabama_parity_diff.py", False),
    ("test_golden_corpus_alignment.py", False),
    ("test_current_golden_recall.py", True),
    ("test_embedding_cache.py", False),
    ("test_retrieval_reranker.py", False),
    ("test_feedback_contract.py", False),
    ("test_grounding_audit.py", False),
    ("test_generation_context_and_variety.py", False),
    ("test_template_day_shape_guard.py", False),
    ("test_field_scoped_revise.py", False),
    ("test_entitlement.py", False),
    # Lives in backend/builder/ (it's a regression test on generic_renderer.py,
    # not an eval), not eval/ — this SUITES list is where every no-DB/no-API
    # backend check gets one shared runner and one CI step, so it's referenced
    # here by relative path rather than duplicated or moved. No DB, no API:
    # it's pure python-docx rendering compared against build_lesson_plan.py's
    # own output.
    ("../backend/builder/test_generic_renderer.py", False),
    # Needs the live DB (no test double exists for it), so --fast skips it.
    ("test_security_contracts.py", True),
    # These four each stub SOME of the db.* calls their own code path makes
    # (per their own docstrings, "no DB, no OpenAI call"), but not all of
    # them — e.g. test_quiz_generation.py stubs llm.db.get_llm_cache but not
    # the db.get_user_by_id a few frames deeper in the same call
    # (custom_instructions_for), and test_schoolcal_per_school.py never
    # stubs db.get_confirmed_calendar_submission at all. That's invisible
    # against a real local dev DATABASE_URL (the unstubbed call just
    # succeeds against whatever's really there) but breaks outright with no
    # DATABASE_URL at all — confirmed 2026-08-26 by running with .env moved
    # aside, matching CI's actual environment, and again by CI itself
    # failing this exact way the first time this step was wired in. Marked
    # True until each is given the same complete-stub treatment
    # test_entitlement.py's own db.get_app_settings gap already got.
    ("test_chat_pacing_guide.py", True),
    ("test_chat_week_context.py", True),
    ("test_schoolcal_per_school.py", True),
    ("test_quiz_generation.py", True),
    ("test_course_identity_and_codes.py", True),
    ("test_cross_course_grounding.py", True),
    ("test_offdomain_refusal.py", True),
    # Retired as a release gate: its 143 historical cases intentionally
    # include codes removed or renamed by the current AP corpus. The current
    # canonical gate above is the release signal; run this file manually as a
    # drift diagnostic when investigating historical changes.
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fast", action="store_true",
                    help="run only the suites that need no database or API")
    args = ap.parse_args()

    suites = [s for s, needs in SUITES if not (args.fast and needs)]
    results: list[tuple[str, bool, float]] = []

    for name in suites:
        print(f"\n{'=' * 78}\n{name}\n{'=' * 78}")
        started = time.monotonic()
        proc = subprocess.run([PY, str(HERE / name)], cwd=HERE.parent, check=False)
        results.append((name, proc.returncode == 0, time.monotonic() - started))

    print(f"\n{'=' * 78}\nSUMMARY\n{'=' * 78}")
    for name, ok, secs in results:
        print(f"  {'PASS' if ok else 'FAIL'}  {name:40} {secs:6.1f}s")
    skipped = len(SUITES) - len(suites)
    if skipped:
        print(f"  ....  {skipped} suite(s) skipped (--fast)")

    failed = [n for n, ok, _ in results if not ok]
    print()
    if failed:
        print(f"FAIL — {len(failed)} suite(s): {', '.join(failed)}")
        return 1
    print(f"PASS — all {len(results)} suite(s) green.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
