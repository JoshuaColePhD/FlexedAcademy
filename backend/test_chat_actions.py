"""No-network regression coverage for typed routing and streamed arguments."""

import json
from copy import deepcopy
from types import SimpleNamespace as NS

import pytest

from backend import llm, service
from backend.chat_policy import (
    CASUAL_OPENER_HINT,
    chat_turn_policy,
    is_casual_opener,
    pending_intent,
    references_plan_context,
    typed_chat_tools,
    validate_action_target,
    validate_plan_action,
    wants_plan_context,
    without_quiz_tools,
)
from backend.errors import AppError


def action(**overrides):
    return dict(
        action="create",
        target_plan_id=None,
        instruction="Plan rhetorical analysis with paper materials and a 45-minute period.",
        days=[],
        field=None,
        week_number=3,
        also_quiz=False,
        **overrides,
    )


@pytest.mark.parametrize(
    "change",
    [
        {"action": "unknown"},
        {"action": "revise_days", "target_plan_id": "p1"},
        {"field": []},
        {"days": ["Blursday"]},
        {"week_number": True},
        {"week_number": 0},
    ],
)
def test_rejects_unsafe_actions(change):
    with pytest.raises(AppError):
        validate_plan_action({**action(), **change})


def test_create_ignores_leaked_active_plan_id():
    result = validate_plan_action({**action(), "target_plan_id": "old-plan", "days": ["Monday"], "field": "during"})
    assert result["action"] == "create"
    assert result["target_plan_id"] is None
    assert result["days"] == []
    assert result["field"] is None


def test_long_instruction_is_truncated_not_rejected():
    result = validate_plan_action({**action(), "instruction": "x" * 4001})
    assert len(result["instruction"]) == 4000


def test_explicit_create_and_revision_targets():
    create = validate_plan_action(action())
    validate_action_target(create, "existing-plan")
    revision = validate_plan_action(
        {
            **action(),
            "action": "revise_days",
            "target_plan_id": "p1",
            "days": ["Wednesday"],
            "field": "assessment",
        }
    )
    validate_action_target(revision, "p1")
    with pytest.raises(AppError, match="no longer active"):
        validate_action_target(revision, "p2")
    with pytest.raises(AppError):
        validate_action_target({"tool_call": "update_lesson_day"}, "p1")


def test_voice_tools_unchanged_and_typed_questions_are_single():
    before = deepcopy(llm.CHAT_TOOLS)
    typed = {t["function"]["name"]: t["function"] for t in typed_chat_tools(llm.CHAT_TOOLS)}
    assert llm.CHAT_TOOLS == before
    assert (
        typed["ask_clarifying_questions"]["parameters"]["properties"]["questions"]["maxItems"] == 1
    )
    assert typed["generate_lesson_plan"]["parameters"]["required"] == ["preamble", "action"]
    field = typed["generate_lesson_plan"]["parameters"]["properties"]["field"]
    assert field["type"] == ["string", "null"]
    assert None not in field["enum"]
    assert list(field["enum"]) == list(llm.REVISABLE_FIELDS)
    assert "also_quiz" in typed["generate_lesson_plan"]["parameters"]["properties"]
    quiz_required = typed["generate_quiz"]["parameters"].get("required") or []
    assert quiz_required == ["preamble"]
    assert "instruction" not in quiz_required
    assert "target_quiz_id" not in quiz_required
    # preamble must be declared FIRST on every typed tool: models emit
    # properties in declaration order, so this is what lets the teacher read
    # what is happening while the rest of the arguments are still streaming.
    for name in ("generate_lesson_plan", "generate_quiz", "update_lesson_day",
                 "ask_clarifying_questions"):
        props = list(typed[name]["parameters"]["properties"])
        assert props[0] == "preamble", name
        assert "preamble" in typed[name]["parameters"]["required"], name
    purpose = typed["ask_clarifying_questions"]["parameters"]["properties"]["purpose"]
    assert purpose["enum"] == ["clarify", "suggest"]
    assert "choice box above the composer" in typed["ask_clarifying_questions"]["description"]
    # Voice keeps the legacy shapes, with no preamble anywhere.
    for tool in llm.CHAT_TOOLS:
        assert "preamble" not in (tool["function"].get("parameters") or {}).get("properties", {})


def test_suggest_purpose_uses_the_choice_box_preamble():
    assert llm.clarifying_purpose({"purpose": "suggest"}) == "suggest"
    assert llm.clarifying_purpose({"purpose": "clarify"}) == "clarify"
    assert llm.clarifying_purpose({}) == "clarify"
    assert llm._preamble_fallback(
        "ask_clarifying_questions", {"purpose": "suggest"}, 0, 0
    ) == "A few directions for this week:"
    assert llm._preamble_fallback(
        "ask_clarifying_questions", {"purpose": "clarify"}, 0, 0
    ) == "One detail will help me get this right:"


def test_typed_tools_omit_quiz_when_beta_is_off():
    names = [t["function"]["name"] for t in typed_chat_tools(llm.CHAT_TOOLS, quizzes_enabled=False)]
    assert "generate_quiz" not in names
    assert "generate_lesson_plan" in names
    typed = {t["function"]["name"]: t["function"] for t in typed_chat_tools(llm.CHAT_TOOLS, quizzes_enabled=False)}
    assert "also_quiz" not in typed["generate_lesson_plan"]["parameters"]["properties"]
    assert "generate_quiz" not in [t["function"]["name"] for t in without_quiz_tools(llm.CHAT_TOOLS)]


def test_typed_tool_enums_do_not_include_null():
    """OpenAI function tools 400 if an enum array contains null.

    After PR 87 every typed turn sends these tools, including 'hello', so a
    null in `field.enum` took the whole chat down before the model saw the
    message.
    """

    payload = json.loads(json.dumps(typed_chat_tools(llm.CHAT_TOOLS)))
    bad = []

    def walk(node, path):
        if isinstance(node, dict):
            enum = node.get("enum")
            if isinstance(enum, list) and any(value is None for value in enum):
                bad.append(path)
            for key, value in node.items():
                walk(value, f"{path}.{key}")
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(payload, "$")
    assert bad == [], bad


def test_single_persona_carries_the_behavior_the_regex_gate_used_to():
    from backend.chat_policy import CHAT_PARTNER_POLICY, PLAN_OPEN_OVERLAY

    # Normalized, so rewrapping the prompt does not fail this for no reason.
    text = " ".join(CHAT_PARTNER_POLICY.split())
    raw = CHAT_PARTNER_POLICY
    # One voice, and the scope guard that CONVERSATIONAL_CHAT_POLICY used to own.
    assert "Do not offer assessment design, instructional coaching" in text
    assert "invite them to say what they need" in text
    assert "no question card on that turn" in text
    assert "A visible plan is context, not permission to edit it." in text
    assert "mixed another course into this class" in text
    assert "choice box above the composer" in text
    assert "any ideas" in text
    # The rule the whole change exists for.
    assert "NEVER WRITE THE ARTIFACT INTO THE CHAT" in raw
    assert "Never type Monday through Friday" in text
    # Continuation across turns, which had no equivalent before.
    assert "this message answers it" in text
    # The route asserts these strings stay absent; keep that true at the source.
    assert "Do NOT call" not in raw
    assert "call generate_lesson_plan (or" not in raw
    assert "`generate_quiz`" not in raw
    assert "interview the teacher" in " ".join(PLAN_OPEN_OVERLAY.split())


def test_math_course_lock_rejects_literary_mashups():
    from backend.chat_policy import course_lock_block

    lock = course_lock_block("Pre-AP Algebra 2", "Pre-AP Algebra 2 (Grade 11)")
    assert "This conversation is only for Pre-AP Algebra 2 (Grade 11)." in lock
    assert "that was an error" in lock
    assert "This is a mathematics class." in lock
    assert "literary texts" in lock


@pytest.mark.parametrize(
    "message",
    [
        # Every one of these was denied tools by the old regex gate, so the
        # model answered a build request by typing the week into the transcript.
        "make a lesson",
        "build me next week",
        "draft week 7",
        "I need a sub plan for Friday",
        "can you put together Tuesday",
        "yes",
        "sounds good, go ahead",
        "quadratic functions",
        "I don't have one",
        "fix Wednesday",
        "why does this feel too busy?",
        "ok",
        "",
    ],
)
def test_every_typed_turn_carries_its_tools(message):
    policy = chat_turn_policy("brainstorm", messages=[NS(role="user", content=message, kind=None)])
    assert policy.tools_enabled is True


def test_hello_is_a_casual_opener_and_still_has_tools():
    policy = chat_turn_policy("brainstorm", messages=[NS(role="user", content="hello", kind=None)])
    assert policy.tools_enabled is True
    assert policy.casual_opener is True
    assert policy.pending_intent is None
    assert is_casual_opener("hello") is True
    assert is_casual_opener("thanks!") is True
    assert is_casual_opener("make a lesson") is False


def test_pending_intent_survives_a_clarifying_exchange():
    # The exact transcript that failed: the answer turn carries no action verb,
    # so a last-message test can never see that the request is still open.
    assert pending_intent([
        NS(role="user", content="make a lesson", kind=None),
        NS(role="assistant", content="What should this week focus on?",
           kind="clarifying_questions"),
        NS(role="user", content="I don't have one", kind=None),
    ]) == "clarification_answer"
    assert pending_intent([
        NS(role="user", content="thinking about Gatsby", kind=None),
        NS(role="assistant", content="Want me to build that week?", kind=None),
        NS(role="user", content="yes", kind=None),
    ]) == "offer_reply"
    assert pending_intent([
        NS(role="user", content="how long should a do-now be?", kind=None),
    ]) is None
    # An assistant turn that neither asked nor offered is not a pending intent.
    assert pending_intent([
        NS(role="user", content="hi", kind=None),
        NS(role="assistant", content="The week is built.", kind=None),
        NS(role="user", content="thanks", kind=None),
    ]) is None
    # A short "yes" after an offer is the go-ahead, not small talk, even though
    # "ok"/"yes" would look casual if we only read the last message.
    yes_after_offer = [
        NS(role="user", content="thinking about Gatsby", kind=None),
        NS(role="assistant", content="Want me to build that week?", kind=None),
        NS(role="user", content="yes", kind=None),
    ]
    assert pending_intent(yes_after_offer) == "offer_reply"
    offer_policy = chat_turn_policy("brainstorm", messages=yes_after_offer)
    assert offer_policy.pending_intent == "offer_reply"
    assert offer_policy.casual_opener is False


def test_plan_context_reads_the_recent_exchange_not_one_message():
    convo = [
        NS(role="user", content="plan week 7 on quadratics", kind=None),
        NS(role="assistant", content="Want me to build that?", kind=None),
        NS(role="user", content="yes", kind=None),
    ]
    # "yes" mentions nothing, but the pacing guide is still what this turn needs.
    assert wants_plan_context(convo, mode="brainstorm") is True
    assert wants_plan_context(
        [NS(role="user", content="why does the model feel less personal?", kind=None)],
        mode="brainstorm",
    ) is False
    assert references_plan_context("Can we rethink Wednesday's exit ticket?") is True
    assert references_plan_context("Why does the model feel less personal?") is False
    assert references_plan_context("what are your suggestions?") is True


def test_command_surface_needs_both_an_open_plan_and_a_plan(monkeypatch):
    assert chat_turn_policy("brainstorm", plan_open=True, has_plan=True).command_surface is True
    assert chat_turn_policy("brainstorm", plan_open=True, has_plan=False).command_surface is False
    assert chat_turn_policy("brainstorm", plan_open=False, has_plan=True).command_surface is False
    # Voice keeps its own prompt path and never gets the typed overlay.
    assert chat_turn_policy(
        "brainstorm", plan_open=True, has_plan=True, voice=True
    ).command_surface is False


def test_conversational_stream_omits_tools_and_uses_light_reasoning(monkeypatch):
    calls = []

    class Stream:
        closed = False

        def __iter__(self):
            return iter([
                NS(
                    usage=None,
                    choices=[NS(
                        delta=NS(content="That makes sense.", tool_calls=None, refusal=None),
                        finish_reason="stop",
                    )],
                )
            ])

        def close(self):
            self.closed = True

    stream = Stream()

    def create(**kwargs):
        calls.append(kwargs)
        return stream

    monkeypatch.setattr(
        llm,
        "client",
        lambda: NS(chat=NS(completions=NS(create=create))),
    )
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 2200)
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)

    assert list(llm.stream_chat("u", [], actions_enabled=False)) == [{"chunk": "That makes sense."}]
    assert calls[0]["reasoning_effort"] == "low"
    assert "tools" not in calls[0]
    assert "parallel_tool_calls" not in calls[0]
    # No tool definitions means no tool-argument headroom.
    assert calls[0]["max_completion_tokens"] == 2200 + llm._REASONING_HEADROOM["low"]


def test_tool_turns_force_reasoning_none_for_luna(monkeypatch):
    calls = []

    class Stream:
        closed = False

        def __iter__(self):
            return iter([NS(usage=None, choices=[NS(
                delta=NS(content="Sure.", tool_calls=None, refusal=None),
                finish_reason="stop",
            )])])

        def close(self):
            self.closed = True

    monkeypatch.setattr(llm, "client", lambda: NS(chat=NS(completions=NS(
        create=lambda **kw: (calls.append(kw), Stream())[1]
    ))))
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 2200)
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)

    list(llm.stream_chat("u", []))
    # gpt-5.6-luna Chat Completions 400s if function tools are sent with any
    # reasoning_effort other than "none". Typed chat always has tools.
    assert calls[0]["reasoning_effort"] == "none"
    assert calls[0]["tools"]
    assert calls[0]["max_completion_tokens"] == 2200 + llm._TOOL_ARG_HEADROOM


def fake_stream(monkeypatch, payload, *, truncated=False):
    chunks = []
    for i, fragment in enumerate([payload[:12], payload[12:35], payload[35:]]):
        fn = NS(name="generate_lesson_plan" if i == 0 else None, arguments=fragment)
        chunks.append(
            NS(
                usage=None,
                choices=[
                    NS(
                        delta=NS(tool_calls=[NS(index=0, function=fn)], content=None),
                        finish_reason=None,
                    )
                ],
            )
        )
    if not truncated:
        chunks.append(
            NS(usage=None, choices=[NS(delta=NS(content=None), finish_reason="tool_calls")])
        )

    class Stream:
        closed = False

        def __iter__(self):
            return iter(chunks)

        def close(self):
            self.closed = True

    stream = Stream()
    monkeypatch.setattr(
        llm, "client", lambda: NS(chat=NS(completions=NS(create=lambda **kw: stream)))
    )
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 2200)
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)
    return stream


def test_stream_waits_for_complete_action(monkeypatch):
    stream = fake_stream(monkeypatch, json.dumps(action()))
    events = list(llm.stream_chat("u", []))
    # These args carry no preamble, so the per-tool default fills in: the
    # browser must never jump straight to an artifact card with no sentence.
    assert events == [
        {"chunk": llm._DEFAULT_PREAMBLE["generate_lesson_plan"]},
        {"tool_call": "generate_lesson_plan", **action()},
    ]
    assert stream.closed


def test_preamble_streams_before_the_tool_call(monkeypatch):
    said = "Building week 7 on quadratics."
    fake_stream(monkeypatch, json.dumps({"preamble": said, **action()}))
    events = list(llm.stream_chat("u", []))

    tool_at = next(i for i, e in enumerate(events) if "tool_call" in e)
    assert tool_at == len(events) - 1, "the tool call must be last"
    assert "".join(e["chunk"] for e in events[:tool_at]) == said
    # preamble is a transport detail; it must not leak into the dispatched event.
    assert "preamble" not in events[tool_at]
    assert events[tool_at] == {"tool_call": "generate_lesson_plan", **action()}


def test_combined_final_chunk_dispatches(monkeypatch):
    """One chunk carrying the last argument fragment AND finish_reason.

    The tool branch used to `continue` past every dispatch branch, so this
    exited the loop with a complete, valid call and raised malformed_tool_call.
    """
    payload = json.dumps(action())

    class Stream:
        closed = False

        def __iter__(self):
            return iter([
                NS(usage=None, choices=[NS(
                    delta=NS(content=None, refusal=None, tool_calls=[
                        NS(index=0, function=NS(name="generate_lesson_plan",
                                                arguments=payload[:20]))
                    ]),
                    finish_reason=None,
                )]),
                NS(usage=None, choices=[NS(
                    delta=NS(content=None, refusal=None, tool_calls=[
                        NS(index=0, function=NS(name=None, arguments=payload[20:]))
                    ]),
                    finish_reason="tool_calls",
                )]),
            ])

        def close(self):
            self.closed = True

    monkeypatch.setattr(llm, "client", lambda: NS(chat=NS(completions=NS(
        create=lambda **kw: Stream()
    ))))
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 2200)
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)

    events = list(llm.stream_chat("u", []))
    assert events[-1] == {"tool_call": "generate_lesson_plan", **action()}


def _prose_stream(monkeypatch, text, *, chunk=200):
    pieces = [text[i:i + chunk] for i in range(0, len(text), chunk)]

    class Stream:
        closed = False

        def __iter__(self):
            return iter([
                NS(usage=None, choices=[NS(
                    delta=NS(content=p, tool_calls=None, refusal=None),
                    finish_reason=None,
                )]) for p in pieces
            ])

        def close(self):
            self.closed = True

    monkeypatch.setattr(llm, "client", lambda: NS(chat=NS(completions=NS(
        create=lambda **kw: Stream()
    ))))
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 2200)
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)


def test_prose_dump_is_cut_off_when_a_tool_was_available(monkeypatch):
    """The deterministic backstop against the original failure.

    A five-day plan typed as prose runs 6,000-10,000 characters. Everything
    else keeping it out of the transcript is probabilistic; this is not.
    """
    _prose_stream(monkeypatch, "Monday: do the thing. " * 300)
    events = list(llm.stream_chat("u", []))
    assert events[-1] == {"chunk": llm._PROSE_CUTOFF_NOTE}
    streamed = sum(len(e["chunk"]) for e in events[:-1])
    assert streamed < 10_000


def test_prose_backstop_leaves_a_toolless_turn_alone(monkeypatch):
    # With no tools in the array there is no artifact to divert to, so a long
    # answer is just a long answer.
    _prose_stream(monkeypatch, "Monday: do the thing. " * 300)
    events = list(llm.stream_chat("u", [], actions_enabled=False))
    assert llm._PROSE_CUTOFF_NOTE not in [e.get("chunk") for e in events]


@pytest.mark.parametrize(
    "payload,truncated", [("{", False), ("[]", False), (json.dumps(action()), True)]
)
def test_incomplete_tool_never_dispatches(monkeypatch, payload, truncated):
    stream = fake_stream(monkeypatch, payload, truncated=truncated)
    with pytest.raises(AppError):
        list(llm.stream_chat("u", []))
    assert stream.closed


def test_voice_retains_early_argumentless_action(monkeypatch):
    fake_stream(monkeypatch, "", truncated=True)
    assert list(llm.stream_chat("u", [], voice=True)) == [{"tool_call": "generate_lesson_plan"}]


@pytest.fixture
def batch(monkeypatch, tmp_path):
    plan = {
        "days": [
            {"name": name, "during": f"{name} task", "assessment": "exit", "no_school": False}
            for name in ["Monday", "Tuesday", "Wednesday"]
        ]
    }
    row = {"id": "p1", "plan_json": plan}
    saved = []
    monkeypatch.setattr(service.db, "get_plan", lambda *a: deepcopy(row))
    monkeypatch.setattr(service, "_resolve_subject_grade", lambda *a: ("ELA", "11"))
    monkeypatch.setattr(service, "_school_for_class", lambda *a: "generic")
    monkeypatch.setattr(service, "_selected_template_id", lambda *a: None)
    monkeypatch.setattr(service, "has_template_field", lambda *a, **kw: False)
    monkeypatch.setattr(
        service, "day_names_for_school", lambda *a, **kw: ["Monday", "Tuesday", "Wednesday"]
    )
    monkeypatch.setattr(service.schema, "validate_day", lambda day, **kw: (deepcopy(day), []))
    monkeypatch.setattr(
        service.retrieval, "retrieve_grounded", lambda *a, **kw: service.RetrievalResult()
    )
    monkeypatch.setattr(service.retrieval, "audit_grounding", lambda *a, **kw: [])
    monkeypatch.setattr(service.retrieval, "cited_standards", lambda *a, **kw: [])
    monkeypatch.setattr(service.docx_build, "plan_output_path", lambda *a: tmp_path / "plan.docx")
    monkeypatch.setattr(service.docx_build, "build_docx", lambda *a: None)
    monkeypatch.setattr(service, "_persist_docx", lambda *a: None)
    monkeypatch.setattr(service.db, "replace_plan_standards", lambda *a, **kw: None)

    def save(*a, **kw):
        saved.append(kw["plan_json"])
        return {"id": "p1", **kw}

    monkeypatch.setattr(service.db, "update_plan", save)
    return plan, saved


def test_batch_field_preserves_everything_else(monkeypatch, batch):
    plan, saved = batch
    monkeypatch.setattr(service.llm, "rewrite_day_field", lambda *a, **kw: "new task")
    result = service.revise_days("u", "p1", [0, 2], "Use paper", "during")["plan_json"]
    assert result["days"][1] == plan["days"][1]
    for idx in [0, 2]:
        assert result["days"][idx] == {**plan["days"][idx], "during": "new task"}
    assert len(saved) == 1


def test_batch_whole_days_preserves_other_days_and_names(monkeypatch, batch):
    plan, saved = batch
    monkeypatch.setattr(
        service.llm,
        "rewrite_day",
        lambda u, day, *a, **kw: {**day, "name": "Friday", "during": "new task"},
    )
    result = service.revise_days("u", "p1", [0, 2], "Reteach with modeling", None)["plan_json"]
    assert result["days"][1] == plan["days"][1]
    assert [d["name"] for d in result["days"]] == [d["name"] for d in plan["days"]]
    assert len(saved) == 1


def test_batch_failure_saves_nothing(monkeypatch, batch):
    plan, saved = batch

    def rewrite(u, day, *a, **kw):
        if day["name"] == "Wednesday":
            raise AppError("upstream_timeout", "Timed out")
        return {**day, "during": "new task"}

    monkeypatch.setattr(service.llm, "rewrite_day", rewrite)
    with pytest.raises(AppError):
        service.revise_days("u", "p1", [0, 2], "Reteach", None)
    assert not saved
    assert plan["days"][0]["during"] == "Monday task"


@pytest.fixture
def chat_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routes import generate

    class Captured(list):
        pass

    captured = Captured()
    captured.kwargs = []
    emitted = []
    plan = {
        "id": "p1",
        "chat_id": "chat1",
        "class_id": "c1",
        "plan_json": {"days": [{"name": "Wednesday", "during": "Paper evidence analysis"}]},
    }
    monkeypatch.setattr(generate, "require_entitlement", lambda *a: None)
    monkeypatch.setattr(generate, "_request_class", lambda *a: {"subject": "ELA", "grade": "11"})
    monkeypatch.setattr(
        generate, "_build_chat_system_prompt", lambda *a, **kw: "BASE CLASS CONTEXT"
    )
    monkeypatch.setattr(generate.db, "list_plans", lambda *a, **kw: {"items": [{"id": "p1"}]})
    monkeypatch.setattr(generate.db, "get_plan", lambda user, id: plan if id == "p1" else None)
    monkeypatch.setattr(generate.db, "list_quizzes_for_plan", lambda *a: [])
    monkeypatch.setattr(generate, "beta_features_for", lambda uid: False)
    monkeypatch.setattr(generate.llm, "extract_and_persist_coaching_memory", lambda *a: None)

    def stream(user, messages, **kw):
        captured.append(messages)
        captured.kwargs.append(kw)
        yield from emitted or [{"chunk": "Try modeling one example."}]

    monkeypatch.setattr(generate.llm, "stream_chat", stream)
    app = FastAPI()
    app.include_router(generate.router)
    app.dependency_overrides[generate.get_current_user] = lambda: "u"
    app.state.limiter = generate.limiter
    with TestClient(app) as client:
        yield client, captured, emitted


def test_route_uses_active_plan_and_prior_answers_without_forcing_build(chat_client):
    client, captured, _ = chat_client
    messages = [
        {"role": "user", "content": "Use paper materials, 45-minute periods."},
        {"role": "assistant", "content": "A couple of quick questions to get this right:"},
        {"role": "user", "content": "Evidence analysis."},
        {"role": "assistant", "content": "A couple of quick questions to get this right:"},
        {"role": "user", "content": "Why would a modeled example help?"},
    ]
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": messages,
            "chat_id": "chat1",
            "class_id": "c1",
            "active_plan_id": "p1",
            "mode": "plan",
        },
    )
    assert response.status_code == 200
    assert "Try modeling one example." in response.text
    system = captured[0][0]["content"]
    assert "Active target_plan_id: p1" in system
    assert "Paper evidence analysis" in system
    assert "Do NOT call" not in system
    assert "call generate_lesson_plan (or" not in system
    assert captured[0][1:] == messages


def test_route_uses_one_persona_and_always_sends_tools(chat_client):
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [{"role": "user", "content": "Why does this feel too busy?"}],
            "chat_id": "chat1",
            "class_id": "c1",
            "mode": "brainstorm",
        },
    )
    assert response.status_code == 200
    system = captured[0][0]["content"]
    # The assistant's voice no longer changes between turns based on a regex.
    assert "You are the teacher's planning partner" in system
    assert "CONVERSATIONAL MODE" not in system
    # Availability is the contract; whether to call one is the model's judgment,
    # which is why this turn still answers in prose.
    assert captured.kwargs[0]["actions_enabled"] is True


def test_route_answers_a_plain_question_without_an_artifact(chat_client):
    client, _, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [{"role": "user", "content": "Why does this feel too busy?"}],
            "chat_id": "chat1",
            "class_id": "c1",
            "mode": "brainstorm",
        },
    )
    assert response.status_code == 200
    assert "tool_call" not in response.text


def test_route_carries_the_pending_intent_after_a_clarifying_question(chat_client):
    """The turn the old gate could never act on.

    "I don't have one" has no action verb and names no artifact, so the regex
    denied it tools and the model wrote the week into the transcript instead.
    """
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [
                {"role": "user", "content": "make a lesson"},
                {
                    "role": "assistant",
                    "content": "What should this week focus on?",
                    "kind": "clarifying_questions",
                },
                {"role": "user", "content": "I don't have one"},
            ],
            "chat_id": "chat1",
            "class_id": "c1",
            "mode": "brainstorm",
        },
    )
    assert response.status_code == 200
    system = captured[0][0]["content"]
    assert captured.kwargs[0]["actions_enabled"] is True
    assert "answers the question you just asked" in system
    # The hint sits closest to the teacher's message, after the saved plan.
    assert system.index("answers the question you just asked") > system.rindex(
        "You are the teacher's planning partner"
    )


def test_route_marks_hello_as_a_casual_opener_without_stripping_tools(chat_client):
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [{"role": "user", "content": "hello"}],
            "chat_id": "chat1",
            "class_id": "c1",
            "mode": "brainstorm",
        },
    )
    assert response.status_code == 200
    system = captured[0][0]["content"]
    assert captured.kwargs[0]["actions_enabled"] is True
    assert "greeting or social opener" in system
    assert CASUAL_OPENER_HINT.strip() in system
    assert "answers the question you just asked" not in system


def test_teacher_first_name_uses_the_account_name(monkeypatch):
    from backend.routes import generate

    monkeypatch.setattr(
        generate.db, "get_user_by_id", lambda uid: {"name": "Joshua Cole"} if uid == "u" else None
    )
    assert generate._teacher_first_name("u") == "Joshua"
    assert generate._teacher_first_name("missing") == ""


def test_openai_status_error_logs_the_provider_body(caplog):
    import httpx
    import openai

    from backend.routes.generate import _openai_error_event

    body = {"error": {"message": "Invalid schema for function generate_lesson_plan."}}
    request = httpx.Request("POST", "https://api.openai.com/v1/chat/completions")
    response = httpx.Response(400, json=body, request=request)
    err = openai.APIStatusError("Bad request", response=response, body=body)
    with caplog.at_level("WARNING"):
        mapped = _openai_error_event(err)
    assert mapped["code"] == "upstream_error"
    assert "Invalid schema" in caplog.text
    assert "400" in caplog.text


def test_open_plan_uses_command_surface(chat_client):
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [{"role": "user", "content": "Ask questions"}],
            "chat_id": "chat1",
            "class_id": "c1",
            "active_plan_id": "p1",
            "plan_open": True,
        },
    )
    assert response.status_code == 200
    system = captured[0][0]["content"]
    assert "Terse instructions are edits to apply now" in system
    assert "interview the teacher" in system


def test_route_rejects_foreign_plan_before_model_call(chat_client):
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={"messages": [], "chat_id": "chat1", "class_id": "c1", "active_plan_id": "foreign"},
    )
    assert "invalid_plan_target" in response.text
    assert not captured


def test_route_binds_stale_revision_target_to_open_plan(chat_client):
    client, _, emitted = chat_client
    emitted.append(
        {
            "tool_call": "generate_lesson_plan",
            **action(),
            "action": "revise_week",
            "target_plan_id": "stale-from-history",
            "instruction": "Add turn-and-talks across the week.",
        }
    )
    response = client.post(
        "/api/chat_stream",
        json={
            "messages": [{"role": "user", "content": "yes"}],
            "chat_id": "chat1",
            "class_id": "c1",
            "active_plan_id": "p1",
        },
    )
    assert response.status_code == 200
    assert "invalid_plan_target" not in response.text
    assert '"tool_call": "generate_lesson_plan"' in response.text
    assert '"target_plan_id": "p1"' in response.text
    assert "stale-from-history" not in response.text


def test_revision_without_open_plan_is_still_rejected(chat_client, monkeypatch):
    from backend.routes import generate

    client, _, emitted = chat_client
    monkeypatch.setattr(generate.db, "list_plans", lambda *a, **kw: {"items": []})
    emitted.append(
        {
            "tool_call": "generate_lesson_plan",
            **action(),
            "action": "revise_week",
            "target_plan_id": "p1",
        }
    )
    response = client.post(
        "/api/chat_stream",
        json={"messages": [{"role": "user", "content": "yes"}], "chat_id": "chat1", "class_id": "c1"},
    )
    assert "invalid_plan_target" in response.text
    assert '"tool_call"' not in response.text


def test_legacy_request_loads_full_plan_context(chat_client):
    client, captured, _ = chat_client
    client.post("/api/chat_stream", json={"messages": [], "chat_id": "chat1"})
    assert "Paper evidence analysis" in captured[0][0]["content"]


def test_instructional_judgment_reaches_creation_and_scoped_revision(monkeypatch):
    from backend import prompts
    from backend.chat_policy import INSTRUCTIONAL_JUDGMENT
    from backend.retrieval import RetrievalResult

    monkeypatch.setattr(prompts, "planning_rules", lambda: "")
    monkeypatch.setattr(prompts, "school_profile", lambda _: "")
    monkeypatch.setattr(
        prompts, "weekly_template_context", lambda *a, **kw: "Monday through Friday"
    )
    monkeypatch.setattr(
        prompts,
        "day_names_for_school",
        lambda *a, **kw: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    )
    result = RetrievalResult()
    assert INSTRUCTIONAL_JUDGMENT in prompts.week_system_prompt(result, subject="ELA")
    assert INSTRUCTIONAL_JUDGMENT in prompts.day_system_prompt(result, "{}", subject="ELA")
    assert INSTRUCTIONAL_JUDGMENT in prompts.day_field_system_prompt(
        result, "{}", "during", subject="ELA"
    )


def test_quiz_contract_preserves_constraints_and_scope():
    from backend.chat_policy import complete_typed_event, validate_quiz_action
    args = {
        "instruction": "Use paper and accessible wording",
        "source_plan_id": None,
        "target_quiz_id": None,
        "revises_current": False,
        "num_questions": 5,
    }
    assert validate_quiz_action(args)["source_plan_id"] is None
    leaked = validate_quiz_action({**args, "target_quiz_id": "q1"})
    assert leaked["target_quiz_id"] is None and leaked["revises_current"] is False
    assert validate_quiz_action({**args, "num_questions": 100})["num_questions"] == 40
    assert validate_quiz_action({**args, "revises_current": True, "target_quiz_id": "q1"})["target_quiz_id"] == "q1"
    event = {"tool_call": "generate_quiz", "revises_current": True, "target_quiz_id": None, "instruction": ""}
    complete_typed_event(event, active_quiz={"id": "q1"}, last_user="Make question 3 harder")
    assert event["target_quiz_id"] == "q1"
    assert event["instruction"] == "Make question 3 harder"
    revision = {"tool_call": "generate_lesson_plan", "action": "revise_week", "target_plan_id": None, "instruction": ""}
    complete_typed_event(revision, active_plan={"id": "p1"}, last_user="Shorten Thursday.")
    assert revision["target_plan_id"] == "p1"
    assert revision["instruction"] == "Shorten Thursday."
    stale = {
        "tool_call": "generate_lesson_plan",
        "action": "revise_week",
        "target_plan_id": "old-plan",
        "instruction": "Add turn-and-talks.",
    }
    complete_typed_event(stale, active_plan={"id": "p1"}, last_user="yes")
    assert stale["target_plan_id"] == "p1"
    day = {"tool_call": "update_lesson_day", "target_plan_id": "old-plan", "day": "Wednesday", "field": "during"}
    complete_typed_event(day, active_plan={"id": "p1"})
    assert day["target_plan_id"] == "p1"
    omitted = validate_quiz_action({})
    assert omitted["num_questions"] == 5
    assert omitted["target_quiz_id"] is None
    assert omitted["revises_current"] is False
    create = validate_plan_action({"action": "create"})
    assert create["target_plan_id"] is None
    assert create["instruction"] == ""
    with_quiz = validate_plan_action({"action": "create", "also_quiz": True, "instruction": "Week on Gatsby and a quiz."})
    assert with_quiz["also_quiz"] is True
    assert validate_plan_action({"action": "create"})["also_quiz"] is False


def test_without_beta_chat_omits_quiz_policy_and_drops_quiz_tools(chat_client):
    from backend.chat_policy import QUIZ_DISABLED_POLICY
    client, captured, emitted = chat_client
    emitted.append({"tool_call": "generate_quiz", "question_types": ["multiple_choice"]})
    result = client.post("/api/chat_stream", json={"messages": [{"role": "user", "content": "make a quiz"}], "chat_id": "chat1"})
    assert result.status_code == 200
    assert "generate_quiz" not in result.text
    assert QUIZ_DISABLED_POLICY.strip()[:40] in captured[0][0]["content"]
    assert "call `generate_quiz`" not in captured[0][0]["content"]


def test_chat_grounds_advice_in_active_standalone_quiz(chat_client, monkeypatch):
    from backend.routes import generate
    client, captured, _ = chat_client
    monkeypatch.setattr(generate, "beta_features_for", lambda uid: True)
    monkeypatch.setattr(generate.db, "get_quiz", lambda *a: {"id": "q1", "class_id": "c1", "quiz_json": {"title": "Inference on paper"}})
    client.post('/api/chat_stream', json={"messages": [], "chat_id": "chat1", "class_id": "c1", "active_quiz_id": "q1"})
    assert "Active target_quiz_id: q1" in captured[0][0]["content"]
    assert "Inference on paper" in captured[0][0]["content"]


def test_wrong_quiz_target_never_leaves_chat_route(chat_client, monkeypatch):
    from backend.routes import generate
    client, _, emitted = chat_client
    monkeypatch.setattr(generate, "beta_features_for", lambda uid: True)
    emitted.append({"tool_call": "generate_quiz", "revises_current": True, "target_quiz_id": "wrong"})
    result = client.post('/api/chat_stream', json={"messages": [], "chat_id": "chat1"})
    assert "invalid_quiz_target" in result.text
    assert '"tool_call"' not in result.text


def test_quiz_question_revision_preserves_unrelated_questions_and_passage():
    from backend.chat_policy import preserve_quiz_scope
    original = {"title": "Inference", "passages": [{"text": "Teacher text"}], "questions": [{"prompt": "Keep"}, {"prompt": "Revise"}, {"prompt": "Also keep"}]}
    model = {"title": "Unwanted title", "passages": [], "questions": [{"prompt": "Unwanted"}, {"prompt": "Improved inference"}, {"prompt": "Unwanted"}]}
    result = preserve_quiz_scope(original, model, [1])
    assert result == {**original, "questions": [original["questions"][0], model["questions"][1], original["questions"][2]]}
    assert original["questions"][1]["prompt"] == "Revise"
    with pytest.raises(AppError):
        preserve_quiz_scope(original, {"questions": []}, [1])


def test_quiz_creation_prompt_receives_prior_constraints(monkeypatch):
    seen = []
    monkeypatch.setattr(llm, "custom_instructions_for", lambda *a: "")
    monkeypatch.setattr(llm, "class_custom_instructions_for", lambda *a: "")
    monkeypatch.setattr(llm, "_cached_completion", lambda *a, **kw: seen.append(kw["messages"]) or '{"questions": []}')
    llm.generate_passage_quiz("u", subject="ELA", grade="8", question_types=["multiple_choice"], num_questions=5,
                              instruction="Assess inference in five minutes with accessible wording and paper only.")
    assert "five minutes with accessible wording and paper only" in seen[0][0]["content"]


def test_missing_generation_job_does_not_restart_on_stream_retry(chat_client, monkeypatch):
    from backend.routes import generate
    client, _, _ = chat_client
    monkeypatch.setattr(generate, "get_job", lambda *a: None)
    with pytest.raises(AppError) as error:
        client.post('/api/generate_stream', json={"query": "Build an inference week", "request_id": "lost-job", "attempt": 1})
    assert error.value.code == "generation_interrupted"
