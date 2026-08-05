"""Signup, login, logout — see backend/auth.py for the hashing/cookie mechanics."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db
from ..deps import COOKIE_NAME, get_current_user
from ..errors import AppError

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Same-site, not cross-site: the dev frontend (5173/5174) and backend (8010)
# are different ports on one machine, which browsers treat as same-site for
# this purpose. `secure=False` is correct for the current 127.0.0.1-only,
# HTTP-only deployment — flip it once this sits behind HTTPS, or the cookie
# stops being sent at all.
COOKIE_KWARGS = dict(httponly=True, samesite="lax", secure=False, max_age=auth.SESSION_MAX_AGE_SECONDS)


def _public_user(user: dict) -> dict:
    return {"id": user["id"], "email": user["email"], "name": user["name"]}


def _log_in(response: Response, user: dict) -> dict:
    token = auth.create_session_token(user["id"])
    response.set_cookie(COOKIE_NAME, token, **COOKIE_KWARGS)
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
def signup(body: SignupBody, response: Response):
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
    return _log_in(response, user)


@router.post("/login")
def login(body: LoginBody, response: Response):
    user = db.get_user_by_email(body.email)
    if not user or not user["password_hash"] or not auth.verify_password(body.password, user["password_hash"]):
        raise AppError("invalid_credentials", "Incorrect email or password.", status=401)
    return _log_in(response, user)


@router.post("/google")
def google_login(body: GoogleLoginBody, response: Response):
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
        
    return _log_in(response, user)


@router.post("/logout")
def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/me")
def me(user_id: str = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    return _public_user(user)
