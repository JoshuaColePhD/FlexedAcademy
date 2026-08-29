#!/usr/bin/env python3
"""The paywall: who may build a new week, and who must not be blocked.

This one is a test rather than a comment because it can fail expensively in
both directions. Too loose and the subscription is decorative. Too tight and a
teacher who paid — or who was here before there was anything to pay for —
opens the app on a Sunday night and cannot build Monday.

The promises:

  1. With no Stripe keys the gate is INERT. Everyone builds. A gate with no
     door in it is not a paywall, it is an outage.
  2. Existing accounts are grandfathered as 'comped' by migration 15, and
     'comped' gets the subscriber cap — high enough to be a safety net, not
     a real limit — regardless of how many plans it took to get there.
  3. A new teacher gets `free_weekly_token_cap` tokens, in a trailing 7-day
     window, then stops — until usage from more than a week ago rolls off.
  4. 'past_due' still entitles at the SUBSCRIBER cap — a failed card retry
     must not lock someone out mid-week while Stripe is still trying.
  5. 'canceled' / 'incomplete_expired' do not entitle — they're capped at the
     free tier like anyone unsubscribed, not blocked outright.
  6. The cap counts TOKENS spent (llm.py's own db.record_usage), not plans or
     chats or messages — replaced "one free plan, ever" (migration 15,
     db.count_plans) once a teacher revising the same week fifteen times for
     free while another was locked out after two short ones made it obvious
     plan count was never what was being protected.

No database, no API: db is stubbed.

Run:  ./venv/bin/python eval/test_entitlement.py
"""
from __future__ import annotations

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import db, entitlement as E  # noqa: E402
from backend.config import settings  # noqa: E402

FAILURES: list[str] = []


def check(label: str, got, want) -> None:
    ok = got == want
    print(f"  {'ok  ' if ok else 'FAIL'} {label}: {got!r}" + ("" if ok else f" (want {want!r})"))
    if not ok:
        FAILURES.append(label)


def scenario(
    status, tokens_used, *, keys: bool, free_cap: int = 1000, sub_cap: int = 1_000_000, plans: int = 0, recent=None,
    created_at=None, stripe_customer_id=None,
):
    # created_at/stripe_customer_id default to None so every pre-existing case
    # above behaves exactly as it did: with no created_at the trial branch is
    # skipped entirely, which is the "grandfathered, no expiry" account shape
    # promises 1-6 were all written against.
    db.get_user_by_id = lambda _uid: {
        "subscription_status": status,
        "created_at": created_at,
        "stripe_customer_id": stripe_customer_id,
    }
    # Still called (Entitlement.plans_used rides along for the account menu),
    # just no longer what gates — see promise 6.
    db.count_plans = lambda _uid: plans
    # entitlement() needs two figures — the trailing-week total and the much
    # shorter burst window — and gets both from ONE query now
    # (db.tokens_used_two_windows). It used to call tokens_used_since twice in
    # a fixed order, which this stub had to imitate by counting calls and
    # returning a different number the second time; a stub that depends on
    # call ORDER is a stub that breaks silently the moment the callee is
    # reordered, so returning the pair directly is both simpler and sturdier.
    #
    # The distinction it exists to preserve is unchanged: a teacher who spent
    # `tokens_used` over a WEEK did not necessarily spend that much in the
    # last few hours, so a case isolating the weekly cap passes `recent`
    # explicitly rather than defaulting to the same number twice.
    recent_tokens = tokens_used if recent is None else recent
    db.tokens_used_two_windows = lambda _uid, _since, _burst_since: (tokens_used, recent_tokens)
    # Still stubbed even though entitlement() no longer calls it: it remains
    # part of db's surface, and leaving a real DB call reachable from a suite
    # that promises "no database" is how the get_app_settings hole below
    # happened.
    db.tokens_used_since = lambda _uid, _since: tokens_used
    # entitlement() reads the two caps from db.get_app_settings() — an
    # admin-editable DB row (Settings tab, migration 46) that only FALLS
    # BACK to these settings.* values if the row is missing — not from
    # settings.free_weekly_token_cap/subscriber_weekly_token_cap directly.
    # Stubbing only settings.* (as this used to) left get_app_settings()
    # hitting the real, unstubbed database and silently returning whatever
    # caps happen to be configured there, which is exactly the kind of
    # false "No database, no API" this suite's own docstring promises isn't
    # happening — every cap-dependent check below was actually asserting
    # against production data, not the free_cap/sub_cap this scenario says
    # it's testing.
    db.get_app_settings = lambda: {
        "free_weekly_token_cap": free_cap,
        "subscriber_weekly_token_cap": sub_cap,
    }
    settings.stripe_secret_key = "sk_test" if keys else ""
    settings.stripe_price_id = "price_test" if keys else ""
    settings.stripe_webhook_secret = "whsec_test" if keys else ""
    settings.free_weekly_token_cap = free_cap
    settings.subscriber_weekly_token_cap = sub_cap
    return E.entitlement("u")


def main() -> int:
    real = (db.get_user_by_id, db.count_plans, db.tokens_used_since, db.get_app_settings)
    real_settings = (
        settings.stripe_secret_key,
        settings.stripe_price_id,
        settings.stripe_webhook_secret,
        settings.free_weekly_token_cap,
        settings.subscriber_weekly_token_cap,
    )
    try:
        print("\n1. Billing unconfigured — the gate is inert")
        check("no keys, huge usage, no status", scenario(None, 999_999, keys=False).may_generate, True)
        check("no keys reports disabled", scenario(None, 999_999, keys=False).billing_enabled, False)

        print("\n2. Grandfathered accounts (migration 15 sets 'comped') get the subscriber cap")
        check(
            "comped, over the free cap but under the subscriber cap",
            scenario("comped", 5_000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
            True,
        )
        check(
            "same usage, NOT comped — the free cap alone blocks it",
            scenario(None, 5_000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
            False,
        )

        print("\n3. The free cap — a trailing-week token budget, not a plan count")
        check("new teacher, 0 tokens", scenario(None, 0, keys=True, free_cap=1000).may_generate, True)
        check(
            "new teacher, 1 token under the cap",
            scenario(None, 999, keys=True, free_cap=1000, recent=0).may_generate,
            True,
        )
        check("new teacher, AT the cap", scenario(None, 1000, keys=True, free_cap=1000).may_generate, False)
        check("tokens_remaining under the cap", scenario(None, 400, keys=True, free_cap=1000).tokens_remaining, 600)
        check("tokens_remaining never negative past the cap", scenario(None, 1500, keys=True, free_cap=1000).tokens_remaining, 0)

        print("\n4. Statuses that entitle — at the SUBSCRIBER cap")
        for status in ("active", "trialing", "past_due", "comped"):
            check(
                f"{status}, over the free cap, under the subscriber cap",
                scenario(status, 1000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
                True,
            )

        print("\n5. Statuses that do not — capped at the free tier like anyone unsubscribed")
        for status in ("canceled", "incomplete_expired", "unpaid", None, ""):
            check(
                f"{status!r}, at the free cap",
                scenario(status, 1000, keys=True, free_cap=1000, sub_cap=1_000_000).may_generate,
                False,
            )

        print("\n6. A missing user row is not an accidental free pass")
        db.get_user_by_id = lambda _uid: None
        db.count_plans = lambda _uid: 5
        db.tokens_used_since = lambda _uid, _since: 5000
        db.get_app_settings = lambda: {"free_weekly_token_cap": 1000, "subscriber_weekly_token_cap": 1_000_000}
        settings.free_weekly_token_cap = 1000
        check("no user row, over the free cap", E.entitlement("ghost").may_generate, False)

        # ── 7. the free trial actually grants what the landing page sells ──
        #
        # LandingPage.jsx promises "Get N days of Premium automatically". That
        # was decorative: a trialing account was just an unsubscribed one, so
        # it got the FREE cap. In production that meant 20,000 tokens against
        # an ~11-14k lesson plan — one plan, then a wall, for the week being
        # advertised as Premium.
        #
        # The danger in fixing it is re-creating the "reverse trial" this
        # module deliberately removed, which handed subscriber caps to any
        # non-subscribed status near its signup date — including a lapsed
        # subscriber. Promise 5 above forbids exactly that, so these cases
        # pin BOTH halves: a genuinely new account gets Premium, and an
        # account that has ever been a Stripe customer never does.
        print("\n7. An active trial grants the SUBSCRIBER cap; a lapsed account never does")
        recent_signup = (datetime.now(UTC) - timedelta(days=1)).isoformat(timespec="seconds")
        old_signup = (E.TRIAL_ENFORCEMENT_START - timedelta(days=30)).isoformat(timespec="seconds")
        expired_signup = (
            datetime.now(UTC) - timedelta(days=settings.trial_period_days + 1)
        ).isoformat(timespec="seconds")

        # Brand new, never paid: over the free cap but inside Premium.
        ent = scenario(None, 5000, keys=True, created_at=recent_signup)
        check("day-1 trial, over the free cap", ent.may_generate, True)
        check("day-1 trial is capped at the subscriber tier", ent.token_cap, 1_000_000)

        # The regression guard. Same window, but this account has checked out
        # before, so it is a lapsed subscriber and must stay on the free cap.
        ent = scenario("canceled", 5000, keys=True, created_at=recent_signup, stripe_customer_id="cus_123")
        check("cancelled inside the window is NOT re-trialed", ent.may_generate, False)
        check("cancelled inside the window keeps the free cap", ent.token_cap, 1000)

        # Past the window: hard cutoff, unchanged by any of this.
        #
        # TRIAL_ENFORCEMENT_START is moved back for these two rather than
        # dating the signup far enough into the past, because those are not
        # the same thing: an account older than the constant is GRANDFATHERED
        # (never expires), so a far-past created_at exercises promise 6's path
        # instead of expiry. As shipped the constant is "today", which means
        # no real account can be expired yet at all — the first ones become
        # eligible trial_period_days from the deploy. Pinning it here keeps
        # this check deterministic instead of a case that silently starts
        # exercising something different once that date passes.
        real_start = E.TRIAL_ENFORCEMENT_START
        try:
            E.TRIAL_ENFORCEMENT_START = datetime(2026, 1, 1, tzinfo=UTC)
            ent = scenario(None, 0, keys=True, created_at=expired_signup)
            check("expired trial is blocked even at zero usage", ent.may_generate, False)
            check("expired trial reports itself as such", ent.trial_expired, True)
        finally:
            E.TRIAL_ENFORCEMENT_START = real_start

        # Signed up before the cutoff: grandfathered, free cap, no expiry.
        ent = scenario(None, 5000, keys=True, created_at=old_signup)
        check("pre-cutoff signup stays on the free cap", ent.token_cap, 1000)
        check("pre-cutoff signup is not expired", ent.trial_expired, False)

        # ── 8. the burst ceiling never sits below one lesson plan ──────────
        #
        # The burst is a RATE limit on top of the weekly cap. It was a flat
        # 35% of it, which at the 20,000 free cap came to 7,000 — less than
        # the ~11-14k a single plan costs. Since the check runs before
        # generating, the first plan passed and then everything was refused
        # for 24 hours: a limiter tighter than one unit of work is a wall, not
        # a rate. MIN_BURST_TOKENS floors it; these pin that it neither drops
        # below one plan nor ever exceeds the week it sits inside.
        print("\n8. The burst ceiling is a rate limit, not a wall")
        ent = scenario(None, 0, keys=True, free_cap=20_000, created_at=old_signup)
        check("free-tier burst clears one plan", ent.burst_cap >= 15_000, True)
        check("burst never exceeds the weekly cap", ent.burst_cap <= ent.token_cap, True)

        # A deliberately tiny admin cap must not have the floor hand it MORE
        # than its own week's allowance.
        ent = scenario(None, 0, keys=True, free_cap=500, created_at=old_signup)
        check("burst is clamped to a small weekly cap", ent.burst_cap, 500)

        # At the subscriber cap the fraction already dominates — unchanged.
        ent = scenario("active", 0, keys=True, sub_cap=200_000)
        check("subscriber burst still 35% of the week", ent.burst_cap, 70_000)
    finally:
        db.get_user_by_id, db.count_plans, db.tokens_used_since, db.get_app_settings = real
        (
            settings.stripe_secret_key,
            settings.stripe_price_id,
            settings.stripe_webhook_secret,
            settings.free_weekly_token_cap,
            settings.subscriber_weekly_token_cap,
        ) = real_settings

    print()
    if FAILURES:
        print(f"FAILED — {len(FAILURES)} check(s): {', '.join(FAILURES)}")
        return 1
    print("PASSED — the gate opens for exactly the right people.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
