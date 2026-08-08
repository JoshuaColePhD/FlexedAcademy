#!/usr/bin/env python3
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
    ("test_grounding_audit.py", False),
    ("test_field_scoped_revise.py", False),
    ("test_entitlement.py", False),
    ("test_course_identity_and_codes.py", True),
    ("test_cross_course_grounding.py", True),
    ("test_offdomain_refusal.py", True),
    ("test_golden_recall.py", True),
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
        proc = subprocess.run([PY, str(HERE / name)], cwd=HERE.parent)
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
