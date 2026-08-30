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
