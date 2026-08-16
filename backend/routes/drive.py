"""Connecting a teacher's Google account so a plan can be shared as a real
Google Doc — see backend/google_drive.py for the actual OAuth/Drive calls,
and PlanRow's own share endpoints in routes/plans.py for the part that
actually uses the connection.

This is a SEPARATE Google integration from Sign-In-with-Google
(routes/auth.py's /google endpoint): that one verifies an ID token and grants
no API access. This one is a real OAuth authorization-code exchange for the
drive.file scope, so the app can create and permission a file in the
teacher's own Drive. Three moving pieces:

  GET /api/drive/status      does this account have a working connection?
  GET /api/drive/connect     -> redirect to Google's consent screen
  GET /api/drive/callback    <- Google redirecting back with a code
  POST /api/drive/disconnect forget this account's Drive access
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import RedirectResponse

from .. import auth, db, google_drive
from ..config import settings
from ..deps import get_current_user
from ..errors import AppError

log = logging.getLogger("aplang.drive")

router = APIRouter(prefix="/api/drive", tags=["drive"])

# Refresh a little before Google's own expiry, not exactly at it — a token
# that's valid when checked but expires mid-request (the Drive upload can
# run long on a slow connection) would fail the one call this whole feature
# exists to make.
_REFRESH_SKEW_SECONDS = 120


def _redirect_uri(request: Request) -> str:
    """Where GOOGLE sends the browser back to. Must exactly match a redirect
    URI registered on the OAuth client in Google Cloud Console — Google
    rejects any mismatch outright, which is why a configured value wins over
    deriving one, the same way billing.py's _return_url prefers
    billing_return_url over the request's own origin."""
    if settings.drive_redirect_url:
        return settings.drive_redirect_url
    return f"{str(request.base_url).rstrip('/')}/api/drive/callback"


def _frontend_url(request: Request) -> str:
    """Where the teacher's browser lands once Google's part is done. Same
    fallback routes/auth.py's own _frontend_url uses for password-reset
    links — a configured value wins so a request header an attacker
    controls can't redirect the browser anywhere it likes."""
    if settings.billing_return_url:
        return settings.billing_return_url.rstrip("/")
    return str(request.base_url).rstrip("/")


def get_valid_access_token(user_id: str) -> str:
    """The access token to actually call Drive with — refreshed first if it's
    stale. Used by routes/plans.py's share endpoint, not just this module,
    which is why it isn't prefixed private.
    """
    row = db.get_drive_tokens(user_id)
    if not row:
        raise AppError(
            "drive_not_connected",
            "Connect Google Drive before sharing.",
            status=409,
        )
    expires_at = datetime.fromisoformat(row["expires_at"])
    if expires_at - timedelta(seconds=_REFRESH_SKEW_SECONDS) > datetime.now(timezone.utc):
        return row["access_token"]
    result = google_drive.refresh_access_token(row["refresh_token"])
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(result.get("expires_in", 3600)))
    db.set_drive_access_token(
        user_id, access_token=result["access_token"], expires_at=expires_at.isoformat(timespec="seconds")
    )
    return result["access_token"]


@router.get("/status")
def drive_status(user_id: str = Depends(get_current_user)) -> dict:
    return {
        "enabled": settings.drive_share_enabled,
        "connected": settings.drive_share_enabled and db.get_drive_tokens(user_id) is not None,
    }


@router.get("/connect")
def connect(
    request: Request,
    # Where in the app to return to once Google's part is done — the plan
    # the teacher was trying to share when they clicked Share, so
    # reconnecting doesn't strand them back at the app's front door.
    return_to: str = Query("/"),
    user_id: str = Depends(get_current_user),
):
    if not settings.drive_share_enabled:
        raise AppError(
            "drive_unconfigured",
            "Google Drive sharing isn't set up yet.",
            status=503,
        )
    # Only ever a same-app path, never a full URL — otherwise the callback
    # below would redirect the browser to wherever this value points, which
    # is exactly the open-redirect shape this check exists to close off.
    if not return_to.startswith("/") or return_to.startswith("//"):
        return_to = "/"
    state = auth.create_drive_state_token(user_id, return_to)
    url = google_drive.authorization_url(_redirect_uri(request), state)
    return RedirectResponse(url, status_code=302)


@router.get("/callback")
def callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None):
    base = _frontend_url(request)
    payload = auth.decode_drive_state_token(state) if state else None
    if not payload:
        # No session dependency here on purpose — by the time Google redirects
        # back, this is a fresh top-level navigation the browser is making on
        # its own, and the only proof of who it belongs to IS this signed
        # state, not whatever cookie happens to still be attached.
        log.warning("drive callback with invalid or expired state")
        return RedirectResponse(f"{base}/?drive=error", status_code=302)
    return_to = payload["return_to"]
    if error:
        # The teacher clicked "Cancel" on Google's own consent screen — not a
        # failure worth logging, just an answer.
        return RedirectResponse(f"{base}{return_to}?drive=cancelled", status_code=302)
    if not code:
        return RedirectResponse(f"{base}{return_to}?drive=error", status_code=302)
    try:
        result = google_drive.exchange_code(code, _redirect_uri(request))
    except AppError:
        return RedirectResponse(f"{base}{return_to}?drive=error", status_code=302)
    if not result.get("refresh_token"):
        # Google only omits this when it thinks one already exists for this
        # client+account pair, which authorization_url's own
        # prompt=consent&access_type=offline is supposed to prevent — surfaced
        # distinctly rather than silently storing an access-only grant that
        # would quietly stop working the moment it expires.
        log.warning("google drive grant for %s carried no refresh_token", payload["uid"])
        return RedirectResponse(f"{base}{return_to}?drive=error", status_code=302)
    expires_at = datetime.now(timezone.utc) + timedelta(seconds=int(result.get("expires_in", 3600)))
    db.set_drive_tokens(
        payload["uid"],
        access_token=result["access_token"],
        refresh_token=result["refresh_token"],
        expires_at=expires_at.isoformat(timespec="seconds"),
        scope=result.get("scope", google_drive.SCOPE),
    )
    return RedirectResponse(f"{base}{return_to}?drive=connected", status_code=302)


@router.post("/disconnect")
def disconnect(user_id: str = Depends(get_current_user)) -> dict:
    row = db.get_drive_tokens(user_id)
    if row:
        google_drive.revoke(row["refresh_token"])
        db.clear_drive_tokens(user_id)
    return {"status": "ok"}
