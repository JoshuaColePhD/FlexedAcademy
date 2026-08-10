"""Signup, login, logout — see backend/auth.py for the hashing/cookie mechanics."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db, mail, stripe_api
from ..config import settings
from ..deps import COOKIE_NAME, get_current_user
from ..entitlement import entitlement
from ..errors import AppError

log = logging.getLogger("aplang.auth")

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Same-site, not cross-site: the dev frontend and backend are different ports on
# one machine, which browsers treat as same-site for this purpose.
#
# `secure` is DERIVED FROM THE REQUEST, not from a setting someone has to
# remember. It was a config boolean, and the boolean was forgotten — the live
# site ran with an unmarked session cookie, meaning the token that IS a login
# could travel over plain HTTP.
#
# A cookie should be Secure exactly when the connection is HTTPS, and the
# request already knows that. Render terminates TLS and forwards
# X-Forwarded-Proto, so that header is the truth in production; url.scheme is
# the truth locally. COOKIE_SECURE=true still works as a forced override for
# anything sitting behind a proxy that does not set the header.
def _is_https(request: Request) -> bool:
    if settings.cookie_secure:
        return True
    proto = request.headers.get("x-forwarded-proto", "").split(",")[0].strip()
    return (proto or request.url.scheme) == "https"


def _frontend_url(request: Request) -> str:
    """Where the reset link should point. Same reasoning as billing.py's own
    `_return_url`: a configured value wins (so a request header an attacker
    controls can't redirect the link), falling back to the request's own
    origin for local dev with nothing extra to set."""
    if settings.billing_return_url:
        return settings.billing_return_url.rstrip("/")
    return str(request.base_url).rstrip("/")


def _cookie_kwargs(request: Request) -> dict:
    return dict(
        httponly=True,
        samesite="lax",
        secure=_is_https(request),
        max_age=auth.SESSION_MAX_AGE_SECONDS,
    )


def _public_user(user: dict) -> dict:
    """What the browser is allowed to know about the signed-in account.

    `entitlement` rides along so the app never has to guess whether the Build
    button will work — one server-side answer, read by the paywall, the
    composer and the account menu alike.
    """
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "is_admin": bool(user.get("is_admin")),
        # Never the hash itself — just whether one exists, so the settings
        # page can decide between "change password" and "this account signs
        # in with Google" without guessing from anything else client-side.
        "has_password": bool(user.get("password_hash")),
        # Global custom instructions (backend/prompts.py) — read here, not a
        # separate GET, since /api/auth/me is already the one place the
        # frontend refetches the account from after any settings change.
        "custom_instructions": user.get("custom_instructions"),
        "entitlement": entitlement(user["id"]).as_dict(),
    }


def _log_in(request: Request, response: Response, user: dict) -> dict:
    token = auth.create_session_token(user["id"], user.get("session_version", 0))
    response.set_cookie(COOKIE_NAME, token, **_cookie_kwargs(request))
    return _public_user(user)


class SignupBody(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    password: str = Field(min_length=8, max_length=200)


class LoginBody(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)

class GoogleLoginBody(BaseModel):
    credential: str


@router.post("/signup")
def signup(body: SignupBody, request: Request, response: Response):
    existing = db.get_user_by_email(body.email)
    if existing is None:
        user = db.create_user(body.email, body.name, auth.hash_password(body.password))
    elif existing["password_hash"] is None:
        # A placeholder seat (the migrated 'default_user' account, or a future
        # admin-provisioned one) — first person to sign up with that email
        # claims it, and every chat/plan/setting already attached to it.
        user = db.claim_user(existing["id"], body.name, auth.hash_password(body.password))
    else:
        raise AppError(
            "email_taken",
            "An account with that email already exists.",
            hint="Log in instead.",
            status=409,
        )
    return _log_in(request, response, user)


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response):
    user = db.get_user_by_email(body.email)
    if not user or not user["password_hash"] or not auth.verify_password(body.password, user["password_hash"]):
        raise AppError("invalid_credentials", "Incorrect email or password.", status=401)
    return _log_in(request, response, user)


@router.post("/google")
def google_login(body: GoogleLoginBody, request: Request, response: Response):
    idinfo = auth.verify_google_token(body.credential)
    if not idinfo:
        raise AppError("invalid_credentials", "Invalid Google token.", status=401)
        
    email = idinfo.get("email")
    name = idinfo.get("name") or email.split("@")[0]
    
    if not email:
        raise AppError("invalid_credentials", "Google token missing email.", status=401)
        
    user = db.get_user_by_email(email)
    if not user:
        # Create a new user for Google sign-in.
        # No password_hash because they authenticate via Google.
        user = db.create_user(email, name, password_hash=None)
        
    return _log_in(request, response, user)


@router.post("/logout")
def logout(request: Request, response: Response):
    # Must match the attributes it was SET with, or the browser treats it as a
    # different cookie and quietly keeps the session alive after "Sign out".
    response.delete_cookie(
        COOKIE_NAME, httponly=True, samesite="lax", secure=_is_https(request)
    )
    return {"ok": True}


@router.post("/sign_out_everywhere")
def sign_out_everywhere(request: Request, response: Response, user_id: str = Depends(get_current_user)):
    """Ends every session for THIS account — the one thing rotating the
    global session_secret would do to every account at once (see auth.py).
    db.bump_session_version is the whole mechanism; deps.get_current_user
    rechecks it on every request, so the device that just clicked this is
    logged out on its very next request same as any other — deleting its
    own cookie here just means that happens immediately instead of on the
    next round trip."""
    db.bump_session_version(user_id)
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=_is_https(request))
    return {"ok": True}


class DeleteAccountBody(BaseModel):
    # Absent for a Google-only account (has_password is false — see
    # _public_user) — there is nothing server-side to check for those beyond
    # the session itself, same trust level Google sign-in already granted.
    password: str | None = Field(default=None, max_length=200)


@router.post("/delete_account")
def delete_account(
    body: DeleteAccountBody, request: Request, response: Response, user_id: str = Depends(get_current_user)
):
    """Irreversible — everything this account owns, gone, in one request.
    Re-verifying the password here (same check as change_password above) is
    the one guard against a stray click on a page left open, since the
    confirm dialog alone is just a click too.
    """
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    if user.get("password_hash") and not (
        body.password and auth.verify_password(body.password, user["password_hash"])
    ):
        raise AppError("invalid_credentials", "That password is incorrect.", status=401)
    if user.get("stripe_customer_id"):
        try:
            stripe_api.cancel_subscriptions_for_customer(user["stripe_customer_id"])
        except AppError as e:
            # Deleting the account is the thing the teacher asked for; a
            # Stripe hiccup shouldn't block it — logged so a stray active
            # subscription can be caught and canceled by hand afterward.
            log.warning("could not cancel subscription for deleted user=%s: %s", user_id, e)
    db.delete_user_account(user_id)
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=_is_https(request))
    return {"ok": True}


@router.get("/me")
def me(user_id: str = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    return _public_user(user)


class ForgotPasswordBody(BaseModel):
    email: EmailStr


class ResetPasswordBody(BaseModel):
    token: str = Field(min_length=1)
    password: str = Field(min_length=8, max_length=200)


class ChangePasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


_RESET_EMAIL_HTML = """\
<p>Someone asked to reset the password on this Flexed Academy account.</p>
<p><a href="{link}">Set a new password</a></p>
<p>This link works once, for one hour. If you didn't ask for this, nothing
happens — your password stays what it was.</p>
"""

_GOOGLE_ACCOUNT_EMAIL_HTML = """\
<p>Someone asked to reset the password on this Flexed Academy account, but
this account signs in with Google — there's no password to reset.</p>
<p>Use "Continue with Google" on the sign-in page instead.</p>
"""


@router.post("/forgot-password")
def forgot_password(body: ForgotPasswordBody, request: Request):
    """Deliberately the same response whether or not the email has an
    account — the status code and body can't be the tell that reveals which
    addresses are registered. What actually happens (nothing / a reset link /
    a "use Google instead" nudge) is decided here, invisibly to the caller."""
    user = db.get_user_by_email(body.email)
    if user and user.get("password_hash"):
        token = auth.create_reset_token(user["id"], user["password_hash"])
        link = f"{_frontend_url(request)}/reset-password?token={token}"
        mail.send(
            to=user["email"],
            subject="Reset your Flexed Academy password",
            html=_RESET_EMAIL_HTML.format(link=link),
        )
    elif user:
        # Exists, but Google-only. Telling THEM this is fine — it's the
        # single most useful thing to say, and it's their own inbox — it just
        # can't be visible in the API response to the anonymous caller.
        mail.send(
            to=user["email"],
            subject="About your Flexed Academy password",
            html=_GOOGLE_ACCOUNT_EMAIL_HTML,
        )
    else:
        log.info("forgot-password requested for an email with no account")
    return {"ok": True}


@router.post("/reset-password")
def reset_password(body: ResetPasswordBody, request: Request, response: Response):
    """No `user_id = Depends(get_current_user)` — this IS the logged-out
    recovery path; the token in the body is the credential, not the cookie."""
    payload = auth.decode_reset_token(body.token)
    user = db.get_user_by_id(payload["uid"]) if payload else None
    if not user or not auth.verify_reset_fingerprint(payload, user["password_hash"]):
        raise AppError(
            "invalid_reset_token",
            "That reset link is invalid or has expired.",
            status=400,
            hint="Request a new one from the sign-in page.",
        )
    db.update_password(user["id"], auth.hash_password(body.password))
    return _log_in(request, response, db.get_user_by_id(user["id"]))


@router.post("/change-password")
def change_password(body: ChangePasswordBody, user_id: str = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    if not user.get("password_hash"):
        raise AppError(
            "no_password",
            "This account signs in with Google — there's no password to change.",
            status=400,
        )
    if not auth.verify_password(body.current_password, user["password_hash"]):
        raise AppError("invalid_credentials", "That current password is incorrect.", status=401)
    db.update_password(user_id, auth.hash_password(body.new_password))
    return {"ok": True}
