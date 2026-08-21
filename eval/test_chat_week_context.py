#!/usr/bin/env python3
"""chat_stream: does the brainstorming model know which week and unit a new
chat is for?

ChatPage already resolves effectiveWeek client-side (the ?week= override, or
else the next unplanned week) and even says it aloud in the empty chat's own
greeting — "I'll build Week 03 (Aug 17-21)." But chatStream.start() never sent
it to /api/chat_stream, so the conversational model behind that exact greeting
had no idea, and its own "ask rather than build" rule could ask the teacher
which week it was for right after the UI had just told them.

This locks in two things:

1. week_number, once sent, is resolved against the REAL school calendar
   (schoolcal.school_weeks() — the same source generate_stream's _with_week
   already trusts) and named in the system prompt, never guessed. A number
   that doesn't match a real week, or no number at all, adds nothing.
2. The resolved week is cross-referenced against the teacher's OWN uploaded
   pacing guide (curriculum.unit_for_calendar_week) to also name the UNIT —
   separate from units.unit_for_week()'s hardcoded AP-Lang-only map, which
   is for labeling an already-built plan, not for telling this model what a
   subject with no hardcoded map is covering.

No DB, no OpenAI call — db.get_settings_row, db.list_curriculum_progress,
llm.map_context_for, llm.custom_instructions_for, and llm.stream_chat are
stubbed so the assertion is about the system prompt routes/generate.py
builds. schoolcal itself is real: it just reads the actual calendar file, the
same way production does.

Run:  ./venv/bin/python eval/test_chat_week_context.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import curriculum, db, llm, schoolcal  # noqa: E402
from backend.deps import get_current_user  # noqa: E402
from backend.server import app  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def main() -> int:
    captured: dict[str, object] = {}
    state = {"subject": "AP Language & Composition"}

    real_settings, real_map_context, real_custom, real_stream_chat, real_list_progress = (
        db.get_settings_row,
        llm.map_context_for,
        llm.custom_instructions_for,
        llm.stream_chat,
        db.list_curriculum_progress,
    )
    db.get_settings_row = lambda _uid: {"subject": state["subject"], "grade": "11"}
    llm.map_context_for = lambda user_id, subject, query, *, class_id=None: ""
    llm.custom_instructions_for = lambda _uid: None
    # Only "AP Language & Composition" has a matching progress row — the
    # switch to "Biology" in section 2 below exercises the no-match path
    # without needing a second real curriculum map.
    db.list_curriculum_progress = lambda _uid, subject: (
        [{"week_label": "Week 3", "unit": "Unit 2 — Voice and Tone", "target_start": "", "target_end": ""}]
        if subject == "AP Language & Composition"
        else []
    )

    def fake_stream_chat(user_id, messages, *, voice=False):
        captured["system_prompt"] = messages[0]["content"]
        yield {"chunk": "ok"}
        yield {"done": True}

    llm.stream_chat = fake_stream_chat
    app.dependency_overrides[get_current_user] = lambda: "u1"

    real_week = next(w for w in schoolcal.school_weeks("florence-high-school") if w["week"] == 3)

    try:
        client = TestClient(app)

        print("\n1. A new chat with a resolved week that matches the pacing guide's own unit")
        captured.clear()
        client.post(
            "/api/chat_stream",
            json={"week_number": 3, "messages": [{"role": "user", "content": "let's get started"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        check("names the real calendar week", schoolcal.label_for(real_week) in prompt)
        check("names the pacing guide's own unit for that week", "Unit 2 — Voice and Tone" in prompt)
        check("tells the model to treat week AND unit as settled", "week and unit" in prompt)
        check(
            "the ask-rather-than-build rule acknowledges it may already be answered",
            "don't ask about it again unless the teacher's own message clearly points at a different" in prompt,
        )

        print("\n2. A resolved week with no matching row in the teacher's own pacing guide")
        captured.clear()
        state["subject"] = "Biology"
        client.post(
            "/api/chat_stream",
            json={"week_number": 3, "messages": [{"role": "user", "content": "let's get started"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        state["subject"] = "AP Language & Composition"
        check("still names the calendar week", schoolcal.label_for(real_week) in prompt)
        check("never fabricates a unit with nothing to source it from", "pacing guide names as" not in prompt)
        check("settles only the week, not the unit, when there's no unit to report", "Treat the week as already settled" in prompt)

        print("\n3. No week_number at all (calendar not loaded, or every week already planned)")
        captured.clear()
        client.post(
            "/api/chat_stream",
            json={"messages": [{"role": "user", "content": "let's get started"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        check("names no week when none was resolved", "CURRENTLY WORKING ON" not in prompt)

        print("\n4. A week_number that doesn't match any real calendar week")
        captured.clear()
        client.post(
            "/api/chat_stream",
            json={"week_number": 999, "messages": [{"role": "user", "content": "let's get started"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        check("silently skips an out-of-range week rather than guessing", "CURRENTLY WORKING ON" not in prompt)
    finally:
        db.get_settings_row = real_settings
        llm.map_context_for = real_map_context
        llm.custom_instructions_for = real_custom
        llm.stream_chat = real_stream_chat
        db.list_curriculum_progress = real_list_progress
        app.dependency_overrides.pop(get_current_user, None)

    print("\n5. curriculum.unit_for_calendar_week's two matching strategies, directly")
    real_list_progress2 = db.list_curriculum_progress
    try:
        db.list_curriculum_progress = lambda _uid, subject: [
            {"week_label": "Week 3", "unit": "Unit 2 — Voice and Tone", "target_start": "", "target_end": ""}
        ]
        hit = curriculum.unit_for_calendar_week("u1", "AP Language & Composition", real_week)
        check("matches by parsed week NUMBER", bool(hit) and hit["unit"] == "Unit 2 — Voice and Tone")

        db.list_curriculum_progress = lambda _uid, subject: [
            {
                # No "Week N" for units.week_number to find — this is the shape
                # parse_curriculum_progress emits for a document organized by
                # unit rather than by week.
                "week_label": "Unit 2: Voice and Tone",
                "unit": "Unit 2 — Voice and Tone",
                "target_start": real_week["start"],
                "target_end": real_week["end"],
            }
        ]
        hit = curriculum.unit_for_calendar_week("u1", "AP Language & Composition", real_week)
        check("falls back to matching by DATE OVERLAP", bool(hit) and hit["unit"] == "Unit 2 — Voice and Tone")

        db.list_curriculum_progress = lambda _uid, subject: []
        hit = curriculum.unit_for_calendar_week("u1", "AP Language & Composition", real_week)
        check("returns None rather than guessing when nothing matches", hit is None)
    finally:
        db.list_curriculum_progress = real_list_progress2

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the brainstorming model knows which week and unit a new chat is for.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
