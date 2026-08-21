"""A very small Google OAuth + Drive client, built on `requests` rather than
the SDK — same reasoning as stripe_api.py: the whole of what this app asks
Google to do is four things (send someone to consent, exchange or refresh a
token, upload a file as a native Google Doc, and share it), which is well
under a hundred lines against documented REST APIs.

This is deliberately a SEPARATE Google integration from backend/auth.py's
verify_google_token — that one verifies an ID token for Sign-In-with-Google,
which proves identity and grants no API access at all. Sharing needs an
actual OAuth authorization-code grant with the drive.file scope, which is
what google_client_secret (config.py) is for; the two flows only share a
client_id because they're issued from the same Google Cloud project.

This module knows nothing about the database — it takes tokens in and hands
tokens/results back. Reading a user's stored tokens, refreshing them when
stale, and writing the result back is routes/drive.py's job, since that's
where the user_id actually is.
"""
from __future__ import annotations

import json
import logging
import uuid
from urllib.parse import urlencode

import requests

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.drive")

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
REVOKE_URL = "https://oauth2.googleapis.com/revoke"
DRIVE_API = "https://www.googleapis.com/drive/v3"
DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files"
TIMEOUT = 20
UPLOAD_TIMEOUT = 60

# The file this app creates, and nothing else already in a teacher's Drive —
# the narrowest scope Google offers for "let this app put a document there
# and share it," which is also the scope least likely to need special
# verification beyond a Workspace admin's own review.
SCOPE = "https://www.googleapis.com/auth/drive.file"

GOOGLE_DOC_MIME = "application/vnd.google-apps.document"

_UNCONFIGURED = AppError(
    "drive_unconfigured",
    "Google Drive sharing isn't set up yet.",
    status=503,
    hint="Ask your administrator to configure it.",
)


def _require_configured() -> None:
    if not settings.drive_share_enabled:
        raise _UNCONFIGURED


def authorization_url(redirect_uri: str, state: str) -> str:
    """Where to send the teacher's browser to grant (or refuse) Drive access.

    access_type=offline + prompt=consent is what makes Google actually hand
    back a refresh_token — without both, a second connect from the same
    account silently returns no refresh_token at all (Google assumes one
    already exists), which would leave this app with an access token that
    expires in an hour and no way to renew it.
    """
    _require_configured()
    params = {
        "client_id": settings.google_client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
        "state": state,
    }
    return f"{AUTH_URL}?{urlencode(params)}"


def _token_call(data: dict) -> dict:
    _require_configured()
    try:
        res = requests.post(TOKEN_URL, data=data, timeout=TIMEOUT)
    except requests.RequestException as e:
        log.warning("google token endpoint unreachable: %s", e)
        raise AppError(
            "drive_unreachable",
            "Couldn't reach Google.",
            status=502,
            hint="Try again in a moment.",
        ) from e
    body = res.json() if res.content else {}
    if not res.ok:
        log.warning("google token exchange failed: %s %s", res.status_code, body.get("error"))
        raise AppError(
            "drive_auth_failed",
            "Google didn't accept that — try connecting again.",
            status=502,
        )
    return body


def exchange_code(code: str, redirect_uri: str) -> dict:
    """{access_token, refresh_token, expires_in, scope, ...} — refresh_token
    is only present because authorization_url asked for offline access."""
    return _token_call(
        {
            "code": code,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "redirect_uri": redirect_uri,
            "grant_type": "authorization_code",
        }
    )


def refresh_access_token(refresh_token: str) -> dict:
    """{access_token, expires_in, ...} — no new refresh_token; Google reuses
    the one already issued unless the grant itself was revoked."""
    return _token_call(
        {
            "refresh_token": refresh_token,
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret,
            "grant_type": "refresh_token",
        }
    )


def revoke(token: str) -> None:
    """Best-effort. A revoke that fails (token already dead, Google
    unreachable) shouldn't stop the app from forgetting its own copy —
    routes/drive.py clears the stored tokens regardless of this call's
    outcome."""
    try:
        requests.post(REVOKE_URL, params={"token": token}, timeout=TIMEOUT)
    except requests.RequestException as e:
        log.warning("google revoke unreachable: %s", e)


def upload_as_google_doc(access_token: str, *, filename: str, content: bytes, source_mime: str) -> dict:
    """Uploads `content` and asks Drive to convert it on the way in, so the
    result is a native, editable Google Doc rather than an opaque .docx blob
    sitting in Drive. {id, webViewLink}.

    Built by hand as multipart/related (RFC 2387) per Drive's own documented
    simple-upload shape — requests' own `files=` param encodes
    multipart/form-data instead, which Drive's upload endpoint does not
    accept the same way, so the body is assembled directly rather than
    reached for that shortcut.
    """
    boundary = f"drive-{uuid.uuid4().hex}"
    metadata = json.dumps({"name": filename, "mimeType": GOOGLE_DOC_MIME})
    body = (
        f"--{boundary}\r\n"
        f"Content-Type: application/json; charset=UTF-8\r\n\r\n"
        f"{metadata}\r\n"
        f"--{boundary}\r\n"
        f"Content-Type: {source_mime}\r\n\r\n"
    ).encode() + content + f"\r\n--{boundary}--".encode()

    try:
        res = requests.post(
            DRIVE_UPLOAD_API,
            params={"uploadType": "multipart", "fields": "id,webViewLink"},
            headers={
                "Authorization": f"Bearer {access_token}",
                "Content-Type": f"multipart/related; boundary={boundary}",
            },
            data=body,
            timeout=UPLOAD_TIMEOUT,
        )
    except requests.RequestException as e:
        log.warning("drive upload unreachable: %s", e)
        raise AppError(
            "drive_unreachable",
            "Couldn't reach Google Drive.",
            status=502,
            hint="Try again in a moment.",
        ) from e
    body_json = res.json() if res.content else {}
    if not res.ok:
        log.warning("drive upload failed: %s %s", res.status_code, body_json.get("error"))
        raise AppError(
            "drive_upload_failed",
            "Google Drive couldn't create the document.",
            status=502,
        )
    return body_json


def share_file(access_token: str, file_id: str, *, email: str, role: str) -> None:
    """role is 'reader' or 'writer'. sendNotificationEmail is what makes this
    Google's own share mechanism rather than a link nobody's told about —
    the recipient gets Drive's standard "X shared a document with you" email,
    the same one they'd get from a colleague sharing it by hand."""
    try:
        res = requests.post(
            f"{DRIVE_API}/files/{file_id}/permissions",
            params={"sendNotificationEmail": "true"},
            headers={"Authorization": f"Bearer {access_token}"},
            json={"type": "user", "role": role, "emailAddress": email},
            timeout=TIMEOUT,
        )
    except requests.RequestException as e:
        log.warning("drive share unreachable: %s", e)
        raise AppError(
            "drive_unreachable",
            "Couldn't reach Google Drive.",
            status=502,
            hint="Try again in a moment.",
        ) from e
    if not res.ok:
        body = res.json() if res.content else {}
        log.warning("drive share failed: %s %s", res.status_code, body.get("error"))
        err = body.get("error", {})
        raise AppError(
            "drive_share_failed",
            err.get("message") or "Google Drive wouldn't share that document.",
            status=502,
            hint="Check that the email address is a real Google account.",
        )

