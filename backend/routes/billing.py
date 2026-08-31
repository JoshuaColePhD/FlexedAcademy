"""Subscriptions: what it costs, how to start one, how to manage it.

Three surfaces:

  GET  /api/billing            what this account may do, and what a plan costs
  POST /api/billing/checkout   -> a hosted Stripe Checkout URL
  POST /api/billing/portal     -> a hosted Stripe portal URL (change card, cancel)
  POST /api/billing/webhook    <- Stripe telling us a status changed

The app never sees a card number. Both flows hand the browser a Stripe-hosted
URL and get out of the way, which is also why the only thing that may change a
subscription status in our database is the **webhook** — not the success
redirect. A success redirect is a URL the user's browser was told to visit, and
a URL a browser can be told to visit is a URL anyone can visit. So the redirect
only refreshes the page; the signed webhook is what grants access.
"""
from __future__ import annotations

import logging
from datetime import UTC

from fastapi import APIRouter, Depends, Request
from starlette.concurrency import run_in_threadpool

from .. import db, stripe_api
from ..config import settings
from ..deps import get_current_user
from ..entitlement import ENTITLED_STATUSES, entitlement
from ..errors import AppError

log = logging.getLogger("flexedacademy.billing")
router = APIRouter(prefix="/api/billing", tags=["billing"])

# Stripe statuses we store verbatim. Anything else ('incomplete_expired',
# 'unpaid', …) is stored too — entitlement.py decides which of them entitle,
# and it is the only place that decision is made.
_SUB_EVENTS = {
    "customer.subscription.created",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "customer.subscription.paused",
    "customer.subscription.resumed",
}


def _return_url(request: Request) -> str:
    """Where Stripe sends the browser back to.

    Configured value wins. Falling back to the request's own origin is what
    keeps this working in local dev without a second env var, but it must not
    be reachable from a header an attacker controls in production — hence the
    configured value taking precedence.
    """
    if settings.billing_return_url:
        return settings.billing_return_url.rstrip("/")
    return str(request.base_url).rstrip("/")


@router.get("/price")
def public_price():
    """What a subscription costs, readable without an account.

    The landing page invites a signup, so it has to be able to say what a
    subscription costs — and it cannot say it by hardcoding a number that goes
    stale the first time the price changes. Deliberately public and narrow:
    the price and the free tier's weekly token cap, no entitlement, no
    account state. The price is already printed on the Checkout page anyway.

    Before Stripe is configured this returns price: null and the page simply
    says nothing about money, which is the honest thing to say when there is
    no price yet.
    """
    if not settings.billing_enabled:
        # Fallback price so the landing page can list $11.99/mo before Stripe is live.
        mock_price = {"amount": 1199, "currency": "USD", "interval": "month", "interval_count": 1}
        return {
            "price": mock_price,
            "free_weekly_token_cap": settings.free_weekly_token_cap,
            "trial_period_days": settings.trial_period_days,
        }
    try:
        price = stripe_api.get_price(settings.stripe_price_id)
    except AppError:
        price = None
    return {
        "price": price,
        "free_weekly_token_cap": settings.free_weekly_token_cap,
        # Read here too, not hardcoded in the frontend — same reasoning as
        # the price itself: if this changes, the copy that promises it
        # should change with it, not drift out of sync with a redeploy.
        "trial_period_days": settings.trial_period_days,
    }


@router.get("")
def billing_status(request: Request, user_id: str = Depends(get_current_user)):
    ent = entitlement(user_id).as_dict()
    price = None
    if settings.billing_enabled:
        try:
            price = stripe_api.get_price(settings.stripe_price_id)
        except AppError:
            # A price we can't quote is not a reason to fail the page. The
            # paywall renders without a figure and Checkout still shows the
            # real one, which is the number that actually binds anyway.
            log.warning("could not read price %s", settings.stripe_price_id)
    else:
        # Fallback price so the paywall can list $11.99/mo before Stripe is live.
        price = {"amount": 1199, "currency": "USD", "interval": "month", "interval_count": 1}
    return {
        **ent,
        "price": price,
        # The free week already happened app-side (entitlement.py's
        # trial_expired/trial_days_remaining, both already in `ent`) before
        # anyone reaches this endpoint — Checkout itself never grants a
        # second, Stripe-native trial. See checkout()'s trial_days=0.
        "trial_period_days": settings.trial_period_days,
    }


@router.post("/checkout")
def checkout(request: Request, user_id: str = Depends(get_current_user)):
    if not settings.billing_enabled:
        raise AppError("billing_unconfigured", "Billing isn’t set up yet.", status=503)
    user = db.get_user_by_id(user_id)
    if not user:
        raise AppError("not_authenticated", "Not logged in.", status=401)

    base = _return_url(request)
    existing_customer = user.get("stripe_customer_id")
    session = stripe_api.create_checkout_session(
        price_id=settings.stripe_price_id,
        customer_id=existing_customer,
        email=user["email"],
        user_id=user_id,
        success_url=f"{base}/?checkout=success",
        cancel_url=f"{base}/?checkout=cancelled",
        # Always 0: the free week is entitlement.py's app-side trial, run
        # against users.created_at before anyone ever reaches Checkout. A
        # second, card-required Stripe trial stacked on top of that would
        # just delay the first real charge for no reason.
        trial_days=0,
    )
    return {"url": session["url"]}


@router.post("/portal")
def portal(request: Request, user_id: str = Depends(get_current_user)):
    """The ONLY way a subscriber can cancel, so a failure here is an outage of
    something people are legally entitled to reach — not a routine 4xx.

    Both failure paths below log at ERROR on purpose. server.py's Sentry
    before_send drops every AppError, deliberately, so that expected
    control-flow 4xx (a 401, "email taken") don't bury real crashes. Correct in
    general, and exactly wrong here: a Stripe rejection arrives AS an AppError,
    so a portal that stopped working would be invisible — the teacher gets a
    toast, nobody is told, and the only evidence is somebody eventually
    complaining. These use log.error rather than log.exception precisely so
    they carry no exc_info and survive that filter.

    Found because the live account had no customer portal configuration at all
    (Stripe returns none until the Dashboard's portal settings are saved), which
    means every one of these calls would have failed with nothing reported.
    """
    user = db.get_user_by_id(user_id) or {}
    customer_id = user.get("stripe_customer_id")
    if not customer_id:
        # Only an error when the app is TELLING this account it's subscribed.
        # SettingsPage renders "Manage subscription" off exactly that, so the
        # two disagreeing means someone is being shown a subscription they
        # cannot manage. A genuinely unsubscribed caller hitting this route is
        # just a stale tab, and stays a quiet 400.
        if user.get("subscription_status") in ENTITLED_STATUSES:
            log.error(
                "user=%s shows subscription_status=%s but has no stripe_customer_id, so the "
                "billing portal cannot open — this account is being shown a subscription it "
                "cannot cancel from the app.",
                user_id,
                user.get("subscription_status"),
            )
        raise AppError(
            "no_subscription",
            "There’s no subscription on this account yet.",
            status=400,
        )
    try:
        session = stripe_api.create_portal_session(
            customer_id=customer_id, return_url=_return_url(request)
        )
    except AppError as e:
        log.error(
            "customer portal session failed for user=%s customer=%s: %s — a subscriber "
            "cannot cancel while this is failing. If Stripe reports no default portal "
            "configuration, save the portal settings in the Dashboard "
            "(Settings > Billing > Customer portal, Live mode).",
            user_id,
            customer_id,
            e,
        )
        raise AppError(
            "portal_unavailable",
            "We couldn’t open the billing page just now. Your subscription hasn’t changed.",
            status=502,
            hint="Please try again in a moment. If it keeps failing, reply to any billing "
                 "receipt to reach us and we'll cancel it for you.",
        ) from e
    return {"url": session["url"]}


def _period_end(sub: dict) -> str | None:
    """`current_period_end` moved onto subscription items in recent API
    versions and stayed on the subscription in older ones. Read both, so the
    date shown to a teacher doesn't silently go blank on a Stripe upgrade."""
    ts = sub.get("current_period_end")
    if not ts:
        items = (sub.get("items") or {}).get("data") or []
        ts = items[0].get("current_period_end") if items else None
    if not ts:
        return None
    from datetime import datetime
    return datetime.fromtimestamp(int(ts), tz=UTC).isoformat()


def _resolve_user(sub: dict) -> str | None:
    """Which account this subscription belongs to.

    Metadata first (we set it at checkout), then the customer id we stored.
    If neither resolves, the event is logged and dropped rather than guessed
    at — writing a subscription onto the wrong account is worse than missing
    one, and Stripe retries failed webhooks anyway.
    """
    user_id = (sub.get("metadata") or {}).get("user_id")
    if user_id:
        return user_id
    customer = sub.get("customer")
    if isinstance(customer, dict):
        customer = customer.get("id")
    if customer:
        row = db.get_user_by_stripe_customer(customer)
        if row:
            return row["id"]
    return None


@router.post("/webhook")
async def webhook(request: Request):
    """Reading the body is the only awaitable part; everything after it is
    blocking (signature crypto, a Stripe HTTP round trip, DB writes) and is
    handed to the threadpool rather than run on the event loop.

    This has to stay `async def` — unlike the upload routes, it genuinely
    needs `await request.body()` — so it can't get the threadpool the way they
    do just by dropping the keyword. Same reason it matters, though: under
    `--workers 1` (Dockerfile), a Stripe call blocking here stalled every
    other request, and webhooks arrive on Stripe's schedule, not a teacher's.
    """
    if not settings.stripe_webhook_secret:
        raise AppError("billing_unconfigured", "No webhook secret configured.", status=503)
    payload = await request.body()
    signature = request.headers.get("stripe-signature", "")
    return await run_in_threadpool(_handle_webhook_event, payload, signature)


def _handle_webhook_event(payload: bytes, signature: str) -> dict:
    event = stripe_api.verify_webhook(payload, signature, settings.stripe_webhook_secret)
    kind = event.get("type")
    obj = (event.get("data") or {}).get("object") or {}
    event_id = event.get("id")
    if not isinstance(event_id, str) or not event_id:
        raise AppError("bad_signature", "Webhook is missing its event id.", status=400)
    if not isinstance(kind, str) or not kind:
        raise AppError("bad_signature", "Webhook is missing its event type.", status=400)

    # Stripe retries deliveries, and its docs explicitly make no ordering
    # guarantee. Apply only a successfully recorded event once, and ignore a
    # late event for the same Stripe object after a newer one was applied.
    # Recording happens after the state write below, so a transient DB failure
    # leaves the event retryable; reapplying a successful state write is safe.
    if db.stripe_webhook_event_processed(event_id):
        return {"received": True, "duplicate": True}

    event_created_at = event.get("created")
    try:
        event_created_at = int(event_created_at) if event_created_at is not None else None
    except (TypeError, ValueError):
        event_created_at = None

    object_id = obj.get("id") if isinstance(obj, dict) else None
    if kind == "checkout.session.completed":
        object_id = obj.get("subscription") or object_id
    if (
        (kind in _SUB_EVENTS or kind == "checkout.session.completed")
        and isinstance(object_id, str)
        and event_created_at is not None
        and not db.stripe_object_event_is_newer(object_id, event_created_at)
    ):
        db.record_stripe_webhook_event(event_id, kind, object_id, event_created_at)
        log.info("ignored stale Stripe event=%s type=%s object=%s", event_id, kind, object_id)
        return {"received": True, "stale": True}

    if kind == "checkout.session.completed":
        user_id = obj.get("client_reference_id")
        customer = obj.get("customer")
        if isinstance(customer, dict):
            customer = customer.get("id")
        if not user_id and customer:
            row = db.get_user_by_stripe_customer(customer)
            user_id = row["id"] if row else None
        sub_id = obj.get("subscription")
        if not user_id:
            log.warning("checkout.session.completed with no client_reference_id")
            db.record_stripe_webhook_event(event_id, kind, object_id, event_created_at)
            return {"received": True}
        # The session says "paid"; the subscription says what they actually
        # have and until when. Ask the subscription.
        status, period_end = "active", None
        if sub_id:
            try:
                sub = stripe_api.get_subscription(sub_id)
                status = sub.get("status") or "active"
                period_end = _period_end(sub)
            except AppError as e:
                # Do not grant access based on a session alone if the
                # authoritative subscription lookup failed. Raising makes
                # Stripe retry the signed event instead of leaving a paid
                # account in a misleading state or granting a false one.
                log.warning("could not read subscription %s; retrying webhook: %s", sub_id, e)
                raise
        db.set_subscription(
            user_id,
            customer_id=customer,
            status=status,
            period_end=period_end,
            cancel_at_period_end=bool(sub.get("cancel_at_period_end")) if sub_id else False,
        )
        log.info("subscription started user=%s status=%s", user_id, status)

    elif kind in _SUB_EVENTS:
        user_id = _resolve_user(obj)
        if not user_id:
            log.warning("%s could not be matched to a user", kind)
            db.record_stripe_webhook_event(event_id, kind, object_id, event_created_at)
            return {"received": True}
        status = "canceled" if kind.endswith("deleted") else (obj.get("status") or "active")
        customer = obj.get("customer")
        db.set_subscription(
            user_id,
            customer_id=customer if isinstance(customer, str) else None,
            status=status,
            period_end=_period_end(obj),
            cancel_at_period_end=bool(obj.get("cancel_at_period_end")),
        )
        log.info("subscription %s user=%s status=%s", kind, user_id, status)

    # Everything else is acknowledged and ignored. Returning 2xx is what stops
    # Stripe retrying an event we were never going to act on.
    db.record_stripe_webhook_event(event_id, kind, object_id, event_created_at)
    return {"received": True}


@router.post("/cancel")
def cancel_subscription(user_id: str = Depends(get_current_user)) -> dict:
    """Cancel the account's Stripe subscription at the current period end.

    The Stripe update is the side effect; the local write mirrors that
    successful response so the teacher immediately sees "ends" rather than
    "renews". The signed webhook remains responsible for later changes,
    especially the eventual ``customer.subscription.deleted`` transition.
    """
    if not settings.billing_enabled:
        raise AppError("billing_unconfigured", "Billing isn’t set up yet.", status=503)
    user = db.get_user_by_id(user_id) or {}
    customer_id = user.get("stripe_customer_id")
    if not customer_id:
        raise AppError("no_subscription", "There’s no subscription on this account yet.", status=400)
    try:
        subscriptions = stripe_api.cancel_subscriptions_at_period_end_for_customer(customer_id)
    except AppError as exc:
        log.error("subscription cancellation failed for user=%s customer=%s: %s", user_id, customer_id, exc)
        raise AppError(
            "cancellation_unavailable",
            "We couldn’t cancel the subscription just now. It has not changed.",
            status=502,
            hint="Try again in a moment. If it keeps failing, use the Stripe billing portal.",
        ) from exc
    if not subscriptions:
        raise AppError("no_subscription", "There’s no active subscription on this account.", status=400)

    latest = max(subscriptions, key=lambda sub: _period_end(sub) or "")
    period_end = _period_end(latest) or user.get("subscription_period_end")
    db.set_subscription(
        user_id,
        status=latest.get("status") or user.get("subscription_status") or "active",
        period_end=period_end,
        cancel_at_period_end=True,
    )
    return {
        "status": "cancellation_scheduled",
        "period_end": period_end,
        "entitlement": entitlement(user_id).as_dict(),
    }
