"""Regression tests for explicit response-length preferences and budgets."""
from __future__ import annotations

import pytest

from backend import db, llm
from backend.schema import SchemaError


def test_output_length_budgets_are_calibrated_and_ordered():
    assert llm.OUTPUT_LENGTH_BUDGETS == {
        "short": 1600,
        "medium": 2200,
        "long": 3600,
    }
    assert llm.OUTPUT_LENGTH_BUDGETS["short"] < llm.OUTPUT_LENGTH_BUDGETS["medium"] < llm.OUTPUT_LENGTH_BUDGETS["long"]


def test_output_length_for_prefers_explicit_field(monkeypatch):
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {"output_length": "long", "custom_instructions": "[Response Length: Short]"})
    assert llm.output_length_for("u1") == "long"
    assert llm.output_length_tokens_for("u1") == 3600


def test_output_length_for_preserves_legacy_tag_during_rollout(monkeypatch):
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {"output_length": None, "custom_instructions": "[Response Length: Short] Keep it brief."})
    assert llm.output_length_for("u1") == "short"


def test_output_length_for_defaults_to_medium(monkeypatch):
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {"output_length": "unexpected", "custom_instructions": ""})
    assert llm.output_length_for("u1") == "medium"
    assert llm.output_length_tokens_for("u1") == 2200


def test_full_plan_budget_has_room_for_all_required_days(monkeypatch):
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {"output_length": "medium", "custom_instructions": ""})
    assert llm.plan_completion_tokens_for("u1") == 8000


def test_full_plan_budget_is_independent_of_preference(monkeypatch):
    monkeypatch.setattr(db, "get_user_by_id", lambda _user_id: {"output_length": "long", "custom_instructions": ""})
    assert llm.plan_completion_tokens_for("u1") == 8000


def test_completion_cache_key_includes_token_budget(monkeypatch):
    keys = []

    class Message:
        content = "{}"
        refusal = None

    class Completions:
        @staticmethod
        def create(**_kwargs):
            return type("Response", (), {"choices": [type("Choice", (), {"message": Message()})()], "usage": None})()

    monkeypatch.setattr(db, "get_llm_cache", lambda key: keys.append(key) or None)
    monkeypatch.setattr(db, "set_llm_cache", lambda *_args: None)
    monkeypatch.setattr(llm, "client", lambda: type("Client", (), {"chat": type("Chat", (), {"completions": Completions()})()})())

    llm._cached_completion("u1", "test", model="m", max_completion_tokens=1200, messages=[])
    llm._cached_completion("u1", "test", model="m", max_completion_tokens=2200, messages=[])
    assert len(keys) == 2
    assert keys[0] != keys[1]


def test_cached_completion_rejects_provider_length_finish_reason(monkeypatch):
    class Choice:
        finish_reason = "length"
        message = type("Message", (), {"content": "{\"days\":[", "refusal": None})()

    class Completions:
        @staticmethod
        def create(**_kwargs):
            return type("Response", (), {"choices": [Choice()], "usage": None})()

    monkeypatch.setattr(db, "get_llm_cache", lambda _key: None)
    monkeypatch.setattr(llm, "client", lambda: type("Client", (), {"chat": type("Chat", (), {"completions": Completions()})()})())

    with pytest.raises(SchemaError, match="stopped before finishing"):
        llm._cached_completion("u1", "test", model="m", max_completion_tokens=2200, messages=[])


def test_migration_adds_explicit_output_length_field():
    migration = db.MIGRATIONS[59]
    assert "ADD COLUMN IF NOT EXISTS output_length" in migration
    assert "users_output_length_check" in migration
    assert "response length: short" in migration.lower()
