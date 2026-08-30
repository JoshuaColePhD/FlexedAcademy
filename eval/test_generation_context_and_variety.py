#!/usr/bin/env python3
"""Regression checks for class-scoped generation and standard variety.

No database or OpenAI call: the class/settings lookups, map lookup, and
completion function are stubbed so this checks the prompt that would actually
reach the model.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, llm  # noqa: E402
from backend.retrieval import RetrievalResult  # noqa: E402


def main() -> int:
    captured: dict[str, object] = {}
    originals = (
        db.get_class,
        db.get_settings_row,
        llm.map_context_for,
        llm._cached_completion,
        llm.output_length_for,
        llm.custom_instructions_for,
    )

    db.get_class = lambda _uid, class_id: (
        {"id": class_id, "subject": "Biology", "grade": "7"}
        if class_id == "biology-7"
        else None
    )
    db.get_settings_row = lambda _uid: {
        "subject": "AP Language & Composition",
        "grade": "11",
    }
    llm.map_context_for = lambda user_id, subject, query, *, class_id=None: captured.update(
        map_args=(user_id, subject, query, class_id)
    ) or ""
    llm.output_length_for = lambda _uid: "medium"
    llm.custom_instructions_for = lambda _uid: None

    def fake_completion(user_id: str, kind: str, **kwargs):
        captured[kind] = kwargs
        if kind == "generate_plan":
            return '{"days": []}'
        return '{"during": "Lab discussion"}'

    llm._cached_completion = fake_completion

    result = RetrievalResult(
        chunks=[
            {
                "id": "biology:7:LS.1",
                "document": "Analyze cell structure.",
                "distance": 0.20,
                "metadata": {"code": "LS.1", "source_type": "state_course_of_study"},
            },
            {
                "id": "biology:7:LS.2",
                "document": "Explain cell processes.",
                "distance": 0.25,
                "metadata": {"code": "LS.2", "source_type": "state_course_of_study"},
            },
        ],
        floor=0.78,
    )

    try:
        llm.generate_plan("u1", "cells", result, school_id="school", class_id="biology-7")
        generate_kwargs = captured["generate_plan"]
        generate_prompt = generate_kwargs["messages"][0]["content"]
        assert captured["map_args"] == ("u1", "Biology", "cells", "biology-7")
        assert "Biology" in generate_prompt and "Grade 7" in generate_prompt
        assert "AP Language & Composition" not in generate_prompt
        assert "every relevant available primary standard has been used once" in generate_prompt

        llm.rewrite_day_field(
            "u1",
            {"name": "Monday", "during": "Read the text."},
            "make it collaborative",
            "during",
            "{\"days\": []}",
            result,
            class_id="biology-7",
        )
        field_kwargs = captured["rewrite_day_field"]
        field_prompt = field_kwargs["messages"][0]["content"]
        assert "Biology" in field_prompt and "Grade 7" in field_prompt
        assert "AP Language & Composition" not in field_prompt
    finally:
        (
            db.get_class,
            db.get_settings_row,
            llm.map_context_for,
            llm._cached_completion,
            llm.output_length_for,
            llm.custom_instructions_for,
        ) = originals

    print("PASSED — generation and revision prompts stay on the selected class and rotate standards.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
