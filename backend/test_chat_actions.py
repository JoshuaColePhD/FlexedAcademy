"""No-network regression coverage for typed routing and streamed arguments."""

import json
from copy import deepcopy
from types import SimpleNamespace as NS

import pytest

from backend import llm, service
from backend.chat_policy import typed_chat_tools, validate_action_target, validate_plan_action
from backend.errors import AppError


def action(**overrides):
    return dict(
        action="create",
        target_plan_id=None,
        instruction="Plan rhetorical analysis with paper materials and a 45-minute period.",
        days=[],
        field=None,
        week_number=3,
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
    assert "action" in typed["generate_lesson_plan"]["parameters"]["required"]
    assert typed["generate_lesson_plan"]["parameters"]["required"] == ["action"]
    quiz_required = typed["generate_quiz"]["parameters"].get("required") or []
    assert "instruction" not in quiz_required
    assert "target_quiz_id" not in quiz_required


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
    return stream


def test_stream_waits_for_complete_action(monkeypatch):
    stream = fake_stream(monkeypatch, json.dumps(action()))
    events = list(llm.stream_chat("u", []))
    assert events == [{"tool_call": "generate_lesson_plan", **action()}]
    assert stream.closed


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

    captured = []
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
    monkeypatch.setattr(generate.llm, "extract_and_persist_coaching_memory", lambda *a: None)

    def stream(user, messages, **kw):
        captured.append(messages)
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


def test_route_rejects_foreign_plan_before_model_call(chat_client):
    client, captured, _ = chat_client
    response = client.post(
        "/api/chat_stream",
        json={"messages": [], "chat_id": "chat1", "class_id": "c1", "active_plan_id": "foreign"},
    )
    assert "invalid_plan_target" in response.text
    assert not captured


def test_route_does_not_emit_wrong_target_action(chat_client):
    client, _, emitted = chat_client
    emitted.append(
        {
            "tool_call": "generate_lesson_plan",
            **action(),
            "action": "revise_week",
            "target_plan_id": "wrong",
        }
    )
    response = client.post(
        "/api/chat_stream",
        json={"messages": [], "chat_id": "chat1", "class_id": "c1", "active_plan_id": "p1"},
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
    omitted = validate_quiz_action({})
    assert omitted["num_questions"] == 5
    assert omitted["target_quiz_id"] is None
    assert omitted["revises_current"] is False
    create = validate_plan_action({"action": "create"})
    assert create["target_plan_id"] is None
    assert create["instruction"] == ""


def test_chat_grounds_advice_in_active_standalone_quiz(chat_client, monkeypatch):
    from backend.routes import generate
    client, captured, _ = chat_client
    monkeypatch.setattr(generate.db, "get_quiz", lambda *a: {"id": "q1", "class_id": "c1", "quiz_json": {"title": "Inference on paper"}})
    client.post('/api/chat_stream', json={"messages": [], "chat_id": "chat1", "class_id": "c1", "active_quiz_id": "q1"})
    assert "Active target_quiz_id: q1" in captured[0][0]["content"]
    assert "Inference on paper" in captured[0][0]["content"]


def test_wrong_quiz_target_never_leaves_chat_route(chat_client):
    client, _, emitted = chat_client
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
