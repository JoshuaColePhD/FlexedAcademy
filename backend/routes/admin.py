"""Account management, as a page instead of SQL run by hand.

Everything here used to be a query typed straight into the Supabase SQL
editor. That doesn't scale past "the one person building this app" — it means
every account question routes through whoever has database access, and every
"give this teacher unlimited access" is a bespoke UPDATE. One page, gated by
the is_admin column rather than a hardcoded email list, so revoking access is
a data change, not a redeploy.
"""
from __future__ import annotations

import json
import secrets
import string
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel, EmailStr, Field, field_validator

from .. import auth, db, mail, qa, storage, stripe_api, template_intake
from ..config import settings
from ..deps import get_current_admin
from ..entitlement import ENTITLED_STATUSES
from ..errors import AppError

router = APIRouter(prefix="/api/admin", tags=["admin"])


# Two capitalized words and four digits — easy to read off a screen or a
# sticky note and type on a phone keyboard, unlike a random mixed-case+symbol
# string. secrets.choice, not random.choice: this is a real credential, not a
# UI affordance, so it needs a cryptographically secure source. This word list
# squared, times the digit range, is ~2.3 x 10^7 combinations — comfortably
# out of reach of the login route's own 5/minute rate limit for the 7-day
# window these accounts exist, without asking anyone to type symbols.
_PASSWORD_WORDS = [
    "amber", "arbor", "birch", "briar", "cedar", "cliff", "clover", "coral",
    "crane", "creek", "delta", "ember", "falcon", "fern", "flint", "grove",
    "harbor", "hazel", "heron", "ivory", "juniper", "lark", "linen", "lotus",
    "maple", "meadow", "moss", "onyx", "opal", "otter", "pebble", "quartz",
    "raven", "reed", "ridge", "river", "robin", "sage", "shale", "slate",
    "sparrow", "spruce", "swift", "thistle", "tidal", "willow", "wren", "zephyr",
]


def _generate_password() -> str:
    words = "".join(secrets.choice(_PASSWORD_WORDS).capitalize() for _ in range(2))
    digits = "".join(secrets.choice(string.digits) for _ in range(4))
    return f"{words}{digits}"


@router.get("/accounts")
def list_accounts(_admin: str = Depends(get_current_admin)):
    return {"accounts": db.list_accounts_with_stats()}


@router.get("/usage-trend")
def usage_trend(_admin: str = Depends(get_current_admin)):
    """Site-wide weekly usage for the admin panel's trend chart — see
    db.weekly_usage_series's own docstring for why this is a separate,
    bucketed query rather than something list_accounts already carries."""
    return {"weeks": db.weekly_usage_series()}


@router.get("/qa/standards-check")
def standards_check(_admin: str = Depends(get_current_admin)):
    """Every plan, admin-wide, whose cited standards don't hold up against
    its own class's subject/grade — see qa.py's own module docstring for
    what "don't hold up" means and why. On-demand, not cached: this is a
    handful of in-memory dict lookups per plan against an already-loaded,
    already-cached corpus (retrieval.py's own lru_cache), not a fresh model
    call or a fresh corpus load."""
    return {"flagged": qa.run_standards_check()}


class CompBody(BaseModel):
    comped: bool


@router.post("/accounts/{account_id}/comp")
def set_comped(account_id: str, body: CompBody, _admin: str = Depends(get_current_admin)):
    """Grant or revoke unlimited free access.

    Revoking clears the status back to NULL rather than 'canceled' — the
    account was never a Stripe subscriber, so a status implying a lapsed
    subscription would be a fabricated billing history. NULL just means "no
    subscription", which is the truth: they fall back to the ordinary free
    week like anyone else.
    """
    if body.comped:
        db.set_subscription(account_id, status="comped")
    else:
        db.clear_subscription_status(account_id)
    db.log_admin_action(_admin, "comp_grant" if body.comped else "comp_revoke", target=account_id)
    db.record_audit_log(
        _admin, "admin.set_comped", target_user_id=account_id, detail={"comped": body.comped}
    )
    return {"account": next(
        (a for a in db.list_accounts_with_stats() if a["id"] == account_id), None
    )}


class CapBody(BaseModel):
    # None clears the override back to "use the tier's own cap" — see
    # migration 28 / entitlement.py. A real 0 is legal too (fully throttle
    # one account without suspending it outright), so this has to stay
    # nullable rather than defaulting to some sentinel.
    cap: int | None = Field(default=None, ge=0)


@router.post("/accounts/{account_id}/cap")
def set_custom_cap(account_id: str, body: CapBody, _admin: str = Depends(get_current_admin)):
    """The middle ground between "the ordinary tier cap" and "comped"
    (unlimited) — give ONE account more headroom without unlocking it
    entirely, or throttle one down without suspending it. Everyone else is
    unaffected; this only ever touches the account named in the URL."""
    db.set_custom_token_cap(account_id, body.cap)
    return {"account": next(
        (a for a in db.list_accounts_with_stats() if a["id"] == account_id), None
    )}


class BetaAccountBody(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=120)
    # A week by default, per how these are actually being used — a fixed
    # trial window, not an open-ended comped account.
    days: int = Field(default=7, ge=1, le=90)
    # Omitted (the normal case): a real, unique, generated password per
    # account. Set: every account created in this call shares exactly this
    # password — for handing a small batch of easy-to-type test accounts
    # (test1@, test2@...) to people who don't need distinct credentials from
    # each other. Same min_length as SignupBody's own password field, for
    # the same reason a real login is going to be checked against it.
    password: str | None = Field(default=None, min_length=8, max_length=200)


@router.post("/beta-accounts", status_code=201)
def create_beta_account_route(body: BetaAccountBody, _admin: str = Depends(get_current_admin)):
    """One real account, ready to hand off: a generated password (returned
    ONCE, here, and never again — like everything else in this codebase that
    stores a hash and nothing else), the subscriber usage tier so a beta
    tester experiences the product's real limits rather than either extreme,
    and an expiry that ends the trial on its own with no follow-up step.

    Deliberately NOT pre-seeded with a class or anything else — the whole
    point of a beta account is that it starts exactly where a real new
    signup does: no classes, onboarding_seen_at NULL, straight through
    /welcome and the onboarding wizard like any brand-new teacher.
    """
    if db.get_user_by_email(body.email):
        raise AppError(
            "email_taken",
            "An account with that email already exists.",
            status=409,
        )
    password = body.password or _generate_password()
    user = db.create_beta_account(
        body.email, body.name, auth.hash_password(password), days=body.days
    )
    return {
        "account": next((a for a in db.list_accounts_with_stats() if a["id"] == user["id"]), None),
        # The only place this value ever exists outside the teacher's own
        # head — nothing re-derives or re-displays it after this response.
        "password": password,
    }


class ExtendBetaBody(BaseModel):
    days: int = Field(default=7, ge=1, le=90)


@router.post("/accounts/{account_id}/extend-beta")
def extend_beta_account_route(account_id: str, body: ExtendBetaBody, _admin: str = Depends(get_current_admin)):
    """Push the expiry `days` out from right now. Only meaningful on an
    account that already has one — extending a normal account's (nonexistent)
    trial would silently turn it into a time-boxed one."""
    existing = next((a for a in db.list_accounts_with_stats() if a["id"] == account_id), None)
    if not existing or not existing.get("beta_expires_at"):
        raise AppError("not_a_beta_account", "That account has no trial period to extend.", status=400)
    db.extend_beta_account(account_id, days=body.days)
    return {"account": next((a for a in db.list_accounts_with_stats() if a["id"] == account_id), None)}


@router.post("/accounts/{account_id}/end-beta")
def end_beta_account_route(account_id: str, _admin: str = Depends(get_current_admin)):
    """Ends the trial immediately — the account stops authenticating on its
    very next request, same as if its 7 days had already run out."""
    existing = next((a for a in db.list_accounts_with_stats() if a["id"] == account_id), None)
    if not existing or not existing.get("beta_expires_at"):
        raise AppError("not_a_beta_account", "That account has no trial period to end.", status=400)
    db.end_beta_account(account_id)
    return {"account": next((a for a in db.list_accounts_with_stats() if a["id"] == account_id), None)}


@router.get("/entitled-statuses")
def entitled_statuses(_admin: str = Depends(get_current_admin)):
    """What the app currently treats as "may generate", for display only —
    the page can show it without hardcoding a second copy of the rule."""
    return {"statuses": sorted(ENTITLED_STATUSES)}


class SchoolBody(BaseModel):
    # A plain slug, not just "non-empty": this becomes a filesystem path
    # component (calendars_dir / f"{id}.md"), so it's validated as one here
    # rather than trusted as arbitrary text.
    id: str = Field(min_length=1, max_length=64, pattern=r"^[a-z0-9]+(-[a-z0-9]+)*$")
    name: str = Field(min_length=1, max_length=120)


@router.post("/schools", status_code=201)
def create_school_route(body: SchoolBody, _admin: str = Depends(get_current_admin)):
    """Registers a school that already has a calendar file — never the other
    way around. This is the hand-curated path: an admin hand-authors
    backend/context/calendars/<id>.md and commits it FIRST, then registers
    the row here. Teachers have a separate, parallel path that needs no
    admin step at all — routes/school_calendars.py's upload-and-
    peer-confirm flow creates the `schools` row itself and stores the
    calendar as a DB row rather than a file (see schoolcal.py's own comment
    on why both paths coexist)."""
    if db.get_school(body.id):
        raise AppError("already_exists", f"A school with id {body.id!r} already exists.", status=409)
    calendar_file = settings.calendars_dir / f"{body.id}.md"
    if not calendar_file.is_file():
        raise AppError(
            "calendar_missing",
            f"No calendar file for {body.id!r}.",
            status=400,
            hint=f"Add backend/context/calendars/{body.id}.md and commit it, then try again.",
        )
    school = db.create_school(body.id, body.name)
    db.log_admin_action(_admin, "school_add", target=body.id, detail={"name": body.name})
    db.record_audit_log(_admin, "admin.create_school", detail={"school_id": body.id, "name": body.name})
    return school


@router.delete("/schools/{school_id}", status_code=204)
def delete_school_route(school_id: str, _admin: str = Depends(get_current_admin)):
    if not db.get_school(school_id):
        raise AppError("not_found", "That school doesn't exist.", status=404)
    in_use = db.count_users_with_school(school_id)
    if in_use:
        raise AppError(
            "school_in_use",
            f"{in_use} account(s) still use this school.",
            status=409,
            hint="Reassign those accounts to a different school first.",
        )
    db.delete_school(school_id)
    db.log_admin_action(_admin, "school_remove", target=school_id)
    db.record_audit_log(_admin, "admin.delete_school", detail={"school_id": school_id})


@router.get("/calendar-submissions")
def list_calendar_submissions_route(status: str | None = None, _admin: str = Depends(get_current_admin)):
    """The queue behind SchoolsAdmin's pending-calendar section — every
    teacher-uploaded calendar, admin-wide, regardless of which school it's
    for. `status` filters to 'pending' | 'confirmed' | 'rejected'."""
    return {"submissions": db.list_calendar_submissions(status)}


@router.post("/calendar-submissions/{submission_id}/approve")
def approve_calendar_submission_route(submission_id: str, admin_id: str = Depends(get_current_admin)):
    """Admin override — confirms directly regardless of who submitted it,
    for the case where no second teacher at that school is around yet to
    do the normal peer confirmation."""
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    return db.confirm_calendar_submission(submission_id, admin_id)


@router.post("/calendar-submissions/{submission_id}/reject")
def reject_calendar_submission_route(submission_id: str, _admin: str = Depends(get_current_admin)):
    submission = db.get_calendar_submission(submission_id)
    if not submission:
        raise AppError("not_found", "That submission doesn't exist.", status=404)
    if submission["status"] != "pending":
        raise AppError("not_pending", "That submission has already been decided.", status=409)
    return db.reject_calendar_submission(submission_id)


@router.get("/school-templates/pending")
def list_pending_school_templates_route(_admin: str = Depends(get_current_admin)):
    return {"templates": db.list_pending_school_templates()}


@router.post("/schools/{school_id}/activate-template")
def activate_school_template_route(school_id: str, _admin: str = Depends(get_current_admin)):
    school = db.get_school(school_id)
    if not school:
        raise AppError("not_found", "School not found.", status=404)
        
    db.update_school_template_status(school_id, "active")

    latest_template = db.get_latest_school_template(school_id)
    if latest_template and latest_template.get("uploader_email"):
        mail.send_template_active_email(
            to=latest_template["uploader_email"],
            uploader_name=latest_template.get("uploader_name"),
            school_name=school["name"],
        )

    return {"status": "ok"}


@router.get("/school-templates/auto-activated")
def list_auto_activated_templates_route(_admin: str = Depends(get_current_admin)):
    """The audit trail for template_intake._maybe_auto_activate — every
    template that went active with no admin ever clicking anything, most
    recent first."""
    return {"templates": db.list_auto_activated_templates()}


@router.get("/school-templates/{template_id}/analysis")
def get_school_template_analysis_route(template_id: str, _admin: str = Depends(get_current_admin)):
    """Full detail behind one row of the pending-templates queue: the
    deterministic structure, the LLM's (already cross-checked) section
    mapping, and every quality-check finding the pipeline recorded — not
    just the collapsed status badge the list view shows."""
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    return {
        "template": template,
        "structure": json.loads(template["structure_json"]) if template.get("structure_json") else None,
        "analysis": json.loads(template["analysis_summary"]) if template.get("analysis_summary") else None,
        "findings": db.get_template_findings(template_id),
    }


@router.post("/school-templates/{template_id}/reanalyze")
def reanalyze_school_template_route(template_id: str, admin_id: str = Depends(get_current_admin)):
    """Re-runs the same pipeline the upload endpoint ran, against the file
    already on disk — for a transient failure (an LLM hiccup) or after a
    pipeline fix, without asking the school to re-upload anything."""
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    dest_path = Path(template["file_path"])
    if not storage.ensure_local(dest_path):
        raise AppError("not_found", "The original file is missing from disk — a re-upload is needed.", status=404)
    return template_intake.run_and_persist(
        user_id=admin_id,
        template_id=template_id,
        school_id=template["school_id"],
        dest_path=dest_path,
        claimed_ext=dest_path.suffix.lower(),
    )


@router.get("/school-templates/{template_id}/download")
def download_school_template_route(template_id: str, _admin: str = Depends(get_current_admin)):
    from pathlib import Path

    from fastapi.responses import FileResponse
    template = db.get_school_template(template_id)
    if not template:
        raise AppError("not_found", "Template not found.", status=404)
    file_path = Path(template["file_path"])
    if not storage.ensure_local(file_path):
        raise AppError("not_found", "File missing from disk.", status=404)
    return FileResponse(file_path, filename=template["filename"])


class AppSettingsBody(BaseModel):
    # Both required — the row always carries a value for each, so a PUT is a
    # full replace, not a partial patch (unlike CompBody's single field).
    free_weekly_token_cap: int = Field(gt=0, le=100_000_000)
    subscriber_weekly_token_cap: int = Field(gt=0, le=100_000_000)

    @field_validator("subscriber_weekly_token_cap")
    @classmethod
    def _subscriber_at_least_free(cls, v: int, info) -> int:
        free = info.data.get("free_weekly_token_cap")
        if free is not None and v < free:
            raise ValueError("Subscriber cap must be at least the free cap.")
        return v


@router.get("/settings")
def get_app_settings_route(_admin: str = Depends(get_current_admin)):
    return db.get_app_settings()


@router.put("/settings")
def update_app_settings_route(body: AppSettingsBody, _admin: str = Depends(get_current_admin)):
    before = db.get_app_settings()
    after = db.update_app_settings(
        free_weekly_token_cap=body.free_weekly_token_cap,
        subscriber_weekly_token_cap=body.subscriber_weekly_token_cap,
        actor_id=_admin,
    )
    db.log_admin_action(
        _admin,
        "settings_update",
        detail={
            "before": {k: before[k] for k in ("free_weekly_token_cap", "subscriber_weekly_token_cap")},
            "after": {k: after[k] for k in ("free_weekly_token_cap", "subscriber_weekly_token_cap")},
        },
    )
    return after


@router.get("/audit-log")
def get_audit_log_route(limit: int = 50, _admin: str = Depends(get_current_admin)):
    return {"entries": db.list_admin_audit_log(limit=min(limit, 200))}


# Statuses that mean "a real Stripe subscription, paying or trying to" —
# what MRR is computed over. Deliberately NOT the same set as
# entitlement.ENTITLED_STATUSES: 'comped' entitles someone to generate but
# pays nothing, so counting it toward revenue would be fictional income.
_PAYING_STATUSES = frozenset({"active", "trialing", "past_due"})


@router.get("/billing")
def get_billing_route(_admin: str = Depends(get_current_admin)):
    """Revenue and payment-risk, without a Stripe dashboard login.

    MRR is an estimate, not a Stripe-reported figure: (paying accounts) ×
    (the one configured price). True for this app because it only ever
    sells one price, one interval — see stripe_api.get_price's own docstring
    for why the price itself is never hardcoded here either.
    """
    summary = db.billing_summary()
    counts = summary["counts"]
    paying = sum(counts.get(s, 0) for s in _PAYING_STATUSES)

    price = None
    mrr_cents = None
    if settings.billing_enabled:
        try:
            price = stripe_api.get_price(settings.stripe_price_id)
            if price.get("amount") is not None:
                mrr_cents = paying * price["amount"]
        except AppError:
            pass  # A page that can't reach Stripe still shows account counts.

    return {
        "billing_enabled": settings.billing_enabled,
        "counts": counts,
        "paying_accounts": paying,
        "price": price,
        "mrr_cents": mrr_cents,
        "past_due_accounts": summary["past_due_accounts"],
    }
