#!/usr/bin/env python3
"""schoolcal: does picking a different school actually change the calendar?

Every schoolcal.* function takes a school_id now (backend/schoolcal.py). This
proves two schools pointed at two different calendar files resolve to two
genuinely different week boards AND two genuinely different LLM prompts — not
just that the parameter exists, but that changing it changes the dates a plan
is built against, in both of the places that matters: the week board, via
schoolcal directly, and generation itself, via backend/prompts.py's
calendar_context() — which used to read settings.calendar_path directly,
independent of schoolcal.py entirely, and would otherwise still describe
Florence's calendar to the model no matter which school a teacher picked.

Uses two tiny fixture calendars in a temp directory, monkeypatched over
settings.calendars_dir for the duration of the test — never a permanent fake
school added to the real repo. Fixture ids (eval-fixture-a/b) are never-seen-
elsewhere strings, so the per-school_id lru_cache can't collide with anything
else that ran in this process.

Run:  ./venv/bin/python eval/test_schoolcal_per_school.py
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import prompts, schoolcal  # noqa: E402
from backend.config import settings  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


FIXTURE_A = """# Fixture A — Global Calendar 2026-2027

| Wk | Mon | Fri | Notes |
|---|---|---|---|
| 1 | Aug 17 | Aug 21 | |
"""

FIXTURE_B = """# Fixture B — Global Calendar 2026-2027

| Wk | Mon | Fri | Notes |
|---|---|---|---|
| 1 | Sep 14 | Sep 18 | Mon Sep 14 = In-service (no school) |
"""


def main() -> int:
    real_calendars_dir = settings.calendars_dir
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        (tmp_dir / "eval-fixture-a.md").write_text(FIXTURE_A, encoding="utf-8")
        (tmp_dir / "eval-fixture-b.md").write_text(FIXTURE_B, encoding="utf-8")
        settings.calendars_dir = tmp_dir
        try:
            print("\n1. Two schools with different calendar files resolve to different weeks")
            weeks_a = schoolcal.school_weeks("eval-fixture-a")
            weeks_b = schoolcal.school_weeks("eval-fixture-b")
            check("fixture A has one week", len(weeks_a) == 1, str(weeks_a))
            check("fixture B has one week", len(weeks_b) == 1, str(weeks_b))
            check("fixture A's Week 1 starts Aug 17", bool(weeks_a) and weeks_a[0]["start"] == "2026-08-17")
            check("fixture B's Week 1 starts Sep 14", bool(weeks_b) and weeks_b[0]["start"] == "2026-09-14")

            print("\n2. Closures are per-school, not shared")
            check("fixture A has no closures", schoolcal.closure_days("eval-fixture-a") == {})
            check(
                "fixture B's In-service day is closed",
                schoolcal.closure_days("eval-fixture-b").get("2026-09-14") == "In-service",
            )

            print("\n3. An unknown school id fails closed, not onto someone else's calendar")
            check("an unregistered school has zero weeks", schoolcal.school_weeks("no-such-school") == [])

            print("\n4. Repeat calls for the same school are cached, not re-parsed")
            check(
                "school_weeks returns the identical cached list on a second call",
                schoolcal.school_weeks("eval-fixture-a") is weeks_a,
            )

            print("\n5. The LLM prompt itself is per-school too (prompts.calendar_context)")
            ctx_a = prompts.calendar_context("eval-fixture-a")
            ctx_b = prompts.calendar_context("eval-fixture-b")
            check("fixture A's prompt text names its own header", "Fixture A" in ctx_a)
            check("fixture B's prompt text names its own header", "Fixture B" in ctx_b)
            check("the two schools' prompt text actually differ", ctx_a != ctx_b)
        finally:
            settings.calendars_dir = real_calendars_dir

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — two schools' calendars resolve independently, in both the board and the prompt.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
