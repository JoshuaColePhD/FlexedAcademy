#!/usr/bin/env python3
"""Smoke-test lesson-plan save routing after reset."""

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
            return PROJECT / "AP Lang" / unit / "Lesson Plans & Slides"
    raise ValueError(f"No AP Lang unit route for week {week}")


def main() -> None:
    checks = {
        "AP Lang Week 03": ap_lang_folder(3),
        "AP Lang Week 10": ap_lang_folder(10),
        "ENG 101": PROJECT / "ENG 101" / "Lesson Plans & Lecture Slides",
        "ENG 102": PROJECT / "ENG 102" / "Lesson Plans & Lecture Slides",
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


if __name__ == "__main__":
    main()
