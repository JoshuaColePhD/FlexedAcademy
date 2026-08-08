#!/usr/bin/env python3
"""chat_stream: does the brainstorming model ever see the pacing guide?

A teacher uploaded a curriculum map, said so in the chat, and got "I don't
have access to your settings or any attachments." That was TRUE of the code:
llm.map_context_for() — the lookup that hands the teacher's own pacing guide
to a prompt — was wired into the two plan-WRITING calls (generate_plan,
stream_plan) and nowhere else. The conversational model that runs before any
plan exists never called it, so a teacher trying to brainstorm off their own
pacing guide was talking to a model that structurally could not see it.

This locks in the fix at the only point that matters: what actually reaches
the model. No DB, no OpenAI call — db.get_settings_row, llm.map_context_for,
and llm.stream_chat are stubbed so the assertion is about the system prompt
routes/generate.py builds, not about retrieval or the LLM.

Run:  ./venv/bin/python eval/test_chat_pacing_guide.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import db, llm  # noqa: E402
from backend.deps import get_current_user  # noqa: E402
from backend.server import app  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def main() -> int:
    captured: dict[str, object] = {}

    real_settings, real_map_context, real_stream_chat = (
        db.get_settings_row,
        llm.map_context_for,
        llm.stream_chat,
    )
    db.get_settings_row = lambda _uid: {"subject": "AP Language & Composition", "grade": "11"}

    def fake_map_context(user_id, subject, query):
        captured["map_context_args"] = (user_id, subject, query)
        return "Unit 2, Week 2: irony and diction in short fiction." if captured.get("has_map") else ""

    def fake_stream_chat(messages):
        captured["system_prompt"] = messages[0]["content"]
        yield {"chunk": "ok"}
        yield {"done": True}

    llm.map_context_for = fake_map_context
    llm.stream_chat = fake_stream_chat
    app.dependency_overrides[get_current_user] = lambda: "u1"

    try:
        client = TestClient(app)

        print("\n1. A teacher WITH an active pacing guide")
        captured["has_map"] = True
        client.post(
            "/api/chat_stream",
            json={"messages": [{"role": "user", "content": "i attached my pacing guide"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        check("map_context_for was called at all", "map_context_args" in captured)
        check(
            "queried on the latest user message, not blank",
            captured.get("map_context_args", (None, None, ""))[2] == "i attached my pacing guide",
        )
        check("the pacing guide text reaches the system prompt", "irony and diction" in prompt)
        check(
            "the model is told standards still come from retrieval, not this doc",
            "no standard codes of its own" in prompt.lower() or "standard codes" in prompt,
        )

        print("\n2. A teacher with NO active pacing guide — nothing fabricated")
        captured.clear()
        captured["has_map"] = False
        client.post(
            "/api/chat_stream",
            json={"messages": [{"role": "user", "content": "let's plan week 3"}]},
        )
        prompt = str(captured.get("system_prompt", ""))
        check("still calls the lookup (so a later upload works without a code change)", "map_context_args" in captured)
        check("adds no curriculum-map block when there is nothing to add", "CURRICULUM MAP" not in prompt)

        print("\n3. Multi-turn — queries on the LATEST user turn, not the first")
        captured.clear()
        captured["has_map"] = True
        client.post(
            "/api/chat_stream",
            json={
                "messages": [
                    {"role": "user", "content": "let's talk about week 3"},
                    {"role": "assistant", "content": "Sure — what's the focus?"},
                    {"role": "user", "content": "check my pacing guide for what's next"},
                ]
            },
        )
        check(
            "used the most recent user turn as the query",
            captured.get("map_context_args", (None, None, ""))[2] == "check my pacing guide for what's next",
        )
    finally:
        db.get_settings_row = real_settings
        llm.map_context_for = real_map_context
        llm.stream_chat = real_stream_chat
        app.dependency_overrides.pop(get_current_user, None)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the brainstorming model sees the teacher's own pacing guide.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
