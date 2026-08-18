"""Transactional email via Resend's HTTP API.

No SDK — Resend's API is a single POST, and `requests` is already a runtime
dependency. Inert until RESEND_API_KEY is set, same shape as Stripe in
config.py: sending is skipped with a log line instead of raising, since a
teacher whose reset email had nowhere to go is a UX gap, not a server error
for whatever route triggered it.
"""
from __future__ import annotations

import logging

import requests

from .config import settings

log = logging.getLogger("aplang.mail")

RESEND_URL = "https://api.resend.com/emails"


def send(*, to: str, subject: str, html: str) -> bool:
    """Best-effort. Returns whether it actually went out — callers decide
    whether that's worth telling the teacher about (usually not: see
    forgot-password's deliberately generic response, which must not change
    shape based on whether an email exists)."""
    if not settings.resend_api_key:
        log.warning("RESEND_API_KEY not set; not sending %r to %s", subject, to)
        return False
    try:
        resp = requests.post(
            RESEND_URL,
            headers={"Authorization": f"Bearer {settings.resend_api_key}"},
            json={"from": settings.email_from, "to": [to], "subject": subject, "html": html},
            timeout=10,
        )
        resp.raise_for_status()
        return True
    except requests.RequestException:
        log.exception("failed to send %r to %s", subject, to)
        return False


def send_template_active_email(*, to: str, uploader_name: str | None, school_name: str) -> bool:
    """Shared by the admin's manual 'Mark Active' action (routes/admin.py)
    and template_intake.py's auto-activation path — same email either way,
    since the teacher shouldn't be able to tell which one flipped the
    switch."""
    return send(
        to=to,
        subject="Your custom lesson plan format is ready!",
        html=f"""
            <p>Hi {uploader_name or 'there'},</p>
            <p>Great news! FlexEd Academy is now fully trained on <strong>{school_name}</strong>'s lesson plan format.</p>
            <p>All your future downloads will perfectly match your district's requirements.</p>
            <br/>
            <p>Happy teaching,<br/>Josh Cole</p>
        """,
    )
