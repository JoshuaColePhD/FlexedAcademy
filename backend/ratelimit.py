"""Request-rate limiting, shared by auth and LLM-calling routes.

Keyed by the logged-in user when there is one (a signed session cookie decodes
to a uid without needing get_current_user's DB round trip), and by IP
otherwise — the auth routes below are exactly the ones a caller hits before
any session exists, so IP is the only key available there anyway.
"""
from __future__ import annotations

from fastapi import Request
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address

from .auth import verify_session_token
from .deps import COOKIE_NAME


def _rate_limit_key(request: Request) -> str:
    token = request.cookies.get(COOKIE_NAME)
    payload = verify_session_token(token) if token else None
    if payload:
        return f"user:{payload['uid']}"
    return f"ip:{get_remote_address(request)}"


limiter = Limiter(key_func=_rate_limit_key)


async def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """Same {code, message, hint} envelope as errors.py's AppError, so the
    frontend's one error-handling path already covers this without a special
    case for 429s."""
    return JSONResponse(
        status_code=429,
        content={
            "error": {
                "code": "rate_limited",
                "message": "Too many requests. Please slow down.",
                "hint": f"Try again in a moment ({exc.detail}).",
            }
        },
    )
