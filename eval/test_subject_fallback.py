#!/usr/bin/env python3
"""Empty subject must not silently become AP_Lang.

The old subject_code('') fallback retrieved AP Language standards for any
class whose subject was blank. Chat and generate should refuse instead.

Run:  ./venv/bin/python eval/test_subject_fallback.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.errors import AppError  # noqa: E402
from backend.service import require_subject_grade, subject_code  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def main() -> int:
    print("\n1. subject_code does not invent AP_Lang")
    check("empty string stays empty", subject_code("") == "")
    check("whitespace stays empty", subject_code("   ") == "")
    check("named AP_Lang still resolves", subject_code("AP_Lang") == "AP_Lang")
    check("display name still aliases", subject_code("AP Language & Composition") == "AP_Lang")

    print("\n2. require_subject_grade refuses a class with no subject")

    class FakeDb:
        @staticmethod
        def get_settings_row(user_id):
            return {"subject": "AP Language & Composition", "grade": "11"}

    import backend.service as service

    previous = service.db
    service.db = FakeDb()
    try:
        try:
            require_subject_grade("u1", {"subject": "", "grade": "10"})
            check("empty class subject raises", False)
        except AppError as e:
            check("empty class subject raises subject_required", e.code == "subject_required")
        code, grade = require_subject_grade("u1", None)
        check("class-less chat still uses settings", code == "AP_Lang" and grade == 11)
    finally:
        service.db = previous

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — empty subject does not silently become AP Language.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
