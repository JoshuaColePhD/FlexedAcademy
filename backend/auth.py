"""Password hashing and session cookies.

Stdlib only, deliberately: this is a small internal tool for a handful of
teachers, not a target worth a new dependency's worth of attack surface.
PBKDF2-SHA256 (via hashlib, which wraps OpenSSL) is what Django used as its
default password hasher for years for exactly this kind of app.

Sessions are a signed, stateless cookie (uid + expiry + HMAC), not a server-side
session table: nothing to garbage-collect, and correct as long as
`settings.session_secret` is kept secret. The cost is that there is no way to
revoke one session early short of rotating the secret (which invalidates
every session at once) — acceptable for a few-dozen-teacher internal tool,
not for anything handling higher-stakes accounts.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time

from .config import settings
from google.oauth2 import id_token
from google.auth.transport import requests

SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60  # 30 days
_PBKDF2_ITERATIONS = 260_000


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return f"pbkdf2_sha256${_PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    try:
        algo, iterations_s, salt_hex, digest_hex = encoded.split("$")
        if algo != "pbkdf2_sha256":
            return False
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, AttributeError):
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, int(iterations_s))
    return hmac.compare_digest(actual, expected)


def _b64encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64decode(data: str) -> bytes:
    padding = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + padding)


def create_session_token(user_id: str) -> str:
    payload = json.dumps({"uid": user_id, "exp": int(time.time()) + SESSION_MAX_AGE_SECONDS}).encode("utf-8")
    payload_b64 = _b64encode(payload)
    sig = hmac.new(settings.session_secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def verify_session_token(token: str) -> str | None:
    """Returns the user_id if the token is validly signed and unexpired, else None."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        return None
    expected_sig = hmac.new(
        settings.session_secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64decode(payload_b64))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or "uid" not in payload or "exp" not in payload:
        return None
    if int(payload["exp"]) < int(time.time()):
        return None
    return str(payload["uid"])

RESET_TOKEN_MAX_AGE_SECONDS = 60 * 60  # 1 hour — a reset link is not a session


def _password_fingerprint(password_hash: str | None) -> str:
    """A short fingerprint of the CURRENT password hash, embedded in the
    token. Verifying it still matches on redemption is what makes a reset
    link single-use and self-invalidating on any other password change,
    without a database column to mark tokens spent: the moment the password
    actually changes, every other outstanding link for that account stops
    verifying, because the hash it was signed against no longer exists."""
    return hashlib.sha256((password_hash or "none").encode("utf-8")).hexdigest()[:16]


def create_reset_token(user_id: str, password_hash: str | None) -> str:
    payload = json.dumps(
        {
            "uid": user_id,
            "exp": int(time.time()) + RESET_TOKEN_MAX_AGE_SECONDS,
            "pwfp": _password_fingerprint(password_hash),
            "purpose": "reset",
        }
    ).encode("utf-8")
    payload_b64 = _b64encode(payload)
    sig = hmac.new(settings.session_secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256).hexdigest()
    return f"{payload_b64}.{sig}"


def decode_reset_token(token: str) -> dict | None:
    """Verifies the signature, expiry, and that this is a reset token
    specifically (not a session token wandering in) — everything checkable
    WITHOUT knowing who the account's current password hash belongs to.
    Returns the payload ({uid, pwfp, ...}) so the caller can look the user up
    and finish the check with verify_reset_fingerprint below."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        return None
    expected_sig = hmac.new(
        settings.session_secret.encode("utf-8"), payload_b64.encode("ascii"), hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(sig, expected_sig):
        return None
    try:
        payload = json.loads(_b64decode(payload_b64))
    except (ValueError, UnicodeDecodeError):
        return None
    if not isinstance(payload, dict) or payload.get("purpose") != "reset":
        return None
    if "uid" not in payload or "exp" not in payload:
        return None
    if int(payload["exp"]) < int(time.time()):
        return None
    return payload


def verify_reset_fingerprint(payload: dict, current_password_hash: str | None) -> bool:
    """The other half of decode_reset_token: does the token's embedded
    fingerprint still match the account's CURRENT hash? False the instant the
    password changes any other way — this is what makes a reset link
    single-use without a database column to mark it spent."""
    return payload.get("pwfp") == _password_fingerprint(current_password_hash)


def verify_google_token(token: str) -> dict | None:
    """Verifies a Google OAuth ID token and returns the payload if valid."""
    if not settings.google_client_id:
        return None
    try:
        # id_token.verify_oauth2_token verifies the signature, expiration, and audience (client_id)
        idinfo = id_token.verify_oauth2_token(
            token, requests.Request(), settings.google_client_id
        )
        return idinfo
    except ValueError:
        return None
