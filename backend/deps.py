"""Request-scoped auth dependency.

Was `get_current_user(x_user_id: str | None = Header(None))`, defaulting to
`"default_user"` — a stub nothing ever actually sent (grep the frontend: no
`X-User-Id` anywhere), so every request silently ran as the same account.
Replaced with the real signed session cookie set by routes/auth.py.
"""
from __future__ import annotations

from datetime import UTC, datetime

from fastapi import Cookie, Depends, Request
from starlette.concurrency import run_in_threadpool

from . import db
from .auth import verify_session_token
from .config import settings
from .errors import AppError

COOKIE_NAME = "flexed_session"


def verified_user(flexed_session: str | None) -> dict | None:
    """The uid a session cookie names, or None — checking not just the
    signature/expiry (verify_session_token's job) but that the token's "sv"
    still matches the account's CURRENT session_version. This is the other
    half of "sign out of all devices" (db.bump_session_version): that call
    only changes one column, so every already-issued cookie has to be
    rechecked against it here, on every request, for the change to mean
    anything."""
    if not flexed_session:
        return None
    payload = verify_session_token(flexed_session)
    if not payload:
        return None
    # The signed identity is safe to bind before reading its own account. This
    # also permits verification with an ordinary, RLS-constrained DB role.
    with db.as_user(payload["uid"]):
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
    # (AuthProvider's flexed:unauthorized listener) takes it from there — no
    # separate UI needed for "the trial is over" versus "please log back in".
    expires = user.get("beta_expires_at")
    if expires and expires <= datetime.now(UTC).isoformat(timespec="seconds"):
        return None
    # Keep the presence update after verification and inside its owner context.
    # It runs in the same worker thread as the account lookup.
    with db.as_user(user["id"]):
        db.touch_last_seen(user)
    return user


def _verify_current(flexed_session: str | None) -> str | None:
    user = verified_user(flexed_session)
    return user["id"] if user else None


async def _request_user(request: Request, cookie: str | None) -> dict | None:
    if not getattr(request.state, "auth_checked", False):
        request.state.auth_user = await run_in_threadpool(verified_user, cookie)
        request.state.auth_checked = True
    return request.state.auth_user


async def get_current_user(request: Request, flexed_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str:
    """The logged-in user's id, or a 401 if there isn't one. Use on every route
    that reads or writes a teacher's own data.

    While settings.require_login is False (see config.py), a missing/invalid
    cookie resolves to 'default_user' instead of failing — a temporary,
    single-flag bypass, not a design decision.
    """
    user = await _request_user(request, flexed_session)
    user_id = user["id"] if user else None
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


async def get_current_user_optional(request: Request, flexed_session: str | None = Cookie(default=None, alias=COOKIE_NAME)) -> str | None:
    """Same, but None instead of a 401 — for routes that behave differently
    when logged out rather than refusing outright (there are none of these
    yet, but /api/auth/me and future public routes want this shape)."""
    user = await _request_user(request, flexed_session)
    user_id = user["id"] if user else None
    db.current_user_id.set(user_id)
    return user_id


def get_current_admin(user_id: str = Depends(get_current_user)) -> str:
    """Require the one configured owner account for every admin route.

    The historical `users.is_admin` column is not enough to grant access: a
    subscriber, or an account left with an old admin flag, must not be able to
    open the admin panel or call its API directly.
    """
    if not db.is_owner(user_id):
        raise AppError("forbidden", "Not authorized.", status=403)
    return user_id
