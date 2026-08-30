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

Sections 4-5 lock in a second, related fix: subject/grade used to come from
db.get_settings_row(user_id) with no subject filter — "the most recently
updated settings row for this account," a legacy table that predates
`classes`. A teacher with more than one prep got whichever class's settings
were touched most recently ANYWHERE in the app, not the class the open chat
actually belongs to — so an ENG 101 chat could brainstorm off AP Lang's
subject, grade, and pacing guide. Now chat_stream resolves the chat's own
class via chat_id first, falling back to the old lookup only when there's no
chat_id, no class_id on the chat, or the class was since deleted.

Run:  ./venv/bin/python eval/test_chat_pacing_guide.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend import db, llm  # noqa: E402
from backend.deps import get_current_user  # noqa: E402
from backend.routes import generate  # noqa: E402
from backend.server import app  # noqa: E402

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def main() -> int:
    captured: dict[str, object] = {}

    real_settings, real_map_context, real_stream_chat, real_output_length, real_custom_instructions, real_get_chat, real_get_class = (
        db.get_settings_row,
        llm.map_context_for,
        llm.stream_chat,
        llm.output_length_for,
        llm.custom_instructions_for,
        db.get_chat,
        db.get_class,
    )
    real_get_user_school, real_list_plans, real_require_entitlement = (
        db.get_user_school,
        db.list_plans,
        generate.require_entitlement,
    )
    db.get_settings_row = lambda _uid: {"subject": "AP Language & Composition", "grade": "11"}

    # No class_id resolves for either of these ids — sections 1-3 below never
    # set chat_id at all, so req.chat_id is None and these aren't even called;
    # sections 4-5 use them to check the resolve-then-fall-back branch.
    db.get_chat = lambda _uid, chat_id: {"class_id": "eng101"} if chat_id == "chat-eng101" else None
    # "id" matters now: _build_chat_system_prompt reads cls["id"] to pass
    # class_id through to map_context_for — a stub missing it surfaces as a
    # KeyError deep in production code, not a clean assertion failure.
    db.get_class = lambda _uid, class_id: (
        {
            "id": "eng101",
            "subject": "English Language Arts",
            "grade": "10",
            "school": "another-ingested-school",
        }
        if class_id == "eng101"
        else None
    )

    def fake_map_context(user_id, subject, query, *, class_id=None):
        captured["map_context_args"] = (user_id, subject, query)
        captured["map_context_class_id"] = class_id
        return "Unit 2, Week 2: irony and diction in short fiction." if captured.get("has_map") else ""

    def fake_stream_chat(user_id, messages, *, voice=False):
        captured["system_prompt"] = messages[0]["content"]
        yield {"chunk": "ok"}
        yield {"done": True}

    llm.map_context_for = fake_map_context
    llm.stream_chat = fake_stream_chat
    llm.output_length_for = lambda _uid: "medium"
    llm.custom_instructions_for = lambda _uid: None
    db.get_user_school = lambda _uid: "weeden-elementary-school"
    db.list_plans = lambda _uid, **_kwargs: {"items": []}
    # This script tests prompt assembly only. The endpoint's entitlement gate
    # is tested elsewhere; leaving it live here makes an otherwise hermetic
    # eval attempt to connect to the production database.
    generate.require_entitlement = lambda _uid: None
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

        print("\n4. A chat under a DIFFERENT class than the account's last-touched settings")
        captured.clear()
        captured["has_map"] = True
        client.post(
            "/api/chat_stream",
            json={
                "chat_id": "chat-eng101",
                "messages": [{"role": "user", "content": "what's next in the unit"}],
            },
        )
        prompt = str(captured.get("system_prompt", ""))
        check("used the chat's OWN class subject and grade", "English Language Arts (Grade 10)" in prompt)
        check("did not fall back to the account's last-touched settings subject", "AP Language & Composition" not in prompt)
        check(
            "looked up the pacing guide under the chat's class subject, not settings'",
            captured.get("map_context_args", (None, None, ""))[1] == "English Language Arts",
        )
        check(
            "map_context_for was scoped to the chat's own class_id, not None",
            captured.get("map_context_class_id") == "eng101",
        )
        check(
            "every school chat names its configured five-day structure",
            "selected school's weekly lesson-plan format is already configured" in prompt
            and "complete five-day Monday-Friday structure" in prompt,
        )
        check(
            "every school chat forbids day-count clarifying questions",
            "Never ask the teacher how many days" in prompt,
        )

        print("\n5. A chat with no resolvable class still falls back to settings")
        captured.clear()
        captured["has_map"] = True
        client.post(
            "/api/chat_stream",
            json={
                "chat_id": "chat-not-a-real-chat",
                "messages": [{"role": "user", "content": "let's plan week 3"}],
            },
        )
        prompt = str(captured.get("system_prompt", ""))
        check("falls back to account settings when the chat has no class", "AP Language & Composition (Grade 11)" in prompt)
    finally:
        db.get_settings_row = real_settings
        llm.map_context_for = real_map_context
        llm.stream_chat = real_stream_chat
        llm.output_length_for = real_output_length
        llm.custom_instructions_for = real_custom_instructions
        db.get_chat = real_get_chat
        db.get_class = real_get_class
        db.get_user_school = real_get_user_school
        db.list_plans = real_list_plans
        generate.require_entitlement = real_require_entitlement
        app.dependency_overrides.pop(get_current_user, None)

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the brainstorming model sees the teacher's own pacing guide.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
