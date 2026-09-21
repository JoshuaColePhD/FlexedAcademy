"""Upgrade the complete production schema in a disposable localhost database."""
from psycopg2 import sql

from backend import db


def test_production_upgrade_preserves_plans_presence_and_version_history(local_pg_database, monkeypatch):
    # Historical migrations revoke Supabase's API roles. Match those names in
    # this isolated database without altering any role that already exists.
    created_roles = []
    for role in ("anon", "authenticated"):
        if not db._row("SELECT 1 FROM pg_roles WHERE rolname = ?", (role,)):
            with db.borrow() as conn, conn.cursor() as cur:
                cur.execute(sql.SQL("CREATE ROLE {} NOLOGIN").format(sql.Identifier(role)))
                conn.commit()
            created_roles.append(role)
    try:
        db._write("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public")
        # Migration 56 documents this legacy table as provisioned by a
        # one-off corpus load outside MIGRATIONS. Its security migration only
        # needs the table to exist; no corpus data is needed for this upgrade.
        db._write("CREATE TABLE global_standards(id TEXT PRIMARY KEY)")
        migrations = db.MIGRATIONS
        production_version = 88
        assert "last_login_at TEXT" in migrations[production_version - 1]
        with monkeypatch.context() as patch:
            patch.setattr(db, "MIGRATIONS", migrations[:production_version])
            with db.borrow() as conn:
                db.migrate(conn)
        db._write("""
            INSERT INTO users(id,email,name,created_at,last_login_at,last_seen_at)
            VALUES ('release-owner','release@example.test','Release fixture','2026-09-21',
                    '2026-09-21T12:00:00+00:00','2026-09-21T12:01:00+00:00');
            INSERT INTO plans(id,user_id,created_at,course,week_label,query,plan_json,
                              docx_path,retrieved_ids,warnings)
            VALUES ('release-plan','release-owner','2026-09-21','English','Week 8','Plan writing',
                    '{"days":[{"name":"Monday","during":"Practice claims"}]}',
                    'legacy.docx','[]','[]');
        """)
        for _ in range(2):
            with db.borrow() as conn:
                db.migrate(conn)
        assert db._row("SELECT MAX(version) AS version FROM schema_version")["version"] == len(migrations)
        assert db.get_user_by_id("release-owner")["last_seen_at"] == "2026-09-21T12:01:00+00:00"
        with db.as_user("release-owner"):
            before = db.get_plan("release-owner", "release-plan")
            assert before["revision"] == 1
            assert before["docx_path"] == "legacy.docx"
            assert before["plan_json"]["days"][0]["during"] == "Practice claims"
            after = db.update_plan("release-owner", "release-plan",
                                   plan_json={"days": [{"name": "Monday", "during": "Revise claims"}]},
                                   docx_path=None)
            assert after["revision"] == 2
            assert db.get_document_build_status("release-plan", "release-owner")["plan_revision"] == 2
            versions = db._rows("SELECT revision,plan_json FROM plan_versions WHERE plan_id='release-plan' ORDER BY revision")
            assert [version["revision"] for version in versions] == [1, 2]
            assert versions[0]["plan_json"] == before["plan_json"]
    finally:
        for role in created_roles:
            with db.borrow() as conn, conn.cursor() as cur:
                cur.execute(sql.SQL("DROP ROLE {}").format(sql.Identifier(role)))
                conn.commit()
