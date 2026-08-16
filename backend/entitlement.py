"""Who may build or revise a plan, and why.

ONE function decides. The API gate, the paywall screen and the account menu all
read the same answer, so the UI can never offer a button the server will refuse
— or, worse, hide one it would have allowed.

The rule, in full:

  * Billing not configured           -> everyone may generate. The gate is inert
                                        until Stripe keys exist, because a gate
                                        with no way through it is a broken app.
  * Under the trailing-week token cap -> may generate. Subscribers get a
                                        higher cap sized to what their own
                                        subscription can safely absorb (see
                                        config.py's own comment on the
                                        number); everyone else gets the free
                                        cap.
  * Under the trailing-day burst cap  -> also required, on top of the above.
                                        A weekly cap alone still lets someone
                                        spend the WHOLE week's budget in one
                                        sitting — fine for a bug, not fine
                                        for a script. This just slows that
                                        down to "a very good day," not "a bad
                                        fifteen minutes."
  * Otherwise                        -> may NOT generate or revise until usage
                                        from more than a week (or a day, for
                                        the burst cap) ago rolls off, but may
                                        still open, download and read
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

# The weekly cap alone bounds total spend but not the RATE of it — a script
# with valid credentials could still spend the entire week's allowance in
# one sitting, minutes after it starts, well within generate.py's own
# request-rate limit. This is a second, tighter ceiling on top of the
# weekly one: no more than this fraction of the weekly cap in any trailing
# 24 hours. 35% comfortably covers a real teacher's heaviest realistic day
# (building or revising several classes' weeks in one sitting) while still
# turning "blow the whole week in 15 minutes" into "blow the whole week
# over multiple days" — slow enough to catch and act on before it repeats.
BURST_WINDOW_HOURS = 24
BURST_FRACTION = 0.35


@dataclass(frozen=True)
class Entitlement:
    may_generate: bool
    subscribed: bool
    status: str | None
    plans_used: int
    tokens_used: int
    token_cap: int | None
    billing_enabled: bool
    period_end: str | None = None
    # The burst side of the gate — see BURST_WINDOW_HOURS/BURST_FRACTION.
    # Carried on the entitlement (not just used internally) so a 402 raised
    # for burst specifically can say so, rather than pointing a teacher who
    # tripped it mid-afternoon at "wait out the week."
    tokens_used_recent: int = 0
    burst_cap: int | None = 0
    # True comped/unlimited (no custom cap set) — see entitlement()'s own
    # comment. token_cap/burst_cap are None in this state; nothing computed
    # from them (tokens_remaining, burst_limited) makes sense to show.
    unlimited: bool = False

    @property
    def tokens_remaining(self) -> int | None:
        if self.unlimited:
            return None
        return max(0, self.token_cap - self.tokens_used)

    @property
    def burst_limited(self) -> bool:
        if self.unlimited:
            return False
        return self.tokens_used_recent >= self.burst_cap

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
            "burst_limited": self.burst_limited,
            "unlimited": self.unlimited,
        }


def entitlement(user_id: str) -> Entitlement:
    user = db.get_user_by_id(user_id) or {}
    status = user.get("subscription_status")
    subscribed = status in ENTITLED_STATUSES

    # Still worth knowing — the account menu shows it — just not what gates.
    plans_used = db.count_plans(user_id)

    # An admin override (migration 28) wins over everything below it,
    # comped included — a cap an admin deliberately set on THIS account is
    # more specific than "unlimited," so it still applies. None means "no
    # override," not "zero" — a real 0 would be indistinguishable from
    # "unset" otherwise, and would silently lock an account out with no way
    # to tell that apart from a bug.
    custom_cap = user.get("custom_weekly_token_cap")

    # 'comped' has meant "unlimited access" since routes/admin.py's own
    # module docstring and every "Grant unlimited" button in the admin UI —
    # but this function never actually implemented that. It only ever chose
    # BETWEEN the two tier caps, so a comped account was really just riding
    # the subscriber cap, same as a paying one. Invisible while that cap was
    # 2,000,000 (loose enough that nobody ever hit it); it stopped being
    # invisible the moment that cap was resized to a real dollar ceiling
    # (config.py) — a comped account hits that same real wall now, which is
    # exactly backwards from what "unlimited" is supposed to mean. Fixed
    # here rather than by raising the number again: the bug was that comped
    # was never actually a distinct case, not that the cap was too small.
    unlimited = custom_cap is None and status == "comped"

    since = (datetime.now(timezone.utc) - timedelta(days=USAGE_WINDOW_DAYS)).isoformat(timespec="seconds")
    tokens_used = db.tokens_used_since(user_id, since)

    if unlimited:
        return Entitlement(
            may_generate=True,
            subscribed=subscribed,
            status=status,
            plans_used=plans_used,
            tokens_used=tokens_used,
            token_cap=None,
            billing_enabled=settings.billing_enabled,
            period_end=user.get("subscription_period_end"),
            tokens_used_recent=0,
            burst_cap=None,
            unlimited=True,
        )

    cap = custom_cap if custom_cap is not None else (
        settings.subscriber_weekly_token_cap if subscribed else settings.free_weekly_token_cap
    )
    burst_since = (datetime.now(timezone.utc) - timedelta(hours=BURST_WINDOW_HOURS)).isoformat(timespec="seconds")
    tokens_used_recent = db.tokens_used_since(user_id, burst_since)
    burst_cap = int(cap * BURST_FRACTION)

    may_generate = not settings.billing_enabled or (tokens_used < cap and tokens_used_recent < burst_cap)
    return Entitlement(
        may_generate=may_generate,
        subscribed=subscribed,
        status=status,
        plans_used=plans_used,
        tokens_used=tokens_used,
        token_cap=cap,
        billing_enabled=settings.billing_enabled,
        period_end=user.get("subscription_period_end"),
        tokens_used_recent=tokens_used_recent,
        burst_cap=burst_cap,
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
    # Same 402 shape either way (the paywall/account-menu UI only branches on
    # may_generate), but the message a teacher who tripped the BURST cap
    # mid-afternoon actually needs is different from the one who's genuinely
    # out for the week — "wait out the week" is both wrong and alarming for
    # something that clears in well under a day.
    if ent.burst_limited:
        raise AppError(
            "subscription_required",
            "That’s a lot of generating in a short window.",
            status=402,
            hint="This isn’t your weekly limit — it’s a pace check, and it clears within a day. "
            "Everything you’ve already built stays yours — open it, revise it, download it.",
            extra={"entitlement": ent.as_dict()},
        )
    raise AppError(
        "subscription_required",
        "You’ve reached this week’s usage limit.",
        status=402,
        hint="It resets on a rolling week — subscribe for a much higher limit, or wait it out. "
        "Everything you’ve already built stays yours — open it, revise it, download it.",
        extra={"entitlement": ent.as_dict()},
    )
