"""Runs against a disposable local PostgreSQL service, never the app database."""
import json
from concurrent.futures import ThreadPoolExecutor

import pytest

from backend import db, generation_store
from backend.errors import AppError


@pytest.fixture
def ledger(local_pg_database):
    db._write("CREATE TABLE users (id TEXT PRIMARY KEY)")
    db._write("INSERT INTO users VALUES ('owner'), ('other')")
    migration = next(script for script in reversed(db.MIGRATIONS) if "CREATE TABLE IF NOT EXISTS generation_runs" in script)
    db._write(migration)
    return generation_store


def test_duplicate_submissions_have_one_owner_and_conflicting_input_is_rejected(ledger):
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda token: ledger.claim("owner", "request", "same-input", token), ["worker-one", "worker-two"]))
    assert sum(owned for _, owned in results) == 1
    with pytest.raises(AppError) as error:
        ledger.claim("owner", "request", "different-input", "worker-three")
    assert error.value.code == "request_conflict"
    assert ledger.load("other", "request") is None


def test_completed_result_survives_process_memory_and_cancel_is_cooperative(ledger):
    ledger.claim("owner", "request", "input", "worker")
    ledger.request_cancel("owner", "request")
    assert ledger.heartbeat("owner", "request", "worker") is True
    assert ledger.load("owner", "request")["status"] == "running"
    ledger.finish("owner", "request", "worker", "done", {"done": True, "plan_id": "saved-plan"}, None)
    saved = ledger.load("owner", "request")
    assert saved["result_json"]["plan_id"] == "saved-plan"
    assert ledger.claim("owner", "request", "input", "different-process")[1] is False


def test_expired_run_recovers_saved_plan_without_repeating_generation(ledger, monkeypatch):
    ledger.claim("owner", "request", "input", "dead-worker")
    db._write("UPDATE generation_runs SET lease_expires_at=now() - interval '1 second'")
    expected_id = ledger.plan_id("owner", "request")
    monkeypatch.setattr(db, "get_plan", lambda owner, plan_id: {"id": expected_id, "plan_json": {"days": []}, "week_label": "Week 1"} if plan_id == expected_id else None)
    row = ledger.load("owner", "request")
    assert row["status"] == "done"
    assert row["result_json"]["plan_id"] == expected_id
    assert ledger.claim("owner", "request", "input", "new-worker")[1] is False
    assert json.dumps(row["result_json"])


def test_expired_unsaved_run_requires_explicit_retry(ledger, monkeypatch):
    ledger.claim("owner", "request", "input", "dead-worker")
    db._write("UPDATE generation_runs SET lease_expires_at=now() - interval '1 second'")
    monkeypatch.setattr(db, "get_plan", lambda *args: None)
    assert ledger.load("owner", "request")["error_json"]["code"] == "generation_interrupted"
    assert ledger.claim("owner", "request", "input", "retry-worker")[1] is True
