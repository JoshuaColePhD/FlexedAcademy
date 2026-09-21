"""Fault injection for lesson validation, chat stalls, and provider outages. No I/O."""
import asyncio
import copy
import json
import threading
import time
from types import SimpleNamespace as N

import httpx
import openai
import pytest
from fastapi import BackgroundTasks

from backend import llm, retrieval, service
from backend.generation_jobs import CancellationToken
from backend.generation_queue import GenerationQueue
from backend.routes import generate
from backend.schema import SchemaError
from backend.test_accuracy_guards import _act_result, _full_day, _week

ALIGNMENT = (
    "E.TOD.301 Determine whether material is relevant to the focus of the paragraph. "
    "Supports primary [RHS-1A]: both assess relevant evidence."
)


@pytest.fixture(autouse=True)
def offline_corpus(monkeypatch):
    """The audit uses a reference inventory, never gitignored local files."""
    primary = frozenset({"RHS-1A", "SKILL CATEGORY 7"})
    act = frozenset({"E.TOD.301", "R.WME.701"})
    inventory = retrieval._CodeInventory(
        anywhere=primary | act, by_course={"AP_Lang": primary},
        by_course_and_grade={}, act=act,
    )
    monkeypatch.setattr(retrieval, "_code_inventory", lambda: inventory)


def audit(plan):
    result = _act_result()
    result.chunks[0]["distance"] = 0.0
    return service._audit_generated_plan(
        "owner", plan, result, allowed=result.codes, subject_code="AP_Lang", act_expected=True,
    )


def test_missing_primary_link_repairs_every_day_once_without_changing_lesson(monkeypatch):
    plan = _week(_full_day(act_alignment=ALIGNMENT.split(" Supports")[0]))
    plan["days"].append({**plan["days"][0], "name": "Tuesday"})
    original = copy.deepcopy(plan)
    calls = []

    def repair(owner, draft, context, **kwargs):
        calls.append(kwargs)
        assert draft == original and "E.TOD.301" in context
        return [{"name": day["name"], "act_alignment": ALIGNMENT} for day in draft["days"]]

    monkeypatch.setattr(llm, "repair_act_alignments", repair)
    repaired, _ = audit(plan)
    assert len(calls) == 1
    assert "does not name the primary standard" in calls[0]["feedback"]
    assert plan == original
    for before, after in zip(plan["days"], repaired["days"]):
        assert after == {**before, "act_alignment": ALIGNMENT}


def test_valid_plan_does_not_make_a_repair_call(monkeypatch):
    monkeypatch.setattr(llm, "repair_act_alignments", lambda *a, **kw: pytest.fail("Already valid"))
    plan = _week(_full_day(act_alignment=ALIGNMENT))
    repaired, _ = audit(plan)
    assert repaired is plan


def test_reported_poe_alignment_passes_without_paid_repair(monkeypatch):
    monkeypatch.setattr(llm, "repair_act_alignments", lambda *a, **kw: pytest.fail("Formatting must not require a model call"))
    description = "Analyze how the choice of a specific word or phrase shapes meaning or tone in passages when the effect is subtle or complex."
    result = _act_result("R.WME.701", description)
    plan = _week(_full_day(
        standards="Skill Category 7 -- Explain how writers' stylistic choices contribute to the purpose of an argument.",
        act_alignment=(
            f"R.WME.701 -- {description} Supports primary Skill Category 7: "
            "Students examine Poe’s precise word choices and explain how they shape the narrator’s tone and rhetorical effect."
        ),
    ))
    checked, _ = service._audit_generated_plan(
        "owner", plan, result, allowed={"Skill Category 7", "R.WME.701"},
        subject_code="AP_Lang", act_expected=True,
    )
    assert checked is plan


@pytest.mark.parametrize("replacement", [
    [],
    [{"name": "Monday", "act_alignment": ALIGNMENT, "during": "Overwrite activity"}],
    [{"name": "Tuesday", "act_alignment": ALIGNMENT}],
    [{"name": "Monday", "act_alignment": "Made-up skill E.TOD.999"}],
    [{"name": "Monday", "act_alignment": ALIGNMENT.split(" Supports")[0]}],
])
def test_bad_repairs_cannot_overwrite_content_or_bypass_grounding(monkeypatch, replacement):
    calls = []
    monkeypatch.setattr(llm, "repair_act_alignments", lambda *a, **kw: calls.append(True) or replacement)
    plan = _week(_full_day(act_alignment=""))
    original = copy.deepcopy(plan)
    with pytest.raises(SchemaError):
        audit(plan)
    assert calls == [True]
    assert plan == original


def test_other_accuracy_errors_are_not_repaired_as_act_cells(monkeypatch):
    monkeypatch.setattr(llm, "repair_act_alignments", lambda *a, **kw: pytest.fail("Wrong repair scope"))
    with pytest.raises(SchemaError, match="primary Standards row"):
        audit(_week(_full_day(standards="E.TOD.301", act_alignment=ALIGNMENT)))


def test_act_repair_is_bounded_and_uses_reference_sources(monkeypatch):
    calls = []
    monkeypatch.setattr(llm, "_cached_completion", lambda *a, **kw: calls.append(kw) or '{"days": []}')
    llm.repair_act_alignments("owner", {}, "Source skill wording", subject_code="AP_Lang", feedback="Missing link")
    assert calls[0]["timeout"] == 30 and calls[0]["skip_cache"] is True
    payload = json.loads(calls[0]["messages"][1]["content"])
    assert payload["retrieved_standards"] == "Source skill wording"
    fields = calls[0]["response_format"]["json_schema"]["schema"]["properties"]["days"]["items"]["properties"]
    assert set(fields) == {"name", "act_alignment"}


@pytest.mark.parametrize(("status", "code", "retryable"), [
    (429, "insufficient_quota", False), (429, "billing_not_active", False),
    (401, "invalid_api_key", False), (400, "unsupported_parameter", False),
    (429, "rate_limit_exceeded", True), (503, "server_error", True),
])
def test_provider_errors_distinguish_permanent_from_transient(status, code, retryable):
    response = httpx.Response(status, request=httpx.Request("POST", "https://example.test"), headers={"Retry-After": "4"})
    error_class = openai.RateLimitError if status == 429 else openai.APIStatusError
    error = error_class("Provider failure", response=response, body={"code": code})
    event = generate._openai_error_event(error)
    assert event["retryable"] is retryable
    if retryable:
        assert event["retry_after_seconds"] == 4


def mock_chat(monkeypatch, context):
    admission = GenerationQueue(max_concurrent=1, max_per_user=1, max_queue=5, max_queue_per_user=2, min_start_interval=0)
    monkeypatch.setattr(generate, "generation_queue", admission)
    monkeypatch.setattr(generate, "_SSE_KEEPALIVE_SECONDS", 0.01)
    monkeypatch.setattr(generate, "require_entitlement", lambda _: None)
    monkeypatch.setattr(generate, "_request_class", lambda *a: None)
    monkeypatch.setattr(generate, "beta_features_for", lambda _: False)
    monkeypatch.setattr(generate, "_build_chat_system_prompt", context)
    monkeypatch.setattr(llm, "stream_chat", lambda *a, **kw: iter([{"chunk": "A useful reply."}]))
    return admission


def chat_response():
    return generate.chat_stream.__wrapped__(
        generate.ChatStreamRequest(messages=[], request_id="slow-context"),
        request=None, bg_tasks=BackgroundTasks(), user_id="owner",
    )


def test_context_loading_sends_heartbeats_until_chat_can_reply(monkeypatch):
    def context(*a, **kw):
        assert service.db.current_user_id.get() == "owner"
        time.sleep(0.06)
        return "Teacher context"

    admission = mock_chat(monkeypatch, context)

    async def collect():
        return [event async for event in chat_response().body_iterator]

    events = asyncio.run(collect())
    preparing = next(i for i, event in enumerate(events) if '"preparing_context"' in event)
    ready = next(i for i, event in enumerate(events) if '"context_ready"' in event)
    assert ": keepalive\n\n" in events[preparing + 1:ready]
    assert any('"done": true' in event for event in events)
    assert admission._active == 0


def test_disconnect_during_context_keeps_capacity_until_worker_exits(monkeypatch):
    entered, release = threading.Event(), threading.Event()

    def context(*a, **kw):
        entered.set()
        release.wait(timeout=2)
        return "Teacher context"

    admission = mock_chat(monkeypatch, context)
    monkeypatch.setattr(llm, "stream_chat", lambda *a, **kw: pytest.fail("Disconnected requests must not start a paid call"))

    async def disconnect():
        stream = chat_response().body_iterator
        async for event in stream:
            if entered.is_set() and event == ": keepalive\n\n":
                await stream.aclose()
                break

    try:
        asyncio.run(disconnect())
        assert admission._active == 1
    finally:
        release.set()
    deadline = time.monotonic() + 1
    while admission._active and time.monotonic() < deadline:
        time.sleep(0.01)
    assert admission._active == 0


def test_disconnect_while_queued_removes_ticket(monkeypatch):
    admission = mock_chat(monkeypatch, lambda *a, **kw: pytest.fail("Queued request cannot load context"))
    occupied = admission.enqueue("other")
    assert occupied.wait(timeout=0)

    async def disconnect():
        stream = chat_response().body_iterator
        async for event in stream:
            if '"queued"' in event:
                await stream.aclose()
                break

    try:
        asyncio.run(disconnect())
        deadline = time.monotonic() + 1
        while admission._waiters and time.monotonic() < deadline:
            time.sleep(0.01)
        assert not admission._waiters
        assert admission._active == 1
    finally:
        occupied.release()


def test_chat_cancellation_closes_provider_socket_and_stops_consumption(monkeypatch):
    token = CancellationToken()
    closed = threading.Event()

    class Stream:
        def __iter__(self):
            yield N(usage=None, choices=[N(finish_reason=None, delta=N(content="Hello.", tool_calls=None))])
            assert closed.wait(timeout=1)
            yield N(usage=None, choices=[N(finish_reason=None, delta=N(content="Discard this.", tool_calls=None))])

        def close(self):
            closed.set()

    monkeypatch.setattr(llm, "client", lambda: N(chat=N(completions=N(create=lambda **kw: Stream()))))
    monkeypatch.setattr(llm, "beta_features_for", lambda _: False)
    monkeypatch.setattr(llm, "_chat_tools_for", lambda *a, **kw: [])
    monkeypatch.setattr(llm, "output_length_tokens_for", lambda _: 100)
    stream = llm.stream_chat("owner", [], cancellation=token)
    assert next(stream) == {"chunk": "Hello."}
    token.set()
    assert closed.is_set()
    assert list(stream) == []
    assert not token._callbacks
