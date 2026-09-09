#!/usr/bin/env python3
"""Chat routing contracts: quiz tool schema, revises_current, clarifying rounds.

No DB, no OpenAI call. These are the product holes that used to live only in
comments: revises_current missing from the tool schema, clarifying-round
caps keyed off a specific English phrase, and generate_quiz refused without
a week.

Run:  ./venv/bin/python eval/test_chat_routing.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.llm import CHAT_TOOLS, generate_quiz_tool_payload  # noqa: E402
from backend.routes.generate import (  # noqa: E402
    CLARIFY_MARKER,
    ChatMessage,
    count_prior_clarify_rounds,
    quiz_tool_policy,
)

FAILURES: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {label}" + (f" — {detail}" if detail and not ok else ""))
    if not ok:
        FAILURES.append(label)


def _quiz_tool() -> dict:
    for tool in CHAT_TOOLS:
        fn = tool.get("function") or {}
        if fn.get("name") == "generate_quiz":
            return fn
    raise AssertionError("generate_quiz is missing from CHAT_TOOLS")


def main() -> int:
    print("\n1. generate_quiz tool schema includes revises_current")
    fn = _quiz_tool()
    props = (fn.get("parameters") or {}).get("properties") or {}
    check("revises_current is a boolean parameter", props.get("revises_current", {}).get("type") == "boolean")
    check(
        "description no longer refuses without a week",
        "tell the teacher to build the week first instead of calling this" not in (fn.get("description") or "").lower(),
    )

    print("\n2. generate_quiz_tool_payload forwards revises_current")
    event = generate_quiz_tool_payload({
        "question_types": ["multiple_choice"],
        "num_questions": 10,
        "revises_current": True,
    })
    check("revises_current true survives the payload mapper", event["revises_current"] is True)
    check("false when omitted", generate_quiz_tool_payload({"question_types": ["true_false"]})["revises_current"] is False)
    empty_types = generate_quiz_tool_payload({})
    check("missing question_types defaults to multiple_choice", empty_types["question_types"] == ["multiple_choice"])
    check("unknown types fall back to multiple_choice", generate_quiz_tool_payload({"question_types": ["essay"]})["question_types"] == ["multiple_choice"])

    print("\n3. quiz_tool_policy allows standalone quizzes and names revises_current")
    with_plan = quiz_tool_policy(has_plan=True, has_quiz=True)
    check("plan-backed path still exists", "A plan already exists" in with_plan)
    check("plan-backed revise flag is named", "revises_current: true" in with_plan)
    standalone = quiz_tool_policy(has_plan=False, has_quiz=False)
    check("standalone path exists", "You MAY still call `generate_quiz`" in standalone)
    check("standalone does not tell them to build the week first as a refusal", "cannot be called" not in standalone)
    standalone_revise = quiz_tool_policy(has_plan=False, has_quiz=True)
    check("standalone revise still names revises_current", "revises_current: true" in standalone_revise)
    check(
        "unspecified quizzes are not type/count interviews",
        "Do not interview for type or count" in standalone,
    )
    check(
        "a week and a quiz in one turn uses also_quiz instead of refusing the pair",
        "also_quiz: true" in standalone,
    )

    print("\n4. clarifying-round cap uses kind/marker, not a canned intro")
    m = lambda **kw: ChatMessage(**kw)
    two_kind = [
        m(role="user", content="plan a week"),
        m(role="assistant", kind="clarifying_questions", content="What text are you using?"),
        m(role="user", content="Gatsby"),
        m(role="assistant", kind="clarifying_questions", content="What skill?"),
    ]
    check("two structured rounds count as 2", count_prior_clarify_rounds(two_kind) == 2)
    marked = [
        m(role="assistant", content=f"{CLARIFY_MARKER}\nWhat text?"),
        m(role="user", content="Gatsby"),
        m(role="assistant", content=f"{CLARIFY_MARKER}\nWhat skill?"),
    ]
    check("persisted marker counts even if kind is missing", count_prior_clarify_rounds(marked) == 2)
    reworded = [
        m(role="assistant", content="A couple of quick questions to get this right:"),
        m(role="user", content="Gatsby"),
        m(role="assistant", content="One more thing — what's the skill?"),
    ]
    check("canned English intro without marker does NOT count", count_prior_clarify_rounds(reworded) == 0)
    after_build = [
        m(role="assistant", kind="clarifying_questions", content="What text?"),
        m(role="assistant", content="Week 3 is built."),
        m(role="assistant", kind="clarifying_questions", content="Quiz type?"),
    ]
    check("a built confirmation resets the unbuilt stretch", count_prior_clarify_rounds(after_build) == 1)
    nudge = [
        m(role="assistant", kind="clarifying_questions", content="What text?"),
        m(role="assistant", content="Could you name a specific chapter?"),
        m(role="assistant", kind="clarifying_questions", content="What skill?"),
    ]
    check("a plain nudge between rounds does not reset the count", count_prior_clarify_rounds(nudge) == 2)

    print("\n5. quiz_from_generator retries once on QuizSchemaError")
    from backend.schema import quiz_from_generator  # noqa: E402

    good = {
        "title": "Irony",
        "passages": [],
        "questions": [{
            "type": "multiple_choice",
            "prompt": "Which is verbal irony?",
            "choices": ["A", "B", "C"],
            "correct_index": 1,
        }],
    }
    calls = []

    def generate(skip_cache):
        calls.append(skip_cache)
        if not skip_cache:
            return {"title": "bad", "passages": [], "questions": []}
        return good

    raw, warnings = quiz_from_generator(generate)
    check("retried after empty questions", calls == [False, True])
    check("second sample is returned", raw["title"] == "Irony")
    check("valid quiz has no fatal warnings required", isinstance(warnings, list))

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — quiz tool schema, standalone policy, and clarifying-round counting hold.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
