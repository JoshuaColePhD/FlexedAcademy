"""Regression tests for the recruiter demo's server-side write boundary."""
from __future__ import annotations

import asyncio

from backend import server


def _run_request(middleware, method: str, path: str, *, cookie: bool = True):
    messages = []
    downstream_called = False
    headers = [(b"cookie", b"aplang_session=demo-token")] if cookie else []
    scope = {
        "type": "http",
        "method": method,
        "path": path,
        "headers": headers,
        "query_string": b"",
        "scheme": "https",
        "server": ("testserver", 443),
        "client": ("127.0.0.1", 1),
        "root_path": "",
        "http_version": "1.1",
    }

    async def receive():
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    async def downstream(scope, receive, send):
        nonlocal downstream_called
        downstream_called = True
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"ok"})

    middleware.app = downstream
    asyncio.run(middleware(scope, receive, send))
    return messages, downstream_called


def test_demo_blocks_mutations_but_allows_reads_and_logout(monkeypatch):
    monkeypatch.setattr(server, "_verify_current", lambda token: "demo")
    monkeypatch.setattr(server.db, "get_user_by_id", lambda user_id: {"is_read_only": True})
    middleware = server.ReadOnlyDemoMiddleware(None)

    blocked, called = _run_request(middleware, "POST", "/api/chats")
    assert blocked[0]["status"] == 403
    assert b"demo_read_only" in blocked[1]["body"]
    assert not called

    read, called = _run_request(middleware, "GET", "/api/plans")
    assert read[0]["status"] == 200
    assert called

    logout, called = _run_request(middleware, "POST", "/api/auth/logout")
    assert logout[0]["status"] == 200
    assert called
