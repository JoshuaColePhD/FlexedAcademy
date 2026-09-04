"""Fast, database-free account-isolation contracts.

The older eval/test_security_contracts.py intentionally writes throwaway rows
to a real DATABASE_URL and remains a manual production-readiness check. These
tests exercise the HTTP authorization boundaries with small in-memory doubles,
so CI can verify the most important two-account guarantees on every change.
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from backend import db
from backend.config import settings
from backend.deps import get_current_user
from backend.server import app


def _client(monkeypatch, user_id: str) -> TestClient:
    app.dependency_overrides[get_current_user] = lambda: user_id
    return TestClient(app, raise_server_exceptions=False)


def _clear_overrides() -> None:
    app.dependency_overrides.clear()


def test_standards_history_requires_login_and_class_ownership(monkeypatch):
    _clear_overrides()
    monkeypatch.setattr(settings, "require_login", True)
    classes = {("account-a", "class-a"): {"id": "class-a"}}
    coverage_calls: list[str] = []
    lesson_calls: list[tuple[str, str]] = []

    monkeypatch.setattr(db, "get_class", lambda user_id, class_id: classes.get((user_id, class_id)))
    monkeypatch.setattr(
        db,
        "get_standards_coverage",
        lambda class_id: coverage_calls.append(class_id) or {"ELA.1": 2},
    )
    monkeypatch.setattr(
        db,
        "get_standard_lessons",
        lambda class_id, code: lesson_calls.append((class_id, code)) or [{"id": "plan-a"}],
    )

    try:
        # No dependency override: get_current_user must reject a stranger
        # before either class-scoped database query is reached.
        monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: None)
        anonymous = TestClient(app, raise_server_exceptions=False)
        assert anonymous.get("/api/schools").status_code == 401
        assert anonymous.get("/api/standards/coverage?class_id=class-a").status_code == 401
        assert anonymous.get("/api/standards/ELA.1/lessons?class_id=class-a").status_code == 401

        owner = _client(monkeypatch, "account-a")
        assert owner.get("/api/standards/coverage?class_id=class-a").json() == {"ELA.1": 2}
        assert owner.get("/api/standards/ELA.1/lessons?class_id=class-a").json() == [{"id": "plan-a"}]

        stranger = _client(monkeypatch, "account-b")
        assert stranger.get("/api/standards/coverage?class_id=class-a").status_code == 404
        assert stranger.get("/api/standards/ELA.1/lessons?class_id=class-a").status_code == 404
        assert coverage_calls == ["class-a"]
        assert lesson_calls == [("class-a", "ELA.1")]
    finally:
        _clear_overrides()


def test_school_calendar_is_limited_to_school_members_or_admin(monkeypatch):
    _clear_overrides()
    schools = {
        "school-a": {"id": "school-a", "name": "School A"},
        "school-b": {"id": "school-b", "name": "School B"},
    }
    users = {
        "account-a": {"id": "account-a", "school": "school-a"},
        "account-b": {"id": "account-b", "school": "school-b"},
        "admin": {"id": "admin", "school": None},
    }
    pending_calls: list[str] = []

    monkeypatch.setattr(db, "get_school", lambda school_id: schools.get(school_id))
    monkeypatch.setattr(db, "get_user_by_id", lambda user_id: users.get(user_id))
    monkeypatch.setattr(db, "is_admin", lambda user_id: user_id == "admin")
    monkeypatch.setattr(
        db,
        "get_pending_calendar_submission",
        lambda school_id: pending_calls.append(school_id) or {"school_id": school_id},
    )
    monkeypatch.setattr(
        db,
        "get_calendar_submission",
        lambda submission_id: {"id": submission_id, "school_id": "school-a", "status": "pending"},
    )
    monkeypatch.setattr(
        db,
        "confirm_calendar_submission",
        lambda submission_id, confirmed_by: {"id": submission_id, "confirmed_by": confirmed_by},
    )

    try:
        own_school = _client(monkeypatch, "account-a")
        assert own_school.get("/api/school-calendars/pending?school_id=school-a").status_code == 200
        assert own_school.get("/api/school-calendars/pending?school_id=school-b").status_code == 404
        assert own_school.post("/api/school-calendars/submission-a/confirm").status_code == 403

        admin = _client(monkeypatch, "admin")
        assert admin.get("/api/school-calendars/pending?school_id=school-b").status_code == 200
        assert admin.post("/api/school-calendars/submission-a/confirm").status_code == 200
        assert pending_calls == ["school-a", "school-b"]
    finally:
        _clear_overrides()


def test_api_responses_are_private_and_uncacheable(monkeypatch):
    _clear_overrides()
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: None)
    try:
        response = TestClient(app, raise_server_exceptions=False).get("/api/health")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
    finally:
        _clear_overrides()


def test_onboarding_events_store_nothing_but_the_allowlist(monkeypatch):
    """Setup telemetry must not be ABLE to carry teacher or student content.

    routes/onboarding.py drops unrecognised prop keys rather than rejecting the
    batch, deliberately: /events is called from a sendBeacon on pagehide, where
    a 400 loses the drop-off signal at exactly the moment it matters most. That
    makes the allowlist the entire privacy boundary, so it is worth a test that
    goes through the real HTTP path — Pydantic, the route, and all — rather than
    trusting a reading of the filter.

    The payload below is everything the boundary exists to stop: a district
    document filename, a school id already stored on users.school, a free-text
    error message with a student's essay path in it, and a bare student name.
    """
    _clear_overrides()
    monkeypatch.setattr(settings, "require_login", True)
    stored: list[dict] = []

    monkeypatch.setattr(
        db,
        "record_onboarding_events",
        lambda user_id, events: stored.extend(events) or len(events),
    )

    client = _client(monkeypatch, "account-a")
    try:
        response = client.post(
            "/api/onboarding/events",
            json={
                "events": [
                    {
                        "name": "template_analyzed",
                        "step": "format",
                        "props": {
                            "section_count": 7,
                            "analysis_status": "analyzed",
                            "filename": "Florence HS Lesson Plan Template 2026.docx",
                            "school_id": "florence-high-school",
                            "message": "could not parse /Users/josh/Desktop/Smith_essay.docx",
                            "student_name": "Jane Doe",
                        },
                    },
                    # An event name the server doesn't know is dropped whole,
                    # not stored and not 400'd — same reasoning as prop keys.
                    {"name": "definitely_not_a_real_event", "step": "format"},
                    # A real name with a step that isn't a step.
                    {"name": "step_viewed", "step": "../../etc/passwd"},
                ]
            },
        )
    finally:
        _clear_overrides()

    assert response.status_code == 200
    assert response.json() == {"recorded": 1, "dropped": 2}

    assert len(stored) == 1
    props = stored[0]["props"]
    assert props == {"section_count": 7, "analysis_status": "analyzed"}

    # Belt and braces: nothing sensitive survived anywhere in the stored row.
    blob = repr(stored)
    for leaked in ("Florence HS", ".docx", "florence-high-school", "Smith_essay", "Jane Doe"):
        assert leaked not in blob, f"{leaked!r} reached the events table"


def test_onboarding_progress_rejects_steps_and_states_it_does_not_know(monkeypatch):
    """The step name lands in a column the admin funnel groups by, so unlike
    /events this one does reject rather than drop — a bad value here is a
    client bug worth surfacing, not a lost metric."""
    _clear_overrides()
    monkeypatch.setattr(settings, "require_login", True)
    writes: list[tuple] = []

    monkeypatch.setattr(
        db,
        "set_onboarding_progress",
        lambda user_id, step=None, state=None: writes.append((user_id, step, state))
        or {"onboarding_state": state or "in_progress", "onboarding_step": step, "onboarding_seen_at": None},
    )

    client = _client(monkeypatch, "account-a")
    try:
        assert client.post("/api/onboarding/progress", json={"step": "not-a-step"}).status_code == 400
        assert client.post("/api/onboarding/progress", json={"state": "finished-ish"}).status_code == 400
        # Neither a step nor a state is a no-op request, not a silent success.
        assert client.post("/api/onboarding/progress", json={}).status_code == 400
        assert client.post("/api/onboarding/progress", json={"step": "format"}).status_code == 200
        assert client.post("/api/onboarding/progress", json={"state": "skipped"}).status_code == 200
    finally:
        _clear_overrides()

    # Only the two valid calls reached the database.
    assert writes == [("account-a", "format", None), ("account-a", None, "skipped")]
