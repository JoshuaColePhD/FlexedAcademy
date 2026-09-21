import json
from types import SimpleNamespace as NS

import pytest

from backend import conversation as c
from backend.chat_transport import ResponsesChatStream, reasoning_effort
from backend.errors import AppError


def test_followup_retrieves_second_paragraph_from_saved_source():
    saved = [{"id": "reading", "filename": "Poe.txt", "text": "Opening paragraph.\n\nThe second paragraph reveals the narrator's contradiction.\n\nFinal paragraph."}]
    result = c.source_context(saved, "Use the second paragraph for Wednesday.")
    assert "paragraph 2" in result
    assert "narrator's contradiction" in result
    assert "source:reading" in result


def test_source_retrieval_finds_late_passage_in_long_document():
    saved = [{"id": "reading", "filename": "Guide.txt", "text": "\n\n".join(["Routine opening." * 70] * 30 + ["Wednesday's seminar must include a counterargument rehearsal."])}]
    result = c.source_context(saved, "What does the guide require for Wednesday's counterargument rehearsal?", budget=4000)
    assert "must include a counterargument rehearsal" in result
    assert len(result) < 4500


def test_latest_paragraph_reference_overrides_earlier_request():
    saved = [{"id": "reading", "filename": "Reading.txt", "text": "First passage.\n\n" + "Earlier paragraph. " * 20 + "\n\nThe corrected passage to use."}]
    result = c.source_context(saved, "Use the second paragraph. Actually, use the third paragraph.", budget=210)
    assert "corrected passage" in result


def test_long_plan_keeps_friday_and_complete_requested_day():
    plan = {"days": [{"name": name, "during": "Detailed teaching. " * 1300 + name + " END", "assessment": "Keep this exit ticket."} for name in ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"]]}
    packed = json.loads(c.plan_context(plan, "Explain Friday's activity."))
    assert len(packed["days"]) == 5
    assert packed["days"][4] == plan["days"][4]
    assert packed["days"][0]["name"] == "Monday"


def test_short_history_is_unchanged_and_needs_no_model():
    history = [{"role": "user", "content": "Keep Friday unchanged."}]
    assert c.compact_history("u", None, history, lambda *_: pytest.fail("unneeded compaction")) == ("", history)


def test_compaction_cache_is_bound_to_exact_history(monkeypatch):
    chat = {"id": "c"}
    monkeypatch.setattr(c.db, "get_chat", lambda *_: chat)
    monkeypatch.setattr(c.db, "_write", lambda _sql, args: chat.update(planning_state_json=json.loads(args[0])))
    history = [{"role": "user" if i % 2 == 0 else "assistant", "content": f"Turn {i}: " + "details " * 250} for i in range(24)]
    calls = []
    def summarize(previous, older):
        calls.append((previous, older))
        return {"summary": "Four-day week", "constraints": ["Keep Friday unchanged."]}
    record, recent = c.compact_history("u", "c", history, summarize)
    assert "Keep Friday unchanged" in record
    assert recent == history[-16:]
    assert len(calls) == 1
    c.compact_history("u", "c", history, summarize)
    assert len(calls) == 1
    changed = [{**history[0], "content": "Friday is now a teaching day."}, *history[1:]]
    c.compact_history("u", "c", changed, summarize)
    assert len(calls) == 2 and calls[-1][0] is None


def test_failed_compaction_never_silently_drops_history():
    history = [{"role": "user", "content": "x" * 2500} for _ in range(30)]
    with pytest.raises(AppError, match="restore the conversation"):
        c.compact_history("u", None, history, lambda *_: {})


def test_few_large_exchanges_are_compacted_without_cutting_latest_message():
    history = [{"role": "user" if index % 2 == 0 else "assistant", "content": str(index) + "x" * 15_000} for index in range(6)]
    record, recent = c.compact_history("u", None, history, lambda *_: {"summary": "Keep the original constraint."})
    assert "original constraint" in record and recent == history[-2:]


def test_reasoning_increases_for_instructional_judgment():
    assert reasoning_effort([{"role": "user", "content": "Compare these approaches and recommend one."}]) == "medium"
    assert reasoning_effort([{"role": "user", "content": "Yes, do that."}]) == "low"


class Events:
    def __init__(self, events):
        self.events, self.closed = events, False
    def __iter__(self):
        return iter(self.events)
    def close(self):
        self.closed = True


def test_responses_tools_reasoning_stream_and_usage():
    item = NS(type="function_call", id="call1", name="update_lesson_day", arguments='{"day":"Friday"}')
    events = Events([
        NS(type="response.output_text.delta", delta="I'll update Friday."),
        NS(type="response.output_item.added", item=item),
        NS(type="response.function_call_arguments.delta", delta='{"day":"Friday"}'),
        NS(type="response.output_item.done", item=item),
        NS(type="response.completed", response=NS(usage=NS(input_tokens=20, output_tokens=8, input_tokens_details=NS(cached_tokens=10)))),
    ])
    calls = []
    client = NS(responses=NS(create=lambda **kwargs: calls.append(kwargs) or events))
    stream = ResponsesChatStream(client, model="gpt-5.6-luna", messages=[{"role": "user", "content": "Update Friday"}], effort="medium", max_tokens=4000, tools=[{"function": {"name": "update_lesson_day", "parameters": {"type": "object"}}}])
    chunks = list(stream)
    assert calls[0]["reasoning"] == {"effort": "medium"}
    assert calls[0]["store"] is False and calls[0]["tools"][0]["strict"] is False
    assert chunks[-2].choices[0].finish_reason == "tool_calls"
    assert chunks[-1].usage.prompt_tokens == 20
    stream.close()
    assert events.closed


def test_incomplete_response_never_dispatches_artifact():
    item = NS(type="function_call", id="c1", name="generate_lesson_plan", arguments='{}')
    events = Events([NS(type="response.output_item.added", item=item), NS(type="response.output_item.done", item=item), NS(type="response.incomplete")])
    stream = ResponsesChatStream(NS(responses=NS(create=lambda **_: events)), model="m", messages=[], effort="low", max_tokens=2000, tools=[])
    observed = []
    with pytest.raises(AppError):
        observed.extend(stream)
    assert not any(choice.finish_reason == "tool_calls" for chunk in observed for choice in chunk.choices)
