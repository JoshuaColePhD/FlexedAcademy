"""Login stamps and throttled last_seen writes — no analytics stack, no live DB."""
from __future__ import annotations

from datetime import UTC, datetime, timedelta

from fastapi.testclient import TestClient

from backend import abuse, auth, db
from backend.config import settings
from backend.deps import COOKIE_NAME, _verify_current
from backend.routes import auth as auth_routes
from backend.server import app


def _sample_user(**overrides):
    user = {
        "id": "u1",
        "email": "teacher@example.com",
        "name": "Teacher",
        "password_hash": auth.hash_password("correct-password"),
        "session_version": 0,
        "email_verified_at": "2026-01-01T00:00:00+00:00",
        "is_blocked": False,
        "is_admin": False,
        "is_read_only": False,
        "is_owner": False,
        "stripe_customer_id": "cus_test",
        "subscription_status": "comped",
        "custom_instructions": None,
        "school": "generic",
        "output_length": "medium",
        "beta_features": False,
        "onboarding_seen_at": None,
        "onboarding_state": "not_started",
        "onboarding_step": None,
        "avatar": None,
        "trial_started_at": "2026-01-01T00:00:00+00:00",
        "beta_expires_at": None,
        "last_login_at": None,
        "last_seen_at": None,
    }
    user.update(overrides)
    return user


def _stub_public_user_deps(monkeypatch):
    monkeypatch.setattr(db, "count_plans", lambda _uid: 0)
    monkeypatch.setattr(db, "tokens_used_two_windows", lambda *_args: (0, 0))
    monkeypatch.setattr(db, "is_owner", lambda _uid: False)
    monkeypatch.setattr(abuse, "ensure_device_cookie", lambda _request, _response: "device")


def _stub_http_auth(monkeypatch, user):
    """In-memory doubles for the database-free CI pytest line.

    A successful login sets a session cookie. TestClient keeps it, so the next
    POST hits ReadOnlyDemoMiddleware → deps._verify_current → get_user_by_id
    and touch_last_seen. Google sign-in also calls link_google_sub when the
    row has no sub yet. None of those may reach _ensure_pool() here.
    """
    recorded = []
    monkeypatch.setattr(settings, "database_url", "")
    monkeypatch.setattr(
        db,
        "_ensure_pool",
        lambda: (_ for _ in ()).throw(ValueError("DATABASE_URL is not set in .env")),
    )
    monkeypatch.setattr(db, "get_user_by_email", lambda _email: user)
    monkeypatch.setattr(db, "get_user_by_id", lambda user_id: user if user_id == user["id"] else None)
    monkeypatch.setattr(db, "get_user_by_google_sub", lambda _sub: user)
    monkeypatch.setattr(db, "record_login", lambda user_id, **_kwargs: recorded.append(user_id))
    monkeypatch.setattr(db, "touch_last_seen", lambda _seen, **_kwargs: False)
    monkeypatch.setattr(db, "link_google_sub", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(db, "mark_email_verified", lambda *_args, **_kwargs: user)
    monkeypatch.setattr(db, "start_verified_trial", lambda *_args, **_kwargs: user)
    _stub_public_user_deps(monkeypatch)
    return recorded


def test_migration_adds_nullable_presence_columns():
    migration = next(sql for sql in db.MIGRATIONS if "ADD COLUMN IF NOT EXISTS last_login_at TEXT" in sql)
    assert "ADD COLUMN IF NOT EXISTS last_login_at TEXT" in migration
    assert "ADD COLUMN IF NOT EXISTS last_seen_at TEXT" in migration
    assert "NOT NULL" not in migration


def test_record_login_writes_both_timestamps(monkeypatch):
    writes = []
    monkeypatch.setattr(db, "_write", lambda sql, params=(): writes.append((sql, params)) or 1)
    monkeypatch.setattr(db, "now", lambda: "2026-09-20T12:00:00+00:00")

    assert db.record_login("u1") == "2026-09-20T12:00:00+00:00"
    assert len(writes) == 1
    sql, params = writes[0]
    assert "last_login_at" in sql
    assert "last_seen_at" in sql
    assert params == ("2026-09-20T12:00:00+00:00", "2026-09-20T12:00:00+00:00", "u1")


def test_touch_last_seen_writes_when_missing_or_stale(monkeypatch):
    writes = []
    monkeypatch.setattr(db, "_write", lambda sql, params=(): writes.append((sql, params)) or 1)

    now = "2026-09-20T12:00:00+00:00"
    assert db.touch_last_seen({"id": "u1", "last_seen_at": None}, at=now) is True
    assert db.touch_last_seen(
        {"id": "u1", "last_seen_at": "2026-09-20T11:40:00+00:00"},
        at=now,
    ) is True
    assert len(writes) == 2
    assert all("last_seen_at" in sql for sql, _params in writes)
    assert all("last_login_at" not in sql for sql, _params in writes)


def test_touch_last_seen_throttles_fresh_timestamp(monkeypatch):
    writes = []
    monkeypatch.setattr(db, "_write", lambda sql, params=(): writes.append((sql, params)) or 1)

    now = datetime(2026, 9, 20, 12, 0, tzinfo=UTC)
    fresh = (now - timedelta(minutes=4)).isoformat(timespec="seconds")
    assert db.touch_last_seen({"id": "u1", "last_seen_at": fresh}, at=now.isoformat(timespec="seconds")) is False
    assert writes == []

    # Driver-returned datetime objects must throttle the same way ISO text does.
    assert db.touch_last_seen({"id": "u1", "last_seen_at": now - timedelta(minutes=2)}, at=now.isoformat(timespec="seconds")) is False
    assert writes == []


def test_password_login_records_presence(monkeypatch):
    user = _sample_user()
    recorded = _stub_http_auth(monkeypatch, user)

    client = TestClient(app, raise_server_exceptions=False)
    ok = client.post("/api/auth/login", json={"email": user["email"], "password": "correct-password"})
    # Fresh client: the successful login left a session cookie, and TestClient
    # would replay it. The 401 path must not depend on last_seen middleware.
    denied = TestClient(app, raise_server_exceptions=False).post(
        "/api/auth/login",
        json={"email": user["email"], "password": "wrong-password"},
    )

    assert ok.status_code == 200
    assert denied.status_code == 401
    assert recorded == ["u1"]
    assert COOKIE_NAME in ok.cookies


def test_google_login_records_presence(monkeypatch):
    # No google_sub on the row yet — the live route calls link_google_sub
    # before _log_in. That write must stay stubbed on this CI line.
    user = _sample_user(password_hash=None)
    recorded = _stub_http_auth(monkeypatch, user)
    payload = {"email": user["email"], "email_verified": True, "sub": "google-sub", "name": "Teacher"}
    monkeypatch.setattr(auth, "verify_google_token", lambda _credential: payload)
    monkeypatch.setattr(auth_routes.auth, "verify_google_token", lambda _credential: payload)

    client = TestClient(app, raise_server_exceptions=False)
    response = client.post("/api/auth/google", json={"credential": "fake-google-token"})
    assert response.status_code == 200
    assert recorded == ["u1"]


def test_verify_current_touches_last_seen_only_when_authenticated(monkeypatch):
    user = _sample_user()
    touched = []
    monkeypatch.setattr(db, "get_user_by_id", lambda user_id: user if user_id == "u1" else None)
    monkeypatch.setattr(db, "touch_last_seen", lambda seen, **_kwargs: touched.append(seen["id"]))
    monkeypatch.setattr(auth_routes.auth, "verify_session_token", auth.verify_session_token)

    token = auth.create_session_token("u1", 0)
    assert _verify_current(token) == "u1"
    assert touched == ["u1"]

    assert _verify_current("not-a-session") is None
    assert _verify_current(None) is None
    assert touched == ["u1"]

    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {**user, "is_blocked": True})
    assert _verify_current(token) is None
    assert touched == ["u1"]
