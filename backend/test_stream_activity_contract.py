import json

from backend.routes.generate import ChatStreamRequest, GenerateRequest, _activity_sse


def _event(raw: str) -> dict:
    return json.loads(raw.removeprefix("data: ").strip())


def test_activity_sse_contains_stable_lifecycle_envelope():
    event = _event(_activity_sse(
        {"status": "retrieving", "label": "Sources ready"},
        "request-1",
        step="retrieval",
        step_state="complete",
        artifact_type="research",
        attempt=2,
    ))

    assert event["request_id"] == "request-1"
    assert event["run_id"] == "request-1"
    assert event["status"] == "retrieving"
    assert event["label"] == "Sources ready"
    assert event["step"] == "retrieval"
    assert event["step_state"] == "complete"
    assert event["artifact_type"] == "research"
    assert event["attempt"] == 2


def test_stream_requests_preserve_logical_request_and_attempt():
    plan = GenerateRequest(query="Build next week", request_id="request-2", attempt=1)
    chat = ChatStreamRequest(messages=[], request_id="request-2", attempt=1)

    assert plan.request_id == chat.request_id == "request-2"
    assert plan.attempt == chat.attempt == 1
