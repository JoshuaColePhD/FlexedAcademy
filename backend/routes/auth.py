"""Signup, login, logout — see backend/auth.py for the hashing/cookie mechanics."""
from __future__ import annotations

import logging

import psycopg2.errors
from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, EmailStr, Field

from .. import auth, db, mail, stripe_api
from ..config import settings
from ..deps import COOKIE_NAME, get_current_user
from ..entitlement import entitlement
from ..errors import AppError
from ..ratelimit import limiter

log = logging.getLogger("flexedacademy.auth")

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
    return {
        "httponly": True,
        "samesite": "lax",
        "secure": _is_https(request),
        "max_age": auth.SESSION_MAX_AGE_SECONDS,
    }


def _public_user(user: dict) -> dict:
    """What the browser is allowed to know about the signed-in account.

    `entitlement` rides along so the app never has to guess whether the Build
    button will work — one server-side answer, read by the paywall, the
    composer and the account menu alike.
    """
    ent = entitlement(user["id"], user)
    return {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "avatar": user.get("avatar"),
        "is_admin": bool(user.get("is_admin")),
        # Never the hash itself — just whether one exists, so the settings
        # page can decide between "change password" and "this account signs
        # in with Google" without guessing from anything else client-side.
        "has_password": bool(user.get("password_hash")),
        # Global custom instructions (backend/prompts.py) — read here, not a
        # separate GET, since /api/auth/me is already the one place the
        # frontend refetches the account from after any settings change.
        "custom_instructions": user.get("custom_instructions"),
        "school": user.get("school"),
        # SettingsPage.jsx's "Enable Beta Features" toggle — gates Voice Mode
        # (ChatPage.jsx's openVoice) so a rollout-in-progress feature isn't on
        # by default for every account.
        "beta_features": bool(user.get("beta_features")),
        # NULL means the post-login onboarding wizard (OnboardingWizard.jsx)
        # hasn't run for this account yet — AppShell reads this, not a
        # separate GET, to decide whether to mount it.
        "onboarding_seen_at": user.get("onboarding_seen_at"),
        # `user` passed through so entitlement() doesn't re-SELECT the row this
        # function is already holding (and that deps.get_current_user fetched
        # before that) — three reads of one row per request, each its own
        # pooled connection and SET LOCAL round trip.
        "entitlement": ent.as_dict(),
        # Reuses entitlement's own count instead of db.get_plan_count, which is
        # character-for-character the same query (SELECT COUNT(*) FROM plans
        # WHERE user_id = ?) as db.count_plans that entitlement() already ran.
        # It was genuinely being executed twice on every single /api/auth/me.
        "generated_plan_count": ent.plans_used,
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
@limiter.limit("5/minute")
def signup(body: SignupBody, request: Request, response: Response):
    existing = db.get_user_by_email(body.email)
    if existing is None:
        user = db.create_user(body.email, body.name, auth.hash_password(body.password))
        return _log_in(request, response, user)

    # An existing email is ALWAYS a refusal now.
    #
    # This used to have a middle branch: if the existing row had no password, it
    # was treated as an unclaimed placeholder seat, so signup set a password on
    # it and logged the caller straight in as its owner. That was a full account
    # takeover, and it was live.
    #
    # The branch was written for "the 'default_user' row seeded by the v6
    # migration, or any future account created without a login (an
    # admin-provisioned seat, say)" — db.claim_user's own docstring. That premise
    # expired the day Google sign-in was added: google_login below creates real,
    # fully-populated accounts with password_hash = None and nothing ever fills
    # it in (forgot_password deliberately refuses a NULL-hash account and tells
    # them to use Google). So EVERY Google account in the product sat in the
    # exact state this branch read as "free to claim".
    #
    # Verified before removing it: POST /api/auth/signup with a Google-created
    # account's email and any password returned 200, issued a valid 30-day
    # session for that account, and overwrote the owner's name. School email
    # addresses are guessable by construction, which is the whole attack.
    #
    # There is no seat-provisioning route in this app — claim_user had exactly
    # one caller, this one — so nothing legitimate is lost by refusing. A teacher
    # whose account has no password is a Google user, and the hint says so
    # instead of silently handing their account to whoever asked.
    if existing["password_hash"] is None:
        raise AppError(
            "email_taken",
            "An account with that email already exists.",
            hint="Use “Continue with Google” to sign in.",
            status=409,
        )
    raise AppError(
        "email_taken",
        "An account with that email already exists.",
        hint="Log in instead.",
        status=409,
    )


@router.post("/login")
@limiter.limit("10/minute")
def login(body: LoginBody, request: Request, response: Response):
    user = db.get_user_by_email(body.email)
    if not user or not user["password_hash"] or not auth.verify_password(body.password, user["password_hash"]):
        raise AppError("invalid_credentials", "Incorrect email or password.", status=401)
    # Caught here too, not just in deps._verify_current — that check is what
    # actually enforces this on every later request, but without this the
    # correct password for an expired beta account would appear to log in
    # successfully and then get silently bounced on the very next request.
    # A clear message at the point of login beats a confusing instant logout.
    expires = user.get("beta_expires_at")
    if expires and expires <= db.now():
        raise AppError(
            "beta_expired",
            "This beta account's trial period has ended.",
            status=401,
            hint="Contact Josh Cole if you'd like it extended.",
        )
    return _log_in(request, response, user)


@router.post("/google")
@limiter.limit("10/minute")
def google_login(body: GoogleLoginBody, request: Request, response: Response):
    idinfo = auth.verify_google_token(body.credential)
    if not idinfo:
        raise AppError("invalid_credentials", "Invalid Google token.", status=401)
        
    email = idinfo.get("email")
    # Guard BEFORE deriving the name. It used to sit two lines lower, after
    # `email.split("@")[0]`, so a credential with no email claim raised
    # AttributeError on None and surfaced as an opaque 500 instead of the 401
    # this line was written to return.
    if not email:
        raise AppError("invalid_credentials", "Google token missing email.", status=401)

    # An email address in a Google token only identifies a person if Google says
    # they proved they own it. verify_google_token checks the signature, the
    # expiry and the audience — nothing was checking this claim, so a Google
    # account bearing a teacher's address without having verified it would be
    # matched to her existing account by the lookup below.
    #
    # Explicitly-false is refused; absent is allowed with a warning rather than
    # a refusal, because locking a real teacher out of her own account over a
    # claim Google normally always sends is the worse failure of the two.
    if idinfo.get("email_verified") is False:
        raise AppError(
            "invalid_credentials",
            "That Google account hasn’t verified its email address.",
            hint="Verify the address with Google, then try again.",
            status=401,
        )
    if "email_verified" not in idinfo:
        log.warning("google token for %s carried no email_verified claim", email)

    name = idinfo.get("name") or email.split("@")[0]

    # Matched on Google's `sub` first — the stable, immutable id for the Google
    # account — and only then on the email string. Email is mutable and
    # reassignable; treating it as the identity is what let signup() confuse a
    # Google account for an unclaimed seat. Falling back to email keeps every
    # existing account working (none of them carry a sub yet) and attaches the
    # sub the first time they sign in, so the linkage backfills itself.
    sub = idinfo.get("sub")
    user = db.get_user_by_google_sub(sub) if sub else None
    if not user:
        user = db.get_user_by_email(email)
    if user:
        if sub and not user.get("google_sub"):
            db.link_google_sub(user["id"], sub)
    else:
        # No password_hash because they authenticate via Google. That state is
        # no longer claimable by signup() — see the comment there.
        try:
            user = db.create_user(email, name, password_hash=None)
        except psycopg2.errors.UniqueViolation:
            # Two first-time Google sign-ins for the same brand-new email,
            # close enough together that both passed the get_user_by_email
            # check above and both tried to INSERT — users.email is UNIQUE, so
            # the loser's INSERT raised instead of returning a row, and with
            # nothing catching it that surfaced as an opaque 500 on the losing
            # request rather than a normal login. db.borrow()'s own context
            # manager already rolls back the connection on any exception, so
            # nothing more is needed there — just re-fetch the row the winner
            # created and proceed exactly as the "user found" branch above
            # would have.
            user = db.get_user_by_email(email)
            if not user:
                raise
        if sub:
            db.link_google_sub(user["id"], sub)

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
    db.record_audit_log(user_id, "account.delete", target_user_id=user_id, detail={"email": user.get("email")})
    db.delete_user_account(user_id)
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax", secure=_is_https(request))
    return {"ok": True}



@router.put("/avatar")
def set_avatar(body: AvatarBody, user_id: str = Depends(get_current_user)):
    db.update_user_avatar(user_id, body.avatar)
    user = db.get_user_by_id(user_id)
    return _public_user(user)

@router.get("/me")
def me(user_id: str = Depends(get_current_user)):
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)
    return _public_user(user)


@router.post("/onboarding-seen")
def mark_onboarding_seen_route(user_id: str = Depends(get_current_user)):
    """Called once, when OnboardingWizard.jsx closes (finished OR skipped —
    see db.mark_onboarding_seen's own comment on why those are the same
    state). Idempotent, so a double-fire from a fast double-click costs
    nothing."""
    user = db.mark_onboarding_seen(user_id)
    if not user:
        raise AppError("not_found", "No such user.", status=404)
    return _public_user(user)


class ForgotPasswordBody(BaseModel):
    email: EmailStr


class ResetPasswordBody(BaseModel):
    token: str = Field(min_length=1)
    password: str = Field(min_length=8, max_length=200)



class AvatarBody(BaseModel):
    # Nullable: the picker's own "Default" option clears back to no avatar
    # (SettingsPage.jsx's AvatarSelect calls handleSelect(null)) — a
    # required str here rejected that request outright before it ever
    # reached db.update_user_avatar.
    avatar: str | None = Field(default=None, max_length=100)

class ChangePasswordBody(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=8, max_length=200)


_RESET_EMAIL_HTML = """\
<p>Someone asked to reset the password on this FlexEd Academy account.</p>
<p><a href="{link}">Set a new password</a></p>
<p>This link works once, for one hour. If you didn't ask for this, nothing
happens — your password stays what it was.</p>
"""

_GOOGLE_ACCOUNT_EMAIL_HTML = """\
<p>Someone asked to reset the password on this FlexEd Academy account, but
this account signs in with Google — there's no password to reset.</p>
<p>Use "Continue with Google" on the sign-in page instead.</p>
"""


@router.post("/forgot-password")
@limiter.limit("5/minute")
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
            subject="Reset your FlexEd Academy password",
            html=_RESET_EMAIL_HTML.format(link=link),
        )
    elif user:
        # Exists, but Google-only. Telling THEM this is fine — it's the
        # single most useful thing to say, and it's their own inbox — it just
        # can't be visible in the API response to the anonymous caller.
        mail.send(
            to=user["email"],
            subject="About your FlexEd Academy password",
            html=_GOOGLE_ACCOUNT_EMAIL_HTML,
        )
    else:
        log.info("forgot-password requested for an email with no account")
    return {"ok": True}


@router.post("/reset-password")
@limiter.limit("10/minute")
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
    # Revoke every OTHER session before issuing this one.
    #
    # A password reset is the thing a teacher does when she thinks somebody got
    # into her account. Without this, the intruder's cookie kept working for up
    # to 30 more days: sessions are stateless and validity is decided purely by
    # `session_version` matching the `sv` claim (deps._verify_current), and
    # neither reset nor change-password touched it — the only caller of
    # bump_session_version was sign-out-everywhere. So the one action that is
    # supposed to lock everyone out locked nobody out.
    #
    # Bumped BEFORE _log_in on purpose: _log_in mints the new cookie from the
    # user row, so it picks up the new version and this device stays signed in
    # while every other one is dropped.
    db.bump_session_version(user["id"])
    return _log_in(request, response, db.get_user_by_id(user["id"]))


@router.post("/change-password")
@limiter.limit("10/minute")
def change_password(body: ChangePasswordBody, request: Request, user_id: str = Depends(get_current_user)):
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
    # Same reasoning as reset_password above. This route has no Response to set
    # a fresh cookie on, so the bump signs this device out too — which is the
    # correct, conventional behaviour for "I changed my password": everyone
    # re-authenticates, including me.
    db.bump_session_version(user_id)
    return {"ok": True, "signed_out_everywhere": True}
