"""Request-scoped auth dependency.

Was `get_current_user(x_user_id: str | None = Header(None))`, defaulting to
`"default_user"` — a stub nothing ever actually sent (grep the frontend: no
`X-User-Id` anywhere), so every request silently ran as the same account.
Replaced with the real signed session cookie set by routes/auth.py.
"""
from __future__ import annotations

from fastapi import Cookie

from .auth import verify_session_token
from .config import settings
from .errors import AppError

COOKIE_NAME = "aplang_session"


def get_current_user(aplang_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str:
    """The logged-in user's id, or a 401 if there isn't one. Use on every route
    that reads or writes a teacher's own data.

    While settings.require_login is False (see config.py), a missing/invalid
    cookie resolves to 'default_user' instead of failing — a temporary,
    single-flag bypass, not a design decision.
    """
    user_id = verify_session_token(aplang_session) if aplang_session else None
    if not user_id:
        if not settings.require_login:
            return "default_user"
        raise AppError(
            "not_authenticated",
            "Log in to continue.",
            status=401,
        )
    return user_id


def get_current_user_optional(aplang_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str | None:
    """Same, but None instead of a 401 — for routes that behave differently
    when logged out rather than refusing outright (there are none of these
    yet, but /api/auth/me and future public routes want this shape)."""
    return verify_session_token(aplang_session) if aplang_session else None
