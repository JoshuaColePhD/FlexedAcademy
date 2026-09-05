"""Migration 77 — the per-state corpus split — executed against a real Postgres.

Migration 77 is the one migration that touches the live Alabama corpus, and its
whole safety argument rests on three DO blocks aborting the transaction rather
than shipping a corpus nobody checked. An assertion that is never executed is a
comment, so this runs the real SQL and checks that each guard actually fires.

Requires a Postgres to talk to; skipped otherwise. Point it at one with
TEST_PG_DSN, or run a throwaway server:

    initdb -D /tmp/pgdata -A trust
    pg_ctl -D /tmp/pgdata -o '-k /tmp -p 55432' start
    TEST_PG_DSN='host=/tmp port=55432 user=postgres dbname=postgres' pytest ...

ONE SUBSTITUTION is made to the migration text: `vector(384)` becomes `real[]`
and the HNSW index becomes a plain b-tree, because pgvector is not installable
in every environment this suite runs in. Nothing else is rewritten, and the
substitution is asserted to have applied — a silently-unsubstituted migration
would look like it passed. The guards under test are row-count parity, content
parity and the unrecognised-state refusal; none of them depend on the column
type, and `embedding::text` renders an array the same way it renders a vector.
"""

from __future__ import annotations

import ast
import os
import re
from pathlib import Path

import pytest

psycopg2 = pytest.importorskip("psycopg2")

DSN = os.environ.get("TEST_PG_DSN", "host=/tmp port=55432 user=postgres dbname=postgres")
SPLIT_MIGRATION_INDEX = 76  # migration 77, 1-based


def _migration_sql() -> str:
    """Migration 77 exactly as db.py holds it, with only the vector type stubbed."""
    src = Path(__file__).resolve().parent / "db.py"
    tree = ast.parse(src.read_text())
    for node in tree.body:
        if isinstance(node, ast.AnnAssign) and getattr(node.target, "id", "") == "MIGRATIONS":
            sql = node.value.elts[SPLIT_MIGRATION_INDEX].value
            break
    else:  # pragma: no cover - the list is a module-level literal
        raise AssertionError("MIGRATIONS not found in db.py")

    assert "chunks_al" in sql and "ALTER TABLE chunks RENAME" in sql, (
        "migration 77 is not the corpus split — SPLIT_MIGRATION_INDEX is stale"
    )

    stubbed, type_subs = re.subn(r"vector\(384\)", "real[]", sql)
    stubbed, index_subs = re.subn(
        r"USING hnsw \(embedding vector_cosine_ops\)", "(id)", stubbed
    )
    # Without this the test would pass against SQL that never ran as intended.
    assert type_subs == 2, f"expected 2 vector columns to stub, got {type_subs}"
    assert index_subs == 2, f"expected 2 hnsw indexes to stub, got {index_subs}"
    return stubbed


CREATE_LIVE_CHUNKS = """
    CREATE TABLE chunks (
        id                TEXT PRIMARY KEY,
        document          TEXT NOT NULL,
        metadata          JSONB,
        embedding         real[],
        document_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english', document)) STORED
    );
"""

# Shaped like the live corpus: Alabama course-of-study rows plus the national
# AP/ACT rows that share the table today.
SEED_ROWS = [
    ("ELA:11:ELA21.11.R2", "Read and comprehend a variety of literary texts.", "AL"),
    ("ELA:11:ELA21.11.R3", "Analyse an author's use of rhetoric.", "AL"),
    ("Math:10:MA19.GDA.5", "Interpret a scatter plot.", "AL"),
    ("AP_Lang:11:1.A", "Identify and describe the writer's audience.", "AP"),
    ("AP_Lang:11:2.B", "Explain the writer's line of reasoning.", "AP"),
    ("ELA:11:E.CSE.301", "Determine the meaning of a word in context.", "National"),
]


@pytest.fixture()
def conn():
    try:
        connection = psycopg2.connect(DSN)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"no Postgres at {DSN}: {exc}")
    connection.autocommit = False
    with connection.cursor() as cur:
        cur.execute("DROP SCHEMA IF EXISTS split_test CASCADE")
        cur.execute("CREATE SCHEMA split_test")
        cur.execute("SET search_path TO split_test")
    connection.commit()
    try:
        yield connection
    finally:
        connection.rollback()
        with connection.cursor() as cur:
            cur.execute("DROP SCHEMA IF EXISTS split_test CASCADE")
        connection.commit()
        connection.close()


def _seed(cur, rows=SEED_ROWS):
    cur.execute(CREATE_LIVE_CHUNKS)
    for i, (chunk_id, document, state) in enumerate(rows):
        cur.execute(
            "INSERT INTO chunks (id, document, metadata, embedding) "
            "VALUES (%s, %s, %s::jsonb, %s)",
            (chunk_id, document, f'{{"state": "{state}", "code": "x"}}', [float(i), 0.5]),
        )


def test_split_preserves_every_row_and_its_content(conn):
    with conn.cursor() as cur:
        _seed(cur)
        conn.commit()
        cur.execute("SET search_path TO split_test")
        cur.execute(_migration_sql())
        conn.commit()

        cur.execute("SET search_path TO split_test")
        cur.execute("SELECT count(*) FROM chunks_al")
        assert cur.fetchone()[0] == 3
        cur.execute("SELECT count(*) FROM chunks_national")
        assert cur.fetchone()[0] == 3

        # The rows are not merely counted correctly, they are the same rows.
        cur.execute("SELECT id FROM chunks_al ORDER BY id")
        assert [r[0] for r in cur.fetchall()] == [
            "ELA:11:ELA21.11.R2",
            "ELA:11:ELA21.11.R3",
            "Math:10:MA19.GDA.5",
        ]
        cur.execute("SELECT id FROM chunks_national ORDER BY id")
        assert [r[0] for r in cur.fetchall()] == [
            "AP_Lang:11:1.A",
            "AP_Lang:11:2.B",
            "ELA:11:E.CSE.301",
        ]

        # Embeddings moved as values, not as nulls — the migration's whole claim
        # is that Alabama is copied rather than re-embedded.
        cur.execute("SELECT count(*) FROM chunks_al WHERE embedding IS NULL")
        assert cur.fetchone()[0] == 0
        cur.execute(
            "SELECT embedding FROM chunks_al WHERE id = 'ELA:11:ELA21.11.R2'"
        )
        assert cur.fetchone()[0] == [0.0, 0.5]


def test_generated_tsvector_and_indexes_survive_the_split(conn):
    with conn.cursor() as cur:
        _seed(cur)
        conn.commit()
        cur.execute("SET search_path TO split_test")
        cur.execute(_migration_sql())
        conn.commit()

        cur.execute("SET search_path TO split_test")
        # A CREATE TABLE AS would have materialised this as a plain column; the
        # migration creates the table explicitly so it stays generated.
        cur.execute(
            "SELECT is_generated FROM information_schema.columns "
            "WHERE table_schema = 'split_test' AND table_name = 'chunks_al' "
            "AND column_name = 'document_tsvector'"
        )
        assert cur.fetchone()[0] == "ALWAYS"

        cur.execute(
            "SELECT indexname FROM pg_indexes "
            "WHERE schemaname = 'split_test' AND tablename IN ('chunks_al', 'chunks_national')"
        )
        names = {r[0] for r in cur.fetchall()}
        assert {"idx_chunks_al_tsvector", "idx_chunks_national_tsvector"} <= names


def test_old_table_is_renamed_not_dropped(conn):
    with conn.cursor() as cur:
        _seed(cur)
        conn.commit()
        cur.execute("SET search_path TO split_test")
        cur.execute(_migration_sql())
        conn.commit()

        cur.execute("SET search_path TO split_test")
        cur.execute("SELECT count(*) FROM chunks_pre_split")
        assert cur.fetchone()[0] == len(SEED_ROWS), "rollback copy must be intact"
        cur.execute("SELECT to_regclass('split_test.chunks')")
        assert cur.fetchone()[0] is None, "chunks must no longer exist under its old name"


def test_registry_records_both_corpora(conn):
    with conn.cursor() as cur:
        _seed(cur)
        conn.commit()
        cur.execute("SET search_path TO split_test")
        cur.execute(_migration_sql())
        conn.commit()

        cur.execute("SET search_path TO split_test")
        cur.execute(
            "SELECT state_code, table_name, row_count FROM standards_corpora ORDER BY state_code"
        )
        assert cur.fetchall() == [
            ("AL", "chunks_al", 3),
            ("NATIONAL", "chunks_national", 3),
        ]


def test_an_unrecognised_state_aborts_the_whole_migration(conn):
    """The fail-closed guard: a state nobody mapped must not default into Alabama."""
    rows = SEED_ROWS + [("ELA:11:GSE-1", "A Georgia standard nobody mapped.", "GA")]
    with conn.cursor() as cur:
        _seed(cur, rows)
        conn.commit()
        cur.execute("SET search_path TO split_test")
        with pytest.raises(psycopg2.errors.RaiseException) as excinfo:
            cur.execute(_migration_sql())
        assert "unrecognised state values" in str(excinfo.value)
        assert "GA" in str(excinfo.value)
    conn.rollback()

    # And it aborted rather than half-applying.
    with conn.cursor() as cur:
        cur.execute("SET search_path TO split_test")
        cur.execute("SELECT to_regclass('split_test.chunks_al')")
        assert cur.fetchone()[0] is None
        cur.execute("SELECT count(*) FROM chunks")
        assert cur.fetchone()[0] == len(rows), "the live table must be untouched"


def test_a_null_state_is_refused_rather_than_filed_under_alabama(conn):
    """NULL is the value a COALESCE-into-Alabama split would have swallowed."""
    with conn.cursor() as cur:
        _seed(cur)
        cur.execute(
            "INSERT INTO chunks (id, document, metadata, embedding) "
            "VALUES ('legacy:9:X', 'A row with no state recorded.', '{}'::jsonb, '{0.1}')"
        )
        conn.commit()
        cur.execute("SET search_path TO split_test")
        with pytest.raises(psycopg2.errors.RaiseException) as excinfo:
            cur.execute(_migration_sql())
        assert "<null>" in str(excinfo.value)
    conn.rollback()


def test_content_parity_guard_detects_an_altered_row(conn):
    """The content hash must be sensitive to a single changed byte.

    Exercised directly, because the migration is atomic: there is no seam at
    which to corrupt a row mid-transaction. This asserts the expression itself
    discriminates, which is what the DO block relies on.
    """
    row_hash = (
        "md5(id || chr(31) || document || chr(31) || COALESCE(embedding::text, ''))"
    )
    with conn.cursor() as cur:
        _seed(cur)
        conn.commit()
        cur.execute("SET search_path TO split_test")

        cur.execute(f"SELECT md5(string_agg(h, '' ORDER BY h)) FROM (SELECT {row_hash} AS h FROM chunks) t")
        before = cur.fetchone()[0]

        cur.execute(
            "UPDATE chunks SET document = document || '.' WHERE id = 'ELA:11:ELA21.11.R2'"
        )
        cur.execute(f"SELECT md5(string_agg(h, '' ORDER BY h)) FROM (SELECT {row_hash} AS h FROM chunks) t")
        after_text = cur.fetchone()[0]
        assert before != after_text, "a changed document must change the hash"

        cur.execute(
            "UPDATE chunks SET document = rtrim(document, '.') WHERE id = 'ELA:11:ELA21.11.R2'"
        )
        cur.execute("UPDATE chunks SET embedding = '{9.9,0.5}' WHERE id = 'ELA:11:ELA21.11.R2'")
        cur.execute(f"SELECT md5(string_agg(h, '' ORDER BY h)) FROM (SELECT {row_hash} AS h FROM chunks) t")
        assert before != cur.fetchone()[0], "a changed embedding must change the hash"
    conn.rollback()
