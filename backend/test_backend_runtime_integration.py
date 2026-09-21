"""Real Postgres regressions; only the explicit disposable local fixture is used."""
from __future__ import annotations

import json
import threading
import uuid
from types import SimpleNamespace

import pytest
from psycopg2 import sql

from backend import db, teaching
from backend.errors import AppError
from backend.routes import billing
from backend.teaching_schema import SCHEMA_SQL


@pytest.fixture
def operational_database(local_pg_database):
    db._write("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
    db._write("""
        CREATE TABLE users(id TEXT PRIMARY KEY, stripe_customer_id TEXT,
          subscription_status TEXT, subscription_period_end TEXT,
          subscription_cancel_at_period_end BOOLEAN DEFAULT false);
        CREATE TABLE plans(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id),
          plan_json TEXT NOT NULL, docx_path TEXT, template_id TEXT, warnings TEXT, retrieved_ids TEXT,
          class_id TEXT, course TEXT, week_label TEXT, template TEXT, unit TEXT, week_number INTEGER);
        CREATE TABLE document_build_jobs(plan_id TEXT PRIMARY KEY REFERENCES plans(id) ON DELETE CASCADE,
          user_id TEXT, status TEXT, attempts INTEGER, error_message TEXT,
          created_at TEXT, updated_at TEXT, available_at TEXT);
        CREATE TABLE plan_standards(plan_id TEXT REFERENCES plans(id) ON DELETE CASCADE,
          user_id TEXT, class_id TEXT, subject TEXT, grade TEXT, day_index INTEGER,
          day_name TEXT, field TEXT, code TEXT, status TEXT, created_at TEXT);
        CREATE TABLE stripe_webhook_events(id TEXT PRIMARY KEY, event_type TEXT,
          object_id TEXT, event_created_at BIGINT, processed_at TEXT);
        ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
        ALTER TABLE plans FORCE ROW LEVEL SECURITY;
        CREATE POLICY plan_owner ON plans USING (user_id = current_setting('app.user_id',true));
        ALTER TABLE document_build_jobs ENABLE ROW LEVEL SECURITY;
    """)
    migration = next(script for script in db.MIGRATIONS if "CREATE OR REPLACE FUNCTION bump_plan_revision" in script)
    db._write(migration)
    db._write(next(script for script in db.MIGRATIONS if "ADD COLUMN IF NOT EXISTS previous_docx_path" in script))
    db._write("INSERT INTO users(id) VALUES ('a'), ('b')")
    db._write("INSERT INTO plans(id,user_id,plan_json) VALUES ('pa','a','{}'),('pb','b','{}')")
    return local_pg_database


@pytest.fixture
def teaching_database(operational_database):
    db._write("CREATE TABLE curriculum_maps(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id))")
    # Migrations run as raw SQL, not as a parameterized data write. The schema
    # contains PostgreSQL format('%I'), which must not be adapted by psycopg.
    with db.borrow() as conn, conn.cursor() as cur:
        cur.execute(SCHEMA_SQL)
        conn.commit()
    return operational_database


def test_real_pool_and_revision_queue_publish_only_latest(operational_database):
    with db.borrow() as conn:
        assert isinstance(conn, db.DatabaseConnection)
        assert conn._vector_registered is True
        with conn.cursor() as cur:
            cur.execute("SELECT '[1,2,3]'::vector AS embedding")
            assert cur.fetchone()["embedding"].tolist() == [1, 2, 3]
    first = db.claim_next_document_build()
    assert first and first["plan_revision"] == 1
    db._write("UPDATE plans SET plan_json = ? WHERE id = ?", ('{"changed":true}', first["plan_id"]))
    assert db.finish_document_build(first["plan_id"], first["user_id"], claim_token=first["claim_token"], plan_revision=1, docx_path="obsolete.docx") is False
    assert db._row("SELECT docx_path FROM plans WHERE id = ?", (first["plan_id"],))["docx_path"] is None
    queued = db.get_document_build_status(first["plan_id"], first["user_id"])
    assert queued["status"] == "queued" and queued["plan_revision"] == 2
    # Select this job deterministically; the other fixture plan stays queued.
    db._write("UPDATE document_build_jobs SET available_at = '2999' WHERE plan_id <> ?", (first["plan_id"],))
    second = db.claim_next_document_build()
    assert second["plan_revision"] == 2
    assert db.finish_document_build(second["plan_id"], second["user_id"], claim_token=second["claim_token"], plan_revision=2, docx_path="latest.docx") is True
    assert db._row("SELECT docx_path FROM plans WHERE id = ?", (first["plan_id"],))["docx_path"] == "latest.docx"


def test_edit_and_queue_rollback_together(operational_database):
    with pytest.raises(RuntimeError), db.transaction():
        db.update_plan("a", "pa", plan_json={"new": True}, docx_path=None)
        raise RuntimeError("abandon edit")
    assert db._row("SELECT revision FROM plans WHERE id='pa'")["revision"] == 1
    assert db.get_document_build_status("pa", "a")["plan_revision"] == 1


def test_prior_artifact_survives_edits_until_successful_publish(operational_database, monkeypatch, tmp_path):
    previous, current = tmp_path / "plan-r1-aaaaaaaaaaaa.docx", tmp_path / "plan-r3-bbbbbbbbbbbb.docx"
    previous.write_text("old")
    current.write_text("new")
    monkeypatch.setattr(db.settings, "plans_dir", tmp_path)
    monkeypatch.setattr(db.storage, "remove_file", lambda path: path.unlink(missing_ok=True))
    db._write("UPDATE plans SET docx_path = ? WHERE id = 'pa'", (str(previous),))
    db.update_plan("a", "pa", plan_json={"revision": 2}, docx_path=None)
    db.update_plan("a", "pa", plan_json={"revision": 3}, docx_path=None)
    db._write("UPDATE document_build_jobs SET available_at = '2999' WHERE plan_id = 'pb'")
    job = db.claim_next_document_build()
    assert job["previous_docx_path"] == str(previous)
    db.enqueue_document_build("pa", "a")
    assert db._row("SELECT claim_token FROM document_build_jobs WHERE plan_id='pa'")["claim_token"] == job["claim_token"]
    assert previous.exists()
    assert db.finish_document_build("pa", "a", claim_token=job["claim_token"], plan_revision=3, docx_path=str(current))
    assert current.exists() and not previous.exists()
    db.enqueue_document_build("pa", "a")
    assert db.get_document_build_status("pa", "a")["status"] == "ready"
    assert db.delete_plan("a", "pa")
    assert not current.exists()


def test_actual_rls_uses_bound_identity_without_bypass(teaching_database):
    if not db._row("SELECT rolsuper FROM pg_roles WHERE rolname=current_user")["rolsuper"]:
        pytest.skip("Creating a temporary non-bypass test role requires local superuser")
    role = "flexed_rls_" + uuid.uuid4().hex
    with db.borrow() as conn, conn.cursor() as cur:
        cur.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOBYPASSRLS").format(sql.Identifier(role)))
        cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(teaching_database["schema"]), sql.Identifier(role)))
        cur.execute(sql.SQL("GRANT SELECT,UPDATE,INSERT,DELETE ON ALL TABLES IN SCHEMA {} TO {}").format(sql.Identifier(teaching_database["schema"]), sql.Identifier(role)))
        conn.commit()
    try:
        with db.as_user("a"), db.transaction() as conn:
            with conn.cursor() as cur:
                cur.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
            assert [row["id"] for row in db._rows("SELECT id FROM plans")] == ["pa"]
            assert db._write("UPDATE plans SET docx_path='forbidden' WHERE id='pb'") == 0
            db.update_plan("a", "pa", plan_json={"owned": True}, docx_path=None)
            assert db.get_document_build_status("pa", "a")["plan_revision"] == 2
            versions = db._rows("SELECT plan_id, revision FROM plan_versions ORDER BY revision")
            assert versions == [{"plan_id": "pa", "revision": 1}, {"plan_id": "pa", "revision": 2}]
            db._write("INSERT INTO curriculum_maps(id,user_id) VALUES ('ma','a')")
            assert db._row("SELECT map_id FROM material_ingest_jobs")["map_id"] == "ma"
    finally:
        with db.borrow() as conn, conn.cursor() as cur:
            cur.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
            conn.commit()


def test_real_billing_transaction_rolls_back_state_with_receipt(operational_database, monkeypatch):
    event = {"id": "evt", "created": 100, "type": "customer.subscription.updated", "data": {"object": {"id": "sub", "metadata": {"user_id": "a"}, "status": "active"}}}
    monkeypatch.setattr(billing.stripe_api, "verify_webhook", lambda *_: event)
    def fail(*_):
        raise RuntimeError("receipt write failed")
    monkeypatch.setattr(db, "record_stripe_webhook_event", fail)
    with pytest.raises(RuntimeError):
        billing._handle_webhook_event(b"irrelevant", "")
    assert db.get_user_by_id("a")["subscription_status"] is None


def test_real_parallel_webhook_ordering(operational_database, monkeypatch):
    first_started, second_ready = threading.Event(), threading.Event()
    errors = []
    actual_write = db.set_subscription
    def delayed_write(user_id, **fields):
        if fields["status"] == "active":
            first_started.set()
            assert second_ready.wait(2)
        actual_write(user_id, **fields)
    monkeypatch.setattr(db, "set_subscription", delayed_write)
    monkeypatch.setattr(billing.stripe_api, "verify_webhook", lambda payload, *_: json.loads(payload))
    def event(created, status):
        return json.dumps({"id": f"evt{created}", "created": created, "type": "customer.subscription.updated", "data": {"object": {"id": "sub", "metadata": {"user_id": "a"}, "status": status}}}).encode()
    def run(payload, newer=False):
        if newer:
            second_ready.set()
        try:
            billing._handle_webhook_event(payload, "")
        except Exception as exc:  # noqa: BLE001 — surface failures from either thread
            errors.append(exc)
    old = threading.Thread(target=run, args=(event(100, "active"),))
    new = threading.Thread(target=run, args=(event(101, "canceled"), True))
    old.start()
    assert first_started.wait(3)
    new.start()
    old.join(5)
    new.join(5)
    assert not old.is_alive() and not new.is_alive()
    assert not errors
    assert db.get_user_by_id("a")["subscription_status"] == "canceled"


def test_teaching_history_restores_content_and_preserves_racing_provenance(teaching_database, monkeypatch):
    restored_standards = [{"day_index": 0, "day_name": "Monday", "field": "standards", "code": "A.1", "status": "grounded"}]
    monkeypatch.setattr(teaching.retrieval, "cited_standards", lambda *_args, **_kwargs: restored_standards)
    with db.as_user("a"):
        original = {"course": "English", "week_of": "Week 1", "days": [{"name": "Monday", "during": "Discuss evidence"}]}
        first = db.update_plan("a", "pa", plan_json=original, docx_path=None)
        second = db.update_plan("a", "pa", plan_json={**original, "days": [{"name": "Monday", "during": "Revise evidence"}]}, docx_path=None)
        evidence = SimpleNamespace(chunks=[{"id": "standard-a", "document": "Actual source wording", "metadata": {"code": "A.1"}}])
        teaching.record_provenance("a", "pa", evidence, "test-model", revision=first["revision"])
        assert db.get_plan("a", "pa")["provenance"] == {}
        previous = next(version for version in teaching.list_versions("a", "pa") if version["revision"] == first["revision"])
        assert previous["provenance"]["sources"][0]["text"] == "Actual source wording"
        restored = teaching.restore_version("a", "pa", first["revision"], second["revision"])
        assert restored["revision"] == second["revision"] + 1
        assert restored["plan_json"] == original
        assert restored["provenance"] == previous["provenance"]
        assert db.get_document_build_status("pa", "a")["plan_revision"] == restored["revision"]
        assert [row["code"] for row in db._rows("SELECT code FROM plan_standards WHERE plan_id='pa'")] == ["A.1"]
        assert len(teaching.list_versions("a", "pa")) == 4
        with pytest.raises(AppError, match="plan changed"):
            teaching.restore_version("a", "pa", first["revision"], second["revision"])
        # Restoring identical content still records the explicit restore action
        # as a new version instead of silently reusing the current revision.
        repeated = teaching.restore_version("a", "pa", first["revision"], restored["revision"])
        assert repeated["revision"] == restored["revision"] + 1
        assert repeated["plan_json"] == original


def test_delivery_rejects_stale_revisions_and_other_teachers(teaching_database):
    with db.as_user("a"):
        plan = {"days": [{"name": "Monday", "during": "Discuss evidence"}]}
        saved = db.update_plan("a", "pa", plan_json=plan, docx_path=None)
        delivered = teaching.save_delivery("a", "pa", 0, revision=saved["revision"], status="taught", notes="Needs more examples", review_checks={"timing": True})
        assert delivered["status"] == "taught"
        db.update_plan("a", "pa", plan_json={"days": [{"name": "Monday", "during": "New examples"}]}, docx_path=None)
        assert teaching.get_workflow("a", "pa")["days"][0]["outdated"] is True
        with pytest.raises(AppError, match="plan changed"):
            teaching.save_delivery("a", "pa", 0, revision=saved["revision"], status="assessed", notes="", review_checks={})
    with db.as_user("b"), pytest.raises(AppError, match="No such plan"):
        teaching.save_delivery("b", "pa", 0, revision=saved["revision"], status="taught", notes="", review_checks={})
