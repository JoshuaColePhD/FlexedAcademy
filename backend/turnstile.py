"""Server-side Cloudflare Turnstile verification for anonymous signup."""
from __future__ import annotations

import requests
from fastapi import Request

from .abuse import client_ip
from .config import settings
from .errors import AppError

SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"


def verify_signup(request: Request, token: str | None) -> None:
    """Fail closed when Turnstile is required; stay inert for local dev."""
    if not settings.turnstile_configured:
        if settings.turnstile_required:
            raise AppError(
                "bot_protection_unavailable",
                "Sign-up protection is not configured yet.",
                hint="Set the Turnstile site key, secret, and allowed hostnames.",
                status=503,
            )
        return
    if not token or len(token) > 2048:
        raise AppError("bot_check_failed", "Please complete the bot check.", status=403)
    try:
        response = requests.post(
            SITEVERIFY_URL,
            data={"secret": settings.turnstile_secret, "response": token, "remoteip": client_ip(request)},
            timeout=10,
        )
        response.raise_for_status()
        result = response.json()
    except (requests.RequestException, ValueError):
        raise AppError(
            "bot_check_unavailable",
            "We could not verify the sign-up right now.",
            hint="Please try again in a moment.",
            status=503,
        ) from None
    if (
        not result.get("success")
        or result.get("action") != "signup"
        or result.get("hostname") not in settings.turnstile_hostnames_list
    ):
        raise AppError("bot_check_failed", "Please complete the bot check.", status=403)

