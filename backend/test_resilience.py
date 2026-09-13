"""CircuitBreaker unit tests, plus one integration check that llm.py's OpenAI
call sites actually route through it rather than calling the client directly."""
from __future__ import annotations

import time

import pytest

from backend.errors import AppError
from backend.resilience import CircuitBreaker


class _ConnErr(Exception):
    pass


class _OtherErr(Exception):
    pass


def test_closed_by_default_and_passes_through_success():
    breaker = CircuitBreaker("t", failure_threshold=3, reset_after_s=10)
    assert breaker.call(lambda: "ok", trips_on=(_ConnErr,)) == "ok"
    assert breaker.status().state == "closed"
    assert breaker.status().consecutive_failures == 0


def test_opens_after_threshold_consecutive_failures():
    breaker = CircuitBreaker("t", failure_threshold=3, reset_after_s=10)
    for _ in range(3):
        with pytest.raises(_ConnErr):
            breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    assert breaker.status().state == "open"
    assert breaker.status().consecutive_failures == 3


def test_open_circuit_fails_fast_without_calling_fn():
    breaker = CircuitBreaker("t", failure_threshold=1, reset_after_s=10)
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    assert breaker.status().state == "open"

    calls = []
    with pytest.raises(AppError) as exc_info:
        breaker.call(lambda: calls.append(1) or "should not run", trips_on=(_ConnErr,))
    assert exc_info.value.code == "openai_unavailable"
    assert calls == []


def test_a_success_resets_the_failure_count():
    breaker = CircuitBreaker("t", failure_threshold=3, reset_after_s=10)
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    assert breaker.status().consecutive_failures == 2
    assert breaker.call(lambda: "ok", trips_on=(_ConnErr,)) == "ok"
    assert breaker.status().consecutive_failures == 0
    assert breaker.status().state == "closed"


def test_non_tripping_exception_passes_through_without_opening():
    breaker = CircuitBreaker("t", failure_threshold=1, reset_after_s=10)
    with pytest.raises(_OtherErr):
        breaker.call(_raise(_OtherErr("bad request")), trips_on=(_ConnErr,))
    assert breaker.status().state == "closed"
    assert breaker.status().consecutive_failures == 0


def test_half_open_probe_success_closes_the_circuit():
    breaker = CircuitBreaker("t", failure_threshold=1, reset_after_s=0.05)
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    assert breaker.status().state == "open"
    time.sleep(0.06)
    assert breaker.status().state == "half_open"
    assert breaker.call(lambda: "recovered", trips_on=(_ConnErr,)) == "recovered"
    assert breaker.status().state == "closed"


def test_half_open_probe_failure_reopens_and_restarts_cooldown():
    breaker = CircuitBreaker("t", failure_threshold=1, reset_after_s=0.05)
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("down")), trips_on=(_ConnErr,))
    time.sleep(0.06)
    assert breaker.status().state == "half_open"
    with pytest.raises(_ConnErr):
        breaker.call(_raise(_ConnErr("still down")), trips_on=(_ConnErr,))
    assert breaker.status().state == "open"


def _raise(exc):
    def fn():
        raise exc
    return fn


# ---------------------------------------------------------------------------
# The document-build/codegen worker loops' own backoff, not CircuitBreaker —
# these loops must keep retrying forever (a queued job still needs to run
# eventually), just with growing patience instead of hammering every fixed
# interval. See server.py's own comment for the production incident this
# fixes.
# ---------------------------------------------------------------------------


def test_worker_poll_delay_is_unchanged_with_no_errors():
    from backend.server import _worker_poll_delay
    assert _worker_poll_delay(2, 0) == 2


def test_worker_poll_delay_doubles_per_consecutive_error_and_caps():
    from backend.server import _worker_poll_delay
    assert _worker_poll_delay(2, 1) == 4
    assert _worker_poll_delay(2, 2) == 8
    assert _worker_poll_delay(2, 3) == 16
    assert _worker_poll_delay(2, 20) == 60  # _WORKER_MAX_BACKOFF_S


# ---------------------------------------------------------------------------
# /api/health surfaces the breaker's live state — the no-Sentry-required way
# to see "is the AI dependency degraded right now" without external tooling.
# ---------------------------------------------------------------------------


def test_health_reports_openai_circuit_state(monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend.routes import misc

    monkeypatch.setattr(misc.db, "_row", lambda *a, **kw: {"n": 0})
    monkeypatch.setattr(misc.docx_build, "builder_template", lambda *a, **kw: "florence-docx-v2")

    app = FastAPI()
    app.include_router(misc.router)
    app.dependency_overrides[misc.get_current_user_optional] = lambda: "u1"
    with TestClient(app) as client:
        response = client.get("/api/health")
    assert response.status_code == 200
    circuit = response.json()["openai_circuit"]
    assert circuit["state"] == "closed"
    assert circuit["consecutive_failures"] == 0


# ---------------------------------------------------------------------------
# Integration: llm.py's chat/generation call sites actually go through the
# shared breaker, not straight to client().chat.completions.create.
# ---------------------------------------------------------------------------


def test_stream_plan_revision_trips_the_shared_breaker(monkeypatch):
    from backend import llm

    monkeypatch.setattr(llm, "_OPENAI_BREAKER", CircuitBreaker("openai_chat", failure_threshold=1, reset_after_s=10))
    monkeypatch.setattr(llm, "_prompt_subject_grade", lambda *a, **kw: ("ELA", "9"))
    monkeypatch.setattr(llm, "day_names_for_school", lambda *a, **kw: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"])

    call_count = {"n": 0}

    class _FakeCompletions:
        def create(self, **kwargs):
            call_count["n"] += 1
            raise llm.APIConnectionError(request=None)

    class _FakeClient:
        chat = type("Chat", (), {"completions": _FakeCompletions()})()

    monkeypatch.setattr(llm, "client", lambda: _FakeClient())

    with pytest.raises(llm.APIConnectionError):
        next(llm.stream_plan_revision("u1", {"days": []}, "", None, school_id="s1", class_id=None))
    assert call_count["n"] == 1

    # Breaker is now open (threshold=1) — a second call must fail fast as
    # AppError, WITHOUT invoking the fake client's create() again.
    with pytest.raises(AppError) as exc_info:
        next(llm.stream_plan_revision("u1", {"days": []}, "", None, school_id="s1", class_id=None))
    assert exc_info.value.code == "openai_unavailable"
    assert call_count["n"] == 1
