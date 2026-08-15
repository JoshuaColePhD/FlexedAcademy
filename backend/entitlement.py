"""Who may build or revise a plan, and why.

ONE function decides. The API gate, the paywall screen and the account menu all
read the same answer, so the UI can never offer a button the server will refuse
— or, worse, hide one it would have allowed.

The rule, in full:

  * Billing not configured           -> everyone may generate. The gate is inert
                                        until Stripe keys exist, because a gate
                                        with no way through it is a broken app.
  * Under the trailing-week token cap -> may generate. Subscribers get a much
                                        higher cap (a safety net, not a real
                                        limit); everyone else gets the free cap.
  * Otherwise                        -> may NOT generate or revise until usage
                                        from more than a week ago rolls off,
                                        but may still open, download and read
                                        everything already built. Downloads are
                                        never gated at all.

This replaces "one free plan, ever" (migration 15, db.count_plans). That gated
on plan COUNT, so a teacher who revised the same week fifteen times paid
nothing extra while one who built two short weeks was locked out — the thing
actually being protected (API spend) was never what was being measured. Token
usage, recorded by every model call in llm.py via db.record_usage, is.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from . import db
from .config import settings
from .errors import AppError

# Stripe statuses that mean "this person is paid up", plus our own 'comped'.
# 'past_due' is deliberately included: a card that failed a retry should not
# lock a teacher out mid-week over a billing hiccup Stripe is still working on.
ENTITLED_STATUSES = frozenset({"active", "trialing", "past_due", "comped"})

# A rolling window, not a calendar week — "used a lot Sunday night" shouldn't
# reset just because it's now Monday morning. Matches the app's own "one week
# at a time" framing closely enough without needing a stored period boundary.
USAGE_WINDOW_DAYS = 7


@dataclass(frozen=True)
class Entitlement:
    may_generate: bool
    subscribed: bool
    status: str | None
    plans_used: int
    tokens_used: int
    token_cap: int
    billing_enabled: bool
    period_end: str | None = None

    @property
    def tokens_remaining(self) -> int:
        return max(0, self.token_cap - self.tokens_used)

    def as_dict(self) -> dict:
        return {
            "may_generate": self.may_generate,
            "subscribed": self.subscribed,
            "status": self.status,
            "plans_used": self.plans_used,
            "tokens_used": self.tokens_used,
            "token_cap": self.token_cap,
            "tokens_remaining": self.tokens_remaining,
            "usage_window_days": USAGE_WINDOW_DAYS,
            "billing_enabled": self.billing_enabled,
            "period_end": self.period_end,
        }


def entitlement(user_id: str) -> Entitlement:
    user = db.get_user_by_id(user_id) or {}
    status = user.get("subscription_status")
    subscribed = status in ENTITLED_STATUSES

    # Still worth knowing — the account menu shows it — just not what gates.
    plans_used = db.count_plans(user_id)

    # Admin-editable via the Settings tab (routes/admin.py) — config.py's own
    # values are only the seed for app_settings' singleton row, read here so
    # a cap change takes effect on the next request, not the next deploy.
    caps = db.get_app_settings()
    cap = caps["subscriber_weekly_token_cap"] if subscribed else caps["free_weekly_token_cap"]
    since = (datetime.now(timezone.utc) - timedelta(days=USAGE_WINDOW_DAYS)).isoformat(timespec="seconds")
    tokens_used = db.tokens_used_since(user_id, since)

    may_generate = not settings.billing_enabled or tokens_used < cap
    return Entitlement(
        may_generate=may_generate,
        subscribed=subscribed,
        status=status,
        plans_used=plans_used,
        tokens_used=tokens_used,
        token_cap=cap,
        billing_enabled=settings.billing_enabled,
        period_end=user.get("subscription_period_end"),
    )


def require_entitlement(user_id: str) -> None:
    """The one gate, on every door that spends real tokens: /generate,
    /generate_stream, /chat_stream, /revise_day, /plans/{id}/revise,
    /plans/{id}/quiz. Downloads
    are never gated — nothing about reading what's already built costs
    another token.

    Used to gate only plan CREATION — "revising is not generating" made sense
    when the free tier was one plan, ever: a teacher fixing Thursday was still
    working on the week they already had. It stops making sense once the
    limit is a token budget instead of a plan count, since a revision spends
    real tokens too — leaving it unmetered would let exactly the runaway cost
    this exists to prevent through the one door left unlocked.
    """
    ent = entitlement(user_id)
    if ent.may_generate:
        return
    raise AppError(
        "subscription_required",
        "You’ve reached this week’s usage limit.",
        status=402,
        hint="It resets on a rolling week — subscribe for a much higher limit, or wait it out. "
        "Everything you’ve already built stays yours — open it, revise it, download it.",
        extra={"entitlement": ent.as_dict()},
    )
