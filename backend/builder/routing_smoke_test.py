#!/usr/bin/env python3
"""Smoke-test lesson-plan save routing after reset, and end-to-end build
integrity (added 2026-08-03 after this test's path checks had been silently
failing since the 2026-07-27 folder split -- a smoke test nobody runs, or
that fails quietly, is worse than no smoke test)."""

import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
PROJECT = ROOT / "Projects" / "Florence High School 2026-2027"
OBSIDIAN = ROOT / "Obsidian" / "JoshuaColePhD" / "Knowledge" / "Agent Outputs" / "lesson-plans"

UNIT_BY_WEEK = {
    range(1, 6): "Unit 1 — Rhetorical Analysis",
    range(6, 10): "Unit 2 — Voice, Tone & Rhetorical Devices",
    range(10, 14): "Unit 3 — Power of Language",
    range(14, 19): "Unit 4 — Line of Reasoning & Evidence",
    range(19, 24): "Unit 5 — The American Dream",
    range(24, 29): "Unit 6 — Community & Conformity",
    range(29, 33): "Unit 7 — Duality, Identity & Sources",
    range(33, 38): "Unit 8 — Voice, Gender & Complexity",
    range(38, 42): "Unit 9 — AP Exam Prep",
}


def ap_lang_folder(week: int) -> Path:
    for weeks, unit in UNIT_BY_WEEK.items():
        if week in weeks:
            # Corrected 2026-08-03: the combined "Lesson Plans & Slides"
            # folder was split into siblings (Lesson Plans/, Lecture Slides/,
            # Lecture Notes/) on 2026-07-27 -- this smoke test still checked
            # the old combined name and had been silently failing on every
            # run since, which is exactly the kind of drift this test exists
            # to catch. Route to Lesson Plans/ specifically.
            return PROJECT / "AP Lang" / unit / "Lesson Plans"
    raise ValueError(f"No AP Lang unit route for week {week}")


def main() -> None:
    checks = {
        "AP Lang Week 03": ap_lang_folder(3),
        "AP Lang Week 10": ap_lang_folder(10),
        "ENG 101": PROJECT / "ENG 101" / "Lesson Plans",
        "ENG 102": PROJECT / "ENG 102" / "Lesson Plans",
        "Obsidian lesson notes": OBSIDIAN,
    }

    missing = []
    for label, path in checks.items():
        print(f"{label}: {path}")
        if not path.exists():
            missing.append((label, path))

    if missing:
        for label, path in missing:
            print(f"MISSING: {label}: {path}")
        raise SystemExit(1)

    print("Routing smoke test passed.")

    # End-to-end build check: generate the example week and run it through
    # the same OOXML validator the skill requires before any real delivery
    # (see SKILL.md Step 4). Catches regressions in build_lesson_plan.py
    # itself, not just folder routing.
    scripts_dir = Path(__file__).resolve().parent
    # validate.py belongs to the anthropic-skills "docx" skill, not this repo
    # -- its install path varies per session/environment (it's typically
    # under ~/Library/Application Support/Claude/... or a plugin cache), so
    # search broadly from $HOME rather than assuming a fixed location.
    validate_py = None
    search_roots = [ROOT, Path.home()]
    for root in search_roots:
        try:
            for candidate in root.glob("**/skills/docx/scripts/office/validate.py"):
                validate_py = candidate
                break
        except (PermissionError, OSError):
            continue
        if validate_py:
            break
    if validate_py is None:
        print("Skipping build/validation check: docx skill's validate.py not found "
              "in this environment. This does NOT mean the build is valid -- run "
              "it manually per SKILL.md Step 4 before delivering any real file.")
        return

    with tempfile.TemporaryDirectory() as tmp:
        out_docx = Path(tmp) / "smoke_test_week.docx"
        subprocess.run(
            [sys.executable, str(scripts_dir / "build_lesson_plan.py"),
             str(scripts_dir / "example-week.json"), str(out_docx)],
            check=True,
        )
        result = subprocess.run(
            [sys.executable, str(validate_py), str(out_docx)],
            capture_output=True, text=True,
            check=False,
        )
        print(result.stdout)
        if result.returncode != 0 or "All validations PASSED" not in result.stdout:
            print(result.stderr)
            print("BUILD/VALIDATION CHECK FAILED.")
            raise SystemExit(1)

    print("Build + OOXML validation check passed.")


if __name__ == "__main__":
    main()
