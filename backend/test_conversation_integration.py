"""Conversation storage, historical branching and isolation on disposable Postgres."""
import uuid

import pytest
from psycopg2 import sql

from backend import chat_metrics, conversation, db
from backend.errors import AppError


@pytest.fixture
def conversation_db(local_pg_database):
    created = []
    for role in ("anon", "authenticated"):
        if not db._row("SELECT 1 FROM pg_roles WHERE rolname=?", (role,)):
            with db.borrow() as conn, conn.cursor() as cur:
                cur.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
                conn.commit()
            created.append(role)
    try:
        db._write("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
        db._write("CREATE TABLE global_standards(id TEXT PRIMARY KEY)")
        with db.borrow() as conn:
            db.migrate(conn)
        db._write("INSERT INTO users(id,email,name,created_at) VALUES ('a','a@example.test','A','2026-09-21'),('b','b@example.test','B','2026-09-21')")
        with db.as_user("a"):
            db.create_chat("a", "Original", chat_id="original")
        yield local_pg_database
    finally:
        for role in created:
            with db.borrow() as conn, conn.cursor() as cur:
                cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
                conn.commit()


def test_sources_survive_reload_and_idempotent_retry_and_enforce_ownership(conversation_db):
    source = {"filename": "Reading.txt", "text": "Opening.\n\nA contradictory narrator."}
    with db.as_user("a"):
        saved = conversation.save_sources("a", "original", [source])
        assert conversation.save_sources("a", "original", [source]) == saved
        row = db.get_chat("a", "original")
        assert len(row["sources_json"]) == 1
        assert "contradictory narrator" in conversation.with_saved_sources("a", "original", "Use the second paragraph")
        assert "sources_json" not in conversation.public_chat(row)
        assert conversation.public_chat(row)["sources"] == saved
        message = db.add_message("original", "user", "Use this reading", client_id="turn", source_ids=[saved[0]["id"]])
        retry = db.add_message("original", "user", "Use this reading", client_id="turn", source_ids=[saved[0]["id"]])
        assert retry["id"] == message["id"] and retry["source_ids_json"] == [saved[0]["id"]]
    with db.as_user("b"), pytest.raises(AppError) as error:
        conversation.save_sources("b", "original", [source])
    assert error.value.status == 404


def test_branch_preserves_original_and_clones_exact_historical_plan(conversation_db):
    with db.as_user("a"):
        saved = conversation.save_sources("a", "original", [{"filename": "Reading.txt", "text": "Early source"}])
        db.add_message("original", "user", "Build this", source_ids=[saved[0]["id"]])
        first = {"days": [{"name": "Monday", "during": "Original activity"}]}
        db.create_plan(plan_id="p", user_id="a", course="English", week_label="Week 3", unit=None, query="Build", plan_json=first,
            docx_path=None, retrieved_ids=[], warnings=[], chat_id="original", template="fhs")
        receipt = db.add_message("original", "assistant", "Saved original", plan_id="p")
        assert receipt["plan_revision"] == 1
        chosen = db.add_message("original", "user", "Change Monday", client_id="edit")
        db.update_plan("a", "p", plan_json={"days": [{"name": "Monday", "during": "Later activity"}]}, docx_path=None)
        db.add_message("original", "assistant", "Saved later", plan_id="p")
        later = conversation.save_sources("a", "original", [{"filename": "Future.txt", "text": "Do not inherit this"}])
        db.add_message("original", "user", "Future request", source_ids=[later[0]["id"]])
        before = db.list_messages("original")
        child = conversation.branch_chat("a", "original", message_id=chosen["id"], client_id=None, branch_id="alternative")
        assert child["source_ids"] == [saved[0]["id"]]
        assert conversation.branch_chat("a", "original", message_id=None, client_id="edit", branch_id="alternative")["source_ids"] == child["source_ids"]
        fork = db.get_chat("a", "alternative", with_messages=True)
        assert [m["content"] for m in fork["messages"]] == ["Build this", "Saved original"]
        clone = db.get_plan("a", fork["messages"][-1]["plan_id"])
        assert clone["id"] != "p" and clone["chat_id"] == "alternative" and clone["plan_json"] == first
        assert db.list_messages("original") == before
        assert db.get_plan("a", "p")["plan_json"]["days"][0]["during"] == "Later activity"
        with pytest.raises(AppError):
            conversation.branch_chat("a", "original", message_id=before[-1]["id"], client_id=None, branch_id="alternative")


def test_failed_branch_is_atomic(conversation_db, monkeypatch):
    with db.as_user("a"):
        db.create_plan(plan_id="p", user_id="a", course="English", week_label="Week 3", unit=None, query="Build", plan_json={"days": []},
            docx_path=None, retrieved_ids=[], warnings=[], chat_id="original", template="fhs")
        db.add_message("original", "assistant", "Saved", plan_id="p")
        chosen = db.add_message("original", "user", "Try another")
        def fail(**_kwargs):
            raise RuntimeError("Interrupted clone")
        monkeypatch.setattr(db, "create_plan", fail)
        with pytest.raises(RuntimeError):
            conversation.branch_chat("a", "original", message_id=chosen["id"], client_id=None, branch_id="failed")
        assert db.get_chat("a", "failed") is None


def test_sources_and_metrics_have_real_rls_isolation(conversation_db):
    role = "chat_reader_" + uuid.uuid4().hex[:12]
    with db.as_user("a"):
        conversation.save_sources("a", "original", [{"filename": "Private.txt", "text": "Private source"}])
        chat_metrics.record("a", kind="chat", outcome="completed", duration_ms=500, first_response_ms=100)
    with db.borrow() as conn, conn.cursor() as cur:
        cur.execute(sql.SQL("CREATE ROLE {} NOLOGIN NOSUPERUSER NOBYPASSRLS").format(sql.Identifier(role)))
        cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(sql.Identifier(conversation_db["schema"]), sql.Identifier(role)))
        cur.execute(sql.SQL("GRANT SELECT ON ALL TABLES IN SCHEMA {} TO {}").format(sql.Identifier(conversation_db["schema"]), sql.Identifier(role)))
        conn.commit()
    try:
        with db.borrow() as conn, conn.cursor() as cur:
            cur.execute(sql.SQL("SET LOCAL ROLE {}").format(sql.Identifier(role)))
            cur.execute("SELECT set_config('app.user_id','b',true)")
            cur.execute("SELECT * FROM chats")
            assert cur.fetchall() == []
            cur.execute("SELECT * FROM chat_metrics")
            assert cur.fetchall() == []
            cur.execute("SELECT set_config('app.user_id','a',true)")
            cur.execute("SELECT sources_json FROM chats")
            assert cur.fetchone()["sources_json"][0]["text"] == "Private source"
            conn.rollback()
        report = chat_metrics.summary(30)
        assert report[0]["count"] == 1 and report[0]["p50_ms"] == 500
    finally:
        with db.borrow() as conn, conn.cursor() as cur:
            cur.execute(sql.SQL("DROP OWNED BY {}").format(sql.Identifier(role)))
            cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
            conn.commit()
