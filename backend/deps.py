"""Request-scoped auth dependency.

Was `get_current_user(x_user_id: str | None = Header(None))`, defaulting to
`"default_user"` — a stub nothing ever actually sent (grep the frontend: no
`X-User-Id` anywhere), so every request silently ran as the same account.
Replaced with the real signed session cookie set by routes/auth.py.
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Cookie, Depends

from . import db
from .auth import verify_session_token
from .config import settings
from .errors import AppError

COOKIE_NAME = "aplang_session"


def _verify_current(aplang_session: str | None) -> str | None:
    """The uid a session cookie names, or None — checking not just the
    signature/expiry (verify_session_token's job) but that the token's "sv"
    still matches the account's CURRENT session_version. This is the other
    half of "sign out of all devices" (db.bump_session_version): that call
    only changes one column, so every already-issued cookie has to be
    rechecked against it here, on every request, for the change to mean
    anything."""
    if not aplang_session:
        return None
    payload = verify_session_token(aplang_session)
    if not payload:
        return None
    user = db.get_user_by_id(payload["uid"])
    if not user or int(user.get("session_version", 0)) != payload["sv"]:
        return None
    if user.get("is_blocked"):
        return None
    # A time-boxed beta account (backend/routes/admin.py's
    # POST /beta-accounts, db.create_beta_account) stops authenticating the
    # moment its window passes — checked here, on every request, the same
    # choke point session_version above already uses, rather than as a
    # separate gate some route could forget to call. Past this timestamp the
    # cookie is treated exactly like an expired one: this returns None, the
    # caller 401s, and the frontend's existing "your session ended" handling
    # (AuthProvider's aplang:unauthorized listener) takes it from there — no
    # separate UI needed for "the trial is over" versus "please log back in".
    expires = user.get("beta_expires_at")
    if expires and expires <= datetime.now(UTC).isoformat(timespec="seconds"):
        return None
    return payload["uid"]


def get_current_user(aplang_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str:
    """The logged-in user's id, or a 401 if there isn't one. Use on every route
    that reads or writes a teacher's own data.

    While settings.require_login is False (see config.py), a missing/invalid
    cookie resolves to 'default_user' instead of failing — a temporary,
    single-flag bypass, not a design decision.
    """
    user_id = _verify_current(aplang_session)
    if not user_id:
        if not settings.require_login:
            db.current_user_id.set("default_user")
            return "default_user"
        raise AppError(
            "not_authenticated",
            "Log in to continue.",
            status=401,
        )
    db.current_user_id.set(user_id)
    return user_id


def get_current_user_optional(aplang_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str | None:
    """Same, but None instead of a 401 — for routes that behave differently
    when logged out rather than refusing outright (there are none of these
    yet, but /api/auth/me and future public routes want this shape)."""
    return _verify_current(aplang_session)


def get_current_admin(user_id: str = Depends(get_current_user)) -> str:
    """Same session cookie, plus the is_admin column. A normal teacher's
    session token grants them nothing extra here — admin is a row in the
    database, not a scope encoded in the token, so revoking it takes effect
    on the very next request rather than waiting out a session's lifetime."""
    if not db.is_admin(user_id):
        raise AppError("forbidden", "Not authorized.", status=403)
    return user_id
