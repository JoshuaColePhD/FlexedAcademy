"""POST /api/chat/flag: the one-click escalation path for a bad AI reply.

Reuses the support-thread pipeline (see routes/misc.py's `_create_support_thread`)
rather than a parallel review queue, so this mostly tests that the flagged
content and context get assembled into that thread correctly.
"""
from __future__ import annotations

import pytest


@pytest.fixture
def flag_client(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routes import misc

    created = []
    monkeypatch.setattr(misc.db, "get_user_by_id", lambda uid: {"email": "t@example.com", "name": "Teacher"})
    monkeypatch.setattr(
        misc.db,
        "create_support_thread",
        lambda user_id, *, subject, body, author_name, author_email: (
            created.append({"user_id": user_id, "subject": subject, "body": body}),
            {"id": "thread-1", "subject": subject},
        )[1],
    )
    monkeypatch.setattr(misc.mail, "send", lambda **kw: True)

    app = FastAPI()
    app.include_router(misc.router)
    app.dependency_overrides[misc.get_current_user] = lambda: "u1"
    app.state.limiter = misc.limiter
    with TestClient(app) as client:
        yield client, created


def test_flag_creates_a_support_thread_with_context_and_content(flag_client):
    client, created = flag_client
    response = client.post(
        "/api/chat/flag",
        json={
            "chat_id": "chat1",
            "message_content": "This week covers RL.9-10.1, which doesn't exist.",
            "context": "Plan a week on close reading.",
        },
    )
    assert response.status_code == 200
    assert response.json()["thread_id"] == "thread-1"
    assert len(created) == 1
    assert created[0]["subject"] == "Flagged AI response"
    assert "chat1" in created[0]["body"]
    assert "Plan a week on close reading." in created[0]["body"]
    assert "RL.9-10.1" in created[0]["body"]


def test_flag_without_context_or_chat_id_still_works(flag_client):
    client, created = flag_client
    response = client.post(
        "/api/chat/flag",
        json={"message_content": "Some unhelpful answer."},
    )
    assert response.status_code == 200
    assert "Some unhelpful answer." in created[0]["body"]


def test_flag_rejects_empty_message_content(flag_client):
    client, _created = flag_client
    response = client.post("/api/chat/flag", json={"message_content": ""})
    assert response.status_code == 422
