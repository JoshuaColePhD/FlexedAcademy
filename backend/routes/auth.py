"""Signup, login, logout — see backend/auth.py for the hashing/cookie mechanics."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db
from ..config import settings
from ..deps import COOKIE_NAME, get_current_user
from ..entitlement import entitlement
from ..errors import AppError

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
        "entitlement": entitlement(user["id"]).as_dict(),
    }


def _log_in(request: Request, response: Response, user: dict) -> dict:
    token = auth.create_session_token(user["id"])
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


@router.get("/me")
def me(user_id: str = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    return _public_user(user)
