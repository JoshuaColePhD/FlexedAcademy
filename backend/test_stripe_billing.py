import hashlib
import hmac
import re
import time

import pytest
import stripe

from backend import stripe_api
from backend.errors import AppError
from backend.routes import billing


def _signature(payload: bytes, secret: str, timestamp: int | None = None) -> str:
    timestamp = int(time.time()) if timestamp is None else timestamp
    digest = hmac.new(
        secret.encode(), f"{timestamp}.".encode() + payload, hashlib.sha256
    ).hexdigest()
    return f"t={timestamp},v1={digest}"


def test_verify_webhook_accepts_any_rotating_v1_signature():
    payload = b'{"id":"evt_123","type":"ping"}'
    timestamp = int(time.time())
    valid = _signature(payload, "new-secret", timestamp).split("v1=", 1)[1]
    header = f"t={timestamp},v1=old-signature,v1={valid}"

    assert stripe_api.verify_webhook(payload, header, "new-secret")["id"] == "evt_123"


def test_verify_webhook_rejects_non_object_json():
    payload = b"[]"
    with pytest.raises(AppError, match="Unparseable webhook body"):
        stripe_api.verify_webhook(payload, _signature(payload, "secret"), "secret")


def test_stripe_non_json_error_becomes_provider_error(monkeypatch):
    def operation():
        raise stripe.error.InvalidRequestError("payment provider rejected", "price")

    with pytest.raises(AppError, match="payment provider rejected"):
        stripe_api._provider_call(operation)


def test_checkout_uses_recurring_price_without_a_second_trial(monkeypatch):
    captured = {}

    class Sessions:
        def create(self, data):
            captured["data"] = data
            return {"id": "cs_123", "url": "https://checkout.stripe.com/cs_123"}

    class Checkout:
        sessions = Sessions()

    class V1:
        checkout = Checkout()

    class Client:
        v1 = V1()

    monkeypatch.setattr(stripe_api.settings, "stripe_secret_key", "rk_test")
    monkeypatch.setattr(stripe_api, "_client", lambda: Client())

    session = stripe_api.create_checkout_session(
        price_id="price_123",
        customer_id=None,
        email="teacher@example.com",
        user_id="user_1",
        success_url="https://example.com/?checkout=success",
        cancel_url="https://example.com/?checkout=cancelled",
        trial_days=0,
    )

    assert session["url"].startswith("https://checkout.stripe.com/")
    assert captured["data"]["mode"] == "subscription"
    assert captured["data"]["line_items"] == [{"price": "price_123", "quantity": 1}]
    assert "trial_period_days" not in captured["data"]["subscription_data"]
    assert "payment_method_types" not in captured["data"]
    assert re.fullmatch(r"flexed_web_checkout_[a-z]{8}", captured["data"]["integration_identifier"])


def test_custom_checkout_session_uses_embedded_dynamic_payment_flow(monkeypatch):
    captured = {}

    class Sessions:
        def create(self, data):
            captured["data"] = data
            return {"id": "cs_custom", "client_secret": "cs_custom_secret"}

    class Checkout:
        sessions = Sessions()

    class V1:
        checkout = Checkout()

    class Client:
        v1 = V1()

    monkeypatch.setattr(stripe_api.settings, "stripe_secret_key", "rk_test")
    monkeypatch.setattr(stripe_api, "_client", lambda: Client())

    session = stripe_api.create_custom_checkout_session(
        price_id="price_123",
        customer_id="cus_123",
        email="teacher@example.com",
        user_id="user_1",
        return_url="https://example.com/?checkout=return",
    )

    assert session["client_secret"] == "cs_custom_secret"
    assert captured["data"]["mode"] == "subscription"
    assert captured["data"]["ui_mode"] == "elements"
    assert captured["data"]["return_url"] == "https://example.com/?checkout=return"
    assert captured["data"]["customer"] == "cus_123"
    assert "success_url" not in captured["data"]
    assert "cancel_url" not in captured["data"]
    assert "payment_method_types" not in captured["data"]


def test_checkout_session_route_returns_only_embedded_client_secret(monkeypatch):
    captured = {}
    monkeypatch.setattr(billing.settings, "stripe_secret_key", "rk_test")
    monkeypatch.setattr(billing.settings, "stripe_price_id", "price_test")
    monkeypatch.setattr(billing.settings, "stripe_webhook_secret", "whsec_test")
    monkeypatch.setattr(billing.settings, "billing_return_url", "https://example.com")
    monkeypatch.setattr(
        billing.db,
        "get_user_by_id",
        lambda user_id: {
            "id": user_id,
            "email": "teacher@example.com",
            "stripe_customer_id": "cus_123",
        },
    )

    def create_custom(**kwargs):
        captured.update(kwargs)
        return {"id": "cs_123", "client_secret": "cs_secret_123", "url": "should_not_return"}

    monkeypatch.setattr(billing.stripe_api, "create_custom_checkout_session", create_custom)

    result = billing.checkout_session(object(), "user_1")

    assert result == {"client_secret": "cs_secret_123", "session_id": "cs_123"}
    assert "url" not in result
    assert captured["price_id"] == "price_test"
    assert captured["customer_id"] == "cus_123"
    assert captured["return_url"] == (
        "https://example.com/?checkout=return&session_id={CHECKOUT_SESSION_ID}"
    )


def test_cancel_subscriptions_schedules_live_subscriptions(monkeypatch):
    calls = []

    class Subscriptions:
        def list(self, data):
            calls.append(("list", data))
            return {"data": [
                {"id": "sub_live", "status": "active", "cancel_at_period_end": False},
                {"id": "sub_scheduled", "status": "active", "cancel_at_period_end": True},
                {"id": "sub_done", "status": "canceled", "cancel_at_period_end": True},
            ]}

        def update(self, subscription_id, data):
            calls.append(("update", subscription_id, data))
            return {"id": subscription_id, "status": "active", "cancel_at_period_end": True}

    class V1:
        subscriptions = Subscriptions()

    class Client:
        v1 = V1()

    monkeypatch.setattr(stripe_api.settings, "stripe_secret_key", "rk_test")
    monkeypatch.setattr(stripe_api, "_client", lambda: Client())

    result = stripe_api.cancel_subscriptions_at_period_end_for_customer("cus_123")

    assert calls == [
        ("list", {"customer": "cus_123", "status": "all"}),
        ("update", "sub_live", {"cancel_at_period_end": True}),
    ]
    assert [sub["id"] for sub in result] == ["sub_live", "sub_scheduled"]


def test_cancel_route_mirrors_successful_stripe_cancellation(monkeypatch):
    writes = []
    subscription = {
        "id": "sub_123",
        "status": "active",
        "cancel_at_period_end": True,
        "current_period_end": 1_800_000_000,
    }

    monkeypatch.setattr(billing.settings, "stripe_secret_key", "sk_test")
    monkeypatch.setattr(billing.settings, "stripe_price_id", "price_test")
    monkeypatch.setattr(billing.settings, "stripe_webhook_secret", "whsec_test")
    monkeypatch.setattr(
        billing.db,
        "get_user_by_id",
        lambda user_id: {
            "id": user_id,
            "stripe_customer_id": "cus_123",
            "subscription_status": "active",
        },
    )
    monkeypatch.setattr(
        billing.stripe_api,
        "cancel_subscriptions_at_period_end_for_customer",
        lambda customer_id: [subscription],
    )
    monkeypatch.setattr(
        billing.db,
        "set_subscription",
        lambda user_id, **kwargs: writes.append((user_id, kwargs)),
    )
    monkeypatch.setattr(
        billing,
        "entitlement",
        lambda user_id: type("EntitlementStub", (), {"as_dict": lambda self: {"subscribed": True}})(),
    )

    result = billing.cancel_subscription("user_1")

    assert result["status"] == "cancellation_scheduled"
    assert result["period_end"] is not None
    assert writes == [
        (
            "user_1",
            {
                "status": "active",
                "period_end": result["period_end"],
                "cancel_at_period_end": True,
            },
        )
    ]


def _subscription_event(event_id: str, created: int, status: str = "active") -> dict:
    return {
        "id": event_id,
        "type": "customer.subscription.updated",
        "created": created,
        "data": {"object": {"id": "sub_123", "customer": "cus_123", "status": status}},
    }


def test_webhook_deduplicates_and_ignores_late_subscription_events(monkeypatch):
    events = {
        "evt_new": _subscription_event("evt_new", 200, "active"),
        "evt_old": _subscription_event("evt_old", 100, "canceled"),
    }
    processed = set()
    recorded = []
    latest = {}
    writes = []

    monkeypatch.setattr(
        stripe_api, "verify_webhook", lambda payload, signature, secret: events[payload.decode()]
    )
    monkeypatch.setattr(billing.db, "stripe_webhook_event_processed", lambda event_id: event_id in processed)
    monkeypatch.setattr(
        billing.db,
        "stripe_object_event_is_newer",
        lambda object_id, created: created > latest.get(object_id, -1),
    )

    def record(event_id, event_type, object_id, created):
        processed.add(event_id)
        recorded.append((event_id, event_type, object_id, created))
        if object_id:
            latest[object_id] = max(latest.get(object_id, -1), created or -1)

    monkeypatch.setattr(billing.db, "record_stripe_webhook_event", record)
    monkeypatch.setattr(billing.db, "get_user_by_stripe_customer", lambda customer: {"id": "user_1"})
    monkeypatch.setattr(
        billing.db,
        "set_subscription",
        lambda user_id, **kwargs: writes.append((user_id, kwargs)),
    )

    billing._handle_webhook_event(b"evt_new", "")
    billing._handle_webhook_event(b"evt_new", "")
    billing._handle_webhook_event(b"evt_old", "")

    assert writes == [
        (
            "user_1",
            {
                "customer_id": "cus_123",
                "status": "active",
                "period_end": None,
                "cancel_at_period_end": False,
            },
        )
    ]
    assert [row[0] for row in recorded] == ["evt_new", "evt_old"]


def test_checkout_webhook_retries_when_subscription_lookup_fails(monkeypatch):
    event = {
        "id": "evt_checkout",
        "type": "checkout.session.completed",
        "created": 200,
        "data": {
            "object": {
                "id": "cs_123",
                "client_reference_id": "user_1",
                "customer": "cus_123",
                "subscription": "sub_123",
            }
        },
    }
    recorded = []
    writes = []

    monkeypatch.setattr(stripe_api, "verify_webhook", lambda *args: event)
    monkeypatch.setattr(billing.db, "stripe_webhook_event_processed", lambda event_id: False)
    monkeypatch.setattr(billing.db, "stripe_object_event_is_newer", lambda *args: True)
    monkeypatch.setattr(
        stripe_api,
        "get_subscription",
        lambda subscription_id: (_ for _ in ()).throw(
            AppError("billing_unreachable", "temporary", status=502)
        ),
    )
    monkeypatch.setattr(
        billing.db,
        "set_subscription",
        lambda *args, **kwargs: writes.append((args, kwargs)),
    )
    monkeypatch.setattr(
        billing.db,
        "record_stripe_webhook_event",
        lambda *args: recorded.append(args),
    )

    with pytest.raises(AppError, match="temporary"):
        billing._handle_webhook_event(b"payload", "")

    assert not writes
    assert not recorded
