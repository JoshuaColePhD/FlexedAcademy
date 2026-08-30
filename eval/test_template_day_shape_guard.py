#!/usr/bin/env python3
"""The clarification UI must not ask teachers to choose a template's day count."""
from __future__ import annotations

from backend.llm import sanitize_clarifying_questions


def main() -> int:
    questions = sanitize_clarifying_questions([
        {
            "id": "weekly_shape",
            "text": "What weekly shape would you like?",
            "options": [
                "Five full instructional days",
                "Four lessons plus a quiz/test",
                "Three lessons, review, and assessment",
                "A shorter or modified week",
            ],
        },
        {
            "id": "focus",
            "text": "What should students work with?",
            "options": ["A novel", "A poem"],
        },
    ])
    assert [q["id"] for q in questions] == ["focus"]

    fallback = sanitize_clarifying_questions([{
        "id": "duration",
        "text": "How many days should the plan run?",
        "options": ["1 day", "3 days", "5 days"],
    }])
    assert fallback[0]["id"] == "lesson_focus"
    print("PASSED — day-count clarification questions are removed at the API boundary.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
