"""No-network voice transport and consultation-capacity regressions."""
from types import SimpleNamespace

import pytest
import requests

from backend import features
from backend.errors import AppError
from backend.generation_queue import GenerationQueue
from backend.routes import generate


def test_voice_session_is_transport_only_with_manual_response_control(monkeypatch):
    calls = []
    monkeypatch.setattr(generate, "require_entitlement", lambda _: None)
    monkeypatch.setattr(generate, "require_voice_beta", lambda _: None)
    monkeypatch.setattr(generate, "_build_chat_system_prompt", lambda *_args, **_kwargs: pytest.fail("Session startup must not perform planning"))
    def post(url, **kwargs):
        calls.append((url, kwargs))
        return SimpleNamespace(status_code=200, json=lambda: {"value": "test-ephemeral-token", "expires_at": 123})
    monkeypatch.setattr(requests, "post", post)
    result = generate.voice_session.__wrapped__(generate.VoiceSessionRequest(chat_id="chat", class_id="class"), request=None, user_id="u")
    assert result["token"] == "test-ephemeral-token" and result["expires_at"] == 123
    url, request = calls[0]
    assert url == "https://api.openai.com/v1/realtime/client_secrets"
    session = request["json"]["session"]
    assert session["type"] == "realtime" and session["model"] == result["model"]
    assert not session.get("tools") and "instructions" not in session
    transcription = session["audio"]["input"]["transcription"]
    assert transcription["model"] == "gpt-4o-mini-transcribe" and transcription["language"] == "en"
    assert "rhetorical analysis" in transcription["prompt"]
    detection = session["audio"]["input"]["turn_detection"]
    assert detection["type"] == "semantic_vad" and detection["eagerness"] == "medium"
    assert result["turn_detection"] == detection
    assert detection["create_response"] is False and detection["interrupt_response"] is False
    assert request["timeout"] == generate.settings.realtime_session_timeout_s


def test_voice_session_checks_entitlement_before_provider_call(monkeypatch):
    def denied(_):
        raise AppError("trial_expired", "Trial ended", status=402)
    monkeypatch.setattr(generate, "require_entitlement", denied)
    monkeypatch.setattr(requests, "post", lambda *_args, **_kwargs: pytest.fail("No provider call when entitlement is denied"))
    with pytest.raises(AppError) as error:
        generate.voice_session.__wrapped__(generate.VoiceSessionRequest(), request=None, user_id="u")
    assert error.value.status == 402


def test_voice_session_requires_beta_before_provider_call(monkeypatch):
    monkeypatch.setattr(generate, "require_entitlement", lambda _: None)
    def denied(_):
        raise AppError("voice_disabled", "Voice is disabled", status=403)
    monkeypatch.setattr(generate, "require_voice_beta", denied)
    monkeypatch.setattr(requests, "post", lambda *_args, **_kwargs: pytest.fail("No provider call when voice beta is disabled"))
    with pytest.raises(AppError) as error:
        generate.voice_session.__wrapped__(generate.VoiceSessionRequest(), request=None, user_id="u")
    assert error.value.code == "voice_disabled"
    assert error.value.status == 403


def test_voice_beta_gate_uses_the_saved_beta_features_setting(monkeypatch):
    monkeypatch.setattr(features.db, "get_user_by_id", lambda _: {"beta_features": False})
    with pytest.raises(AppError, match="Voice conversations are a beta feature"):
        features.require_voice_beta("u")
    monkeypatch.setattr(features.db, "get_user_by_id", lambda _: {"beta_features": True})
    features.require_voice_beta("u")


def test_voice_chat_stream_requires_beta_before_starting_work(monkeypatch):
    monkeypatch.setattr(generate, "require_entitlement", lambda _: None)
    def denied(_):
        raise AppError("voice_disabled", "Voice is disabled", status=403)
    monkeypatch.setattr(generate, "require_voice_beta", denied)
    with pytest.raises(AppError) as error:
        generate.chat_stream.__wrapped__(
            generate.ChatStreamRequest(messages=[], voice=True),
            request=None,
            bg_tasks=None,
            user_id="u",
        )
    assert error.value.code == "voice_disabled"


def test_consultation_queue_bounds_teacher_and_global_capacity():
    queue = GenerationQueue(max_concurrent=2, max_per_user=1, max_queue=5, max_queue_per_user=2, min_start_interval=0)
    first, same_teacher, other_teacher = [queue.enqueue(owner) for owner in ("a", "a", "b")]
    try:
        assert first.wait(timeout=0)
        assert not same_teacher.wait(timeout=0)
        assert other_teacher.wait(timeout=0)
        third_teacher = queue.enqueue("c")
        try:
            assert not third_teacher.wait(timeout=0)
        finally:
            third_teacher.cancel()
    finally:
        same_teacher.cancel()
        first.release()
        other_teacher.release()


def test_pending_work_request_is_context_only_and_defaults_off():
    assert generate.ChatStreamRequest(messages=[]).plan_work_pending is False
    assert generate.ChatStreamRequest(messages=[], voice=True, plan_work_pending=True).plan_work_pending is True
