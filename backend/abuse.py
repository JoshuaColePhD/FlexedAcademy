"""Small, privacy-preserving signals used to slow automated free signups.

These values are deliberately one-way HMACs, not raw IP addresses or device
identifiers. They are abuse-prevention signals only: neither one is treated as
proof of identity, and the IP signal is a wider backstop because schools often
share one public address.
"""
from __future__ import annotations

import hashlib
import hmac
import secrets
import time

from fastapi import Request, Response

from .config import settings

DEVICE_COOKIE_NAME = "flexed_device"


def client_ip(request: Request) -> str:
    """Return the edge-provided client IP, with a local direct-connection fallback."""
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",", 1)[0].strip()
    return request.client.host if request.client else "unknown"


def signal_hash(value: str, purpose: str) -> str:
    """Hash an abuse signal so the database never stores the raw value."""
    message = f"{purpose}:{value.strip()}".encode("utf-8")
    return hmac.new(settings.session_secret.encode("utf-8"), message, hashlib.sha256).hexdigest()


def email_identity_hash(email: str) -> str:
    return signal_hash(email.strip().lower(), "trial-email")


def ensure_device_cookie(request: Request, response: Response) -> str:
    """Return a coarse device signal and set it once for browsers that lack one."""
    value = request.cookies.get(DEVICE_COOKIE_NAME)
    if not value or len(value) > 256:
        value = secrets.token_urlsafe(24)
        response.set_cookie(
            DEVICE_COOKIE_NAME,
            value,
            httponly=True,
            samesite="lax",
            secure=bool(settings.cookie_secure),
            max_age=60 * 60 * 24 * 365,
        )
    return value


def validate_signup_form(website: str | None, started_at_ms: float | None) -> None:
    """Reject the cheapest scripted submissions before they reach the database."""
    if website and website.strip():
        raise ValueError("bot honeypot filled")
    if started_at_ms is None:
        raise ValueError("signup form timing missing")
    try:
        elapsed = time.time() - (float(started_at_ms) / 1000)
    except (TypeError, ValueError):
        raise ValueError("signup form timing invalid") from None
    if elapsed < 1.0:
        raise ValueError("signup form completed too quickly")

