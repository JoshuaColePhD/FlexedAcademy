"""The app's small, server-only Stripe integration.

Stripe's official client owns API serialization, retries, and provider errors.
The app keeps narrow helpers so routes and tests do not depend on Stripe object
classes. Card data never passes through this module: Checkout and Elements
collect it directly in Stripe-hosted fields.
"""
from __future__ import annotations

import json
import logging
import secrets
import string
import time

import stripe
from stripe import StripeClient

from .config import settings
from .errors import AppError

log = logging.getLogger("flexedacademy.stripe")

STRIPE_API_VERSION = "2026-07-29.dahlia"
SIGNATURE_TOLERANCE_S = 300


def _client() -> StripeClient:
    if not settings.stripe_secret_key:
        raise AppError("billing_unconfigured", "Billing isn’t set up yet.", status=503)
    return StripeClient(settings.stripe_secret_key, stripe_version=STRIPE_API_VERSION)


def _as_dict(value) -> dict:
    if isinstance(value, dict):
        return value
    if hasattr(value, "to_dict"):
        return value.to_dict()
    return dict(value)


def _provider_call(operation, *args, **kwargs) -> dict:
    try:
        return _as_dict(operation(*args, **kwargs))
    except stripe.error.APIConnectionError as e:
        log.warning("stripe unreachable: %s", e.user_message or "connection error")
        raise AppError(
            "billing_unreachable",
            "Couldn’t reach the payment provider.",
            status=502,
            hint="Try again in a moment — nothing was charged.",
        ) from e
    except stripe.error.StripeError as e:
        message = getattr(e, "user_message", None) or str(e)
        log.warning("stripe provider error: %s", message)
        raise AppError(
            "billing_error",
            message or "The payment provider rejected that request.",
            status=502,
        )


def _integration_identifier() -> str:
    suffix = "".join(secrets.choice(string.ascii_lowercase) for _ in range(8))
    return f"flexed_web_checkout_{suffix}"


# The price changes about never, and the public landing page asks for it on
# every anonymous visit. Cached so a crawler cannot turn a marketing page into
# a Stripe rate-limit problem.
_PRICE_CACHE: dict[str, tuple[float, dict]] = {}
PRICE_TTL_S = 600


def get_price(price_id: str) -> dict:
    """Read the price from Stripe rather than hardcoding it in the UI.

    This matters more than it looks: a number typed into the frontend is a
    number that goes stale the first time the price changes, and a paywall
    quoting the wrong figure is a promise the checkout page then breaks.
    """
    hit = _PRICE_CACHE.get(price_id)
    if hit and time.time() - hit[0] < PRICE_TTL_S:
        return hit[1]
    p = _provider_call(_client().v1.prices.retrieve, price_id)
    recurring = p.get("recurring") or {}
    out = {
        "amount": p.get("unit_amount"),
        "currency": (p.get("currency") or "usd").upper(),
        "interval": recurring.get("interval"),
        "interval_count": recurring.get("interval_count") or 1,
    }
    _PRICE_CACHE[price_id] = (time.time(), out)
    return out


def _checkout_params(*, price_id: str, customer_id: str | None, email: str,
                     user_id: str, trial_days: int = 0) -> dict:
    data: dict = {
        "mode": "subscription",
        "line_items": [{"price": price_id, "quantity": 1}],
        "metadata": {"user_id": user_id},
        "client_reference_id": user_id,
        "subscription_data": {"metadata": {"user_id": user_id}},
        "allow_promotion_codes": True,
        "integration_identifier": _integration_identifier(),
    }
    if customer_id:
        data["customer"] = customer_id
    else:
        data["customer_email"] = email
    # The app's free week is intentional and has already expired before this
    # route is reachable. Omit the field entirely for a paid-first subscription.
    if trial_days > 0:
        data["subscription_data"]["trial_period_days"] = trial_days
    return data


def create_checkout_session(*, price_id: str, customer_id: str | None, email: str,
                            user_id: str, success_url: str, cancel_url: str,
                            trial_days: int = 0) -> dict:
    """Create the retained Stripe-hosted Checkout compatibility flow."""
    data = _checkout_params(
        price_id=price_id,
        customer_id=customer_id,
        email=email,
        user_id=user_id,
        trial_days=trial_days,
    )
    data.update({"success_url": success_url, "cancel_url": cancel_url})
    return _provider_call(_client().v1.checkout.sessions.create, data)


def create_custom_checkout_session(*, price_id: str, customer_id: str | None, email: str,
                                   user_id: str, return_url: str,
                                   trial_days: int = 0) -> dict:
    """Create a Checkout Session for React Stripe's embedded Elements flow."""
    data = _checkout_params(
        price_id=price_id,
        customer_id=customer_id,
        email=email,
        user_id=user_id,
        trial_days=trial_days,
    )
    data.update({
        # Stripe renamed the custom Elements mode to `elements` in the current
        # API version. CheckoutElementsProvider still supplies the fully
        # custom React surface for this mode.
        "ui_mode": "elements",
        "return_url": return_url,
    })
    return _provider_call(_client().v1.checkout.sessions.create, data)


def create_portal_session(*, customer_id: str, return_url: str) -> dict:
    return _provider_call(
        _client().v1.billing_portal.sessions.create,
        {"customer": customer_id, "return_url": return_url},
    )


def get_subscription(subscription_id: str) -> dict:
    return _provider_call(_client().v1.subscriptions.retrieve, subscription_id)


def cancel_subscriptions_at_period_end_for_customer(customer_id: str) -> list[dict]:
    """Stop every live subscription for ``customer_id`` from renewing.

    This schedules cancellation at the end of each current billing period
    instead of deleting the subscription immediately. Stripe returns the
    updated subscription so the caller can mirror the confirmed change.
    """
    subs = _provider_call(
        _client().v1.subscriptions.list,
        {"customer": customer_id, "status": "all"},
    )
    updated = []
    for sub in subs.get("data", []):
        if sub.get("status") in ("canceled", "incomplete_expired"):
            continue
        if sub.get("cancel_at_period_end"):
            updated.append(sub)
            continue
        updated.append(
            _provider_call(
                _client().v1.subscriptions.update,
                sub["id"],
                {"cancel_at_period_end": True},
            )
        )
    return updated


def cancel_subscriptions_for_customer(customer_id: str) -> None:
    """Called right before deleting an account: a departed teacher should not
    keep being billed for access that no longer exists. There is no single
    "cancel everything for this customer" endpoint — list, then cancel each
    (a customer only ever has one subscription in this app, but nothing
    stops Stripe from having more, e.g. a manually created one). Best-effort
    per subscription: one failing to cancel should not be the reason account
    deletion itself fails — the caller logs and moves on.
    """
    subs = _provider_call(
        _client().v1.subscriptions.list,
        {"customer": customer_id, "status": "all"},
    )
    for sub in subs.get("data", []):
        if sub.get("status") in ("canceled", "incomplete_expired"):
            continue
        _provider_call(_client().v1.subscriptions.cancel, sub["id"])


def verify_webhook(payload: bytes, sig_header: str, secret: str) -> dict:
    """Return the parsed event only after Stripe verifies its signature."""
    try:
        payload_text = payload.decode("utf-8")
        stripe.WebhookSignature.verify_header(
            payload_text,
            sig_header,
            secret,
            tolerance=SIGNATURE_TOLERANCE_S,
        )
        event = json.loads(payload_text)
        if not isinstance(event, dict):
            raise TypeError("Webhook payload must be an object")
    except stripe.error.SignatureVerificationError as e:
        message = str(e).lower()
        if "timestamp" in message or "too old" in message:
            raise AppError("bad_signature", "Stale webhook.", status=400) from e
        raise AppError("bad_signature", "Bad webhook signature.", status=400) from e
    except (ValueError, TypeError) as e:
        raise AppError("bad_signature", "Unparseable webhook body.", status=400) from e
    return event
