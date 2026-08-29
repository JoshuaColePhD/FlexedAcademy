"""Who may build or revise a plan, and why.

ONE function decides. The API gate, the paywall screen and the account menu all
read the same answer, so the UI can never offer a button the server will refuse
— or, worse, hide one it would have allowed.

The rule, in full:

  * Billing not configured           -> everyone may generate. The gate is inert
                                        until Stripe keys exist, because a gate
                                        with no way through it is a broken app.
  * Trial expired (unsubscribed,     -> may NOT generate, full stop, until they
    signed up after the cutoff,         subscribe. Unlike the caps below this
    more than trial_period_days ago)    never clears on its own — see
                                        TRIAL_ENFORCEMENT_START.
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
from datetime import UTC, datetime, timedelta

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

# The hard trial cutoff, added after this file's own "reverse trial" removal
# above. That removal was correct — trial_period_days was Stripe's card-
# required trial (config.py), and a *second* time-boxed grant reusing the
# same setting for every unsubscribed status was a bug, not a feature. This
# is a different thing: a free tier that used to run at the usage cap
# forever now expires trial_period_days after signup, at which point
# unsubscribed access stops outright rather than just staying capped.
#
# Grandfathered by date rather than applied retroactively: an account
# created before this shipped signed up under "capped, but no expiry" and
# shouldn't be locked out overnight by a deploy. Only accounts created on or
# after this date are ever subject to the cutoff.
TRIAL_ENFORCEMENT_START = datetime(2026, 8, 28, tzinfo=UTC)

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

# ...but never below the cost of ONE lesson plan, which is the whole reason
# this floor exists. The fraction alone assumes the weekly cap is large
# relative to a single operation; at the free tier it isn't. Measured against
# production usage_events: a single "build me a week" turn runs ~11-14k tokens
# (stream_plan alone averages 10.1k and peaks at 15k, plus expand_query, the
# chat reply, decisions and the title). Against a 20,000 free cap, 35% is
# 7,000 — LESS than one plan. The burst check runs before generating, so the
# first plan was permitted and then every subsequent action was refused for a
# full 24 hours: a rate limiter tighter than the thing it is rating stops
# limiting the rate and just becomes a wall.
#
# 20,000 clears the observed worst case (15k) with room for the rest of the
# turn. Where the fraction is already larger this changes nothing — at the
# 200,000 subscriber cap the burst stays 70,000 — so this only ever lifts a
# floor that had fallen below one unit of real work, and never loosens the
# ceiling for the accounts the burst rule was written to catch.
MIN_BURST_TOKENS = 20_000


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
    # The free trial window has closed for good (TRIAL_ENFORCEMENT_START)
    # — distinct from burst_limited/the weekly cap because it never clears
    # on its own. require_entitlement() needs this to say something truer
    # than "wait it out."
    trial_expired: bool = False
    # Days left before trial_expired flips, for accounts it applies to.
    # None for subscribed/unlimited/grandfathered accounts, where a
    # countdown wouldn't mean anything.
    trial_days_remaining: int | None = None

    @property
    def tokens_remaining(self) -> int | None:
        # unlimited and trial_expired both leave token_cap unset — neither
        # a real cap nor "0 remaining" (which would misleadingly suggest
        # generating again is one token-reset away).
        if self.unlimited or self.token_cap is None:
            return None
        return max(0, self.token_cap - self.tokens_used)

    @property
    def burst_limited(self) -> bool:
        if self.unlimited or self.burst_cap is None:
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
            "trial_expired": self.trial_expired,
            "trial_days_remaining": self.trial_days_remaining,
        }


def entitlement(user_id: str, user: dict | None = None) -> Entitlement:
    """`user` is an optional already-fetched users row for `user_id`.

    Every caller of this function had just loaded that row — deps.py's
    get_current_user fetches it to authenticate the request at all, and
    routes/auth.py's _public_user is holding it while it builds the response —
    and this then went and fetched it a THIRD time. Each of those is a pooled
    connection plus its own `SET LOCAL app.user_id` round trip (db.borrow), so
    the redundant reads cost real latency on the app's single hottest
    endpoint, not just a wasted query. Passing it in is optional so nothing
    breaks if a caller genuinely doesn't have it."""
    if user is None:
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

    # Both usage windows in ONE query (db.tokens_used_two_windows) — the burst
    # window is a strict subset of the trailing week, so it comes off the same
    # scan via a FILTER rather than a second aggregate and a second pooler
    # round trip. Computed up front even though the two early returns below
    # don't read `tokens_used_recent`: it costs nothing extra now that it
    # shares the week's query.
    now_utc = datetime.now(UTC)
    since = (now_utc - timedelta(days=USAGE_WINDOW_DAYS)).isoformat(timespec="seconds")
    burst_since = (now_utc - timedelta(hours=BURST_WINDOW_HOURS)).isoformat(timespec="seconds")
    tokens_used, tokens_used_recent = db.tokens_used_two_windows(user_id, since, burst_since)

    # Only ever applies to unsubscribed accounts created on or after
    # TRIAL_ENFORCEMENT_START — see that constant's own comment for why
    # grandfathering matters here. created_at is always set (db.py's own
    # users table), so this only skips a genuinely pre-cutoff signup.
    trial_expired = False
    trial_days_remaining = None
    created_at = user.get("created_at")
    if settings.billing_enabled and not subscribed and not unlimited and created_at:
        signed_up = datetime.fromisoformat(created_at)
        if signed_up.tzinfo is None:
            signed_up = signed_up.replace(tzinfo=UTC)
        if signed_up >= TRIAL_ENFORCEMENT_START:
            trial_ends = signed_up + timedelta(days=settings.trial_period_days)
            if now_utc >= trial_ends:
                trial_expired = True
            else:
                trial_days_remaining = max(0, (trial_ends - now_utc).days)

    # Inside an active trial, and this account has never been a paying
    # customer — which is what earns the SUBSCRIBER cap below rather than the
    # free one.
    #
    # The landing page has always promised "Get N days of Premium
    # automatically" (LandingPage.jsx), and until now nothing implemented it:
    # a trialing account was simply unsubscribed, so it got
    # free_weekly_token_cap. In production that is 20,000 tokens against a
    # ~11-14k single lesson plan, so the advertised week of Premium was one
    # plan and then a wall.
    #
    # This is NOT the old "reverse trial" this module removed. That one keyed
    # off signup date alone and applied to EVERY non-subscribed status, so a
    # lapsed subscriber who cancelled near their signup date got subscriber
    # caps back for a week — the exact bug rule 5 (and eval/test_entitlement's
    # promise 5) forbids. The stripe_customer_id check is what keeps that from
    # coming back: anyone who has ever checked out has a customer id forever,
    # so 'canceled' and 'incomplete_expired' can never re-enter a trial. It is
    # the same "already been a customer once doesn't get a second trial" rule
    # routes/billing.py already applies to Stripe's own trial eligibility.
    in_trial = trial_days_remaining is not None and not user.get("stripe_customer_id")

    if trial_expired:
        return Entitlement(
            may_generate=False,
            subscribed=subscribed,
            status=status,
            plans_used=plans_used,
            tokens_used=tokens_used,
            token_cap=None,
            billing_enabled=settings.billing_enabled,
            period_end=user.get("subscription_period_end"),
            burst_cap=None,
            trial_expired=True,
        )

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

    # Admin-editable via the Settings tab (routes/admin.py) — config.py's own
    # values are only the seed for app_settings' singleton row (migration
    # 46), read here so a cap change takes effect on the next request, not
    # the next deploy.
    caps = db.get_app_settings()

    # A "reverse trial" (subscriber-tier caps for any unsubscribed account
    # within trial_period_days of signup, no matter its status) used to live
    # here. Removed: trial_period_days is documented in config.py as the
    # Stripe-side, card-required trial (subscription_data.trial_period_days
    # on the Checkout Session) — that comment says outright "no other code
    # needed a trial to exist" before it was added, because ENTITLED_STATUSES
    # already grants full entitlement to Stripe's own 'trialing' status. This
    # second, reused-the-same-setting-for-something-else implementation
    # applied to EVERY non-subscribed status, including 'canceled' and
    # 'incomplete_expired' — which rule 5 above says explicitly must NOT
    # entitle — so a lapsed subscriber got subscriber-tier caps for a week
    # after any cancellation near their signup date. Caught by
    # eval/test_entitlement.py once it actually ran in CI again; the module's
    # documented contract (and that test) never described this exception.
    #
    # `in_trial` (above) is the narrow, deliberately-different replacement: it
    # is gated on the same TRIAL_ENFORCEMENT_START window that cuts the trial
    # off, AND on never having been a Stripe customer, so it cannot reach a
    # lapsed subscriber the way the old one did. An admin's custom_cap still
    # wins over both — a cap set on THIS account is more specific than a tier.
    cap = custom_cap if custom_cap is not None else (
        caps["subscriber_weekly_token_cap"]
        if (subscribed or in_trial)
        else caps["free_weekly_token_cap"]
    )

    # Never below one plan's cost, and never above the weekly cap itself —
    # see MIN_BURST_TOKENS. The min() matters for a small custom_cap an admin
    # set deliberately: the burst must not quietly grant more than the week.
    burst_cap = min(cap, max(int(cap * BURST_FRACTION), MIN_BURST_TOKENS))

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
        trial_days_remaining=trial_days_remaining,
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
    # Same 402 shape in all three cases (the paywall/account-menu UI only
    # branches on may_generate), but the message has to match what actually
    # clears it. A trial that's over never resets — telling that teacher to
    # "wait it out" would be a straightforwardly false promise.
    if ent.trial_expired:
        raise AppError(
            "subscription_required",
            "Your free trial has ended.",
            status=402,
            hint="Subscribe to keep building — everything you’ve already made stays yours either way.",
            extra={"entitlement": ent.as_dict()},
        )
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
