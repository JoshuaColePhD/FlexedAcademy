#!/usr/bin/env python3
"""Regression checks for the grounded voice turn boundary.

This is intentionally a small contract test: the browser owns realtime audio,
while the normal ChatPage/chat_stream path owns curriculum reasoning and chat
persistence.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

from backend.deps import get_current_user  # noqa: E402
from backend.server import app  # noqa: E402
from backend.routes import generate  # noqa: E402


def main() -> int:
    captured: dict[str, object] = {}
    original_prompt, original_entitlement = generate._build_chat_system_prompt, generate.require_entitlement
    original_post = None

    class Response:
        status_code = 200

        def json(self):
            return {"value": "ephemeral-token", "expires_at": 123}

    def fake_prompt(user_id, chat_id, week_number, mode, last_user=""):
        captured["context"] = (user_id, chat_id, week_number, mode)
        return "grounded context"

    def fake_entitlement(_user_id):
        return None

    def fake_post(url, **kwargs):
        captured["url"] = url
        captured["payload"] = kwargs["json"]
        return Response()

    import requests

    original_post = requests.post
    generate._build_chat_system_prompt = fake_prompt
    generate.require_entitlement = fake_entitlement
    requests.post = fake_post
    app.dependency_overrides[get_current_user] = lambda: "teacher-1"
    try:
        response = TestClient(app).post(
            "/api/voice/session",
            json={"chat_id": "chat-7", "week_number": 7, "mode": "brainstorm"},
        )
        assert response.status_code == 200, response.text
        assert captured["context"] == ("teacher-1", "chat-7", 7, "brainstorm")
        session = captured["payload"]["session"]
        assert "tools" not in session
        assert session["audio"]["input"]["transcription"] == {"model": "whisper-1"}
        assert session["audio"]["input"]["turn_detection"] == {
            "type": "server_vad",
            "create_response": False,
        }

        root = Path(__file__).resolve().parent.parent
        source = (root / "frontend/src/pages/ChatPage.jsx").read_text()
        provider = (root / "frontend/src/components/VoiceProvider.jsx").read_text()
        panel = (root / "frontend/src/components/VoiceModePanel.jsx").read_text()
        queue = (root / "frontend/src/lib/voiceSpeechQueue.js").read_text()
        llm = (root / "backend/llm.py").read_text()
        config = (root / "backend/config.py").read_text()
        assert "voice:transcript" not in source
        assert "voice.speak(sentence)" in source
        assert "submitRef.current(text, { voiceTurn: true })" in source
        assert "startSession" in provider and "stopSession" in provider
        assert "localStorage" not in provider
        assert "getUserMedia" not in panel and "AudioWorklet" not in panel and "MediaRecorder" not in panel
        assert "track.enabled" in provider and "response.cancel" in queue
        assert "Promise.all([sessionPromise, mediaPromise])" in provider
        assert "CONNECT_TIMEOUT_MS" in provider and "connection was lost" in provider
        assert "interrupted" in provider and "Stopped — listening to you." in panel
        assert "Needs attention" in panel and "Hands-free" in panel
        assert "onInterrupt" not in source and "onFalseInterrupt" not in source
        assert "model=settings.voice_chat_model if voice else settings.openai_model" in llm
        assert "voice_chat_model: str = \"gpt-5-mini\"" in config
        assert "CONVERSATION HISTORY" not in generate._build_chat_system_prompt.__code__.co_consts
        print("PASSED — Realtime is transport-only and voice turns use ChatPage submit.")
        return 0
    finally:
        generate._build_chat_system_prompt = original_prompt
        generate.require_entitlement = original_entitlement
        if original_post is not None:
            requests.post = original_post
        app.dependency_overrides.pop(get_current_user, None)


if __name__ == "__main__":
    raise SystemExit(main())
