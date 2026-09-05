"""The per-state corpus split must not change what a search returns.

Migration 77 gave each state its own table, so `retrieve_raw` now reads one
branch per corpus and re-limits the union instead of scanning one shared table.
The claim that makes that safe is a partition argument: a row in the global
top-n by distance is necessarily in the top-n of the table it lives in, so
re-limiting the union of per-table top-n yields exactly the global top-n.

That argument is worth exactly as much as a test of it, so these run the real
SQL `_hybrid_search_sql` emits — against one combined table and against the two
split tables holding the same rows — and require the results to be identical,
including RRF order. They also pin the placeholder/parameter agreement, because
a mis-ordered bind list is a silently wrong search rather than an error.

pgvector is not installable in every environment this suite runs in, so a
`vector` domain and a `<=>` cosine-distance operator stand in for it. Both the
combined and the split query run against the same stand-in, so the comparison
between them — which is the whole point — is unaffected.

Requires a Postgres; skipped otherwise. See test_corpus_split_migration.py for
how to start a throwaway one.
"""

from __future__ import annotations

import os

import pytest

psycopg2 = pytest.importorskip("psycopg2")

from backend.retrieval import _hybrid_search_params, _hybrid_search_sql  # noqa: E402

DSN = os.environ.get("TEST_PG_DSN", "host=/tmp port=55432 user=postgres dbname=postgres")

PGVECTOR_STANDIN = """
    CREATE DOMAIN vector AS double precision[];

    CREATE FUNCTION cosine_distance(a double precision[], b double precision[])
    RETURNS double precision AS $$
        SELECT 1 - (
            (SELECT sum(x * y) FROM unnest(a, b) AS t(x, y))
            / (sqrt((SELECT sum(x * x) FROM unnest(a) AS t(x)))
               * sqrt((SELECT sum(y * y) FROM unnest(b) AS t(y))))
        );
    $$ LANGUAGE sql IMMUTABLE;

    CREATE OPERATOR <=> (
        LEFTARG = double precision[], RIGHTARG = double precision[],
        FUNCTION = cosine_distance
    );
"""


def _create_corpus(cur, table: str) -> None:
    cur.execute(f"""
        CREATE TABLE {table} (
            id                TEXT PRIMARY KEY,
            document          TEXT NOT NULL,
            metadata          JSONB,
            embedding         vector,
            document_tsvector tsvector GENERATED ALWAYS AS (to_tsvector('english', document)) STORED
        );
    """)


# Deliberately interleaved: the nearest rows to the probe alternate between the
# two corpora, so a split query that simply concatenated per-table top-n without
# re-limiting would produce a different ranking than the combined one.
ROWS = [
    ("ELA:11:R1", "Analyse how an author develops a claim in an argument.", "AL", "state_course_of_study", [1.00, 0.02, 0.01]),
    ("ELA:11:R2", "Evaluate the rhetorical choices a writer makes.",         "AL", "state_course_of_study", [0.96, 0.10, 0.02]),
    ("ELA:11:R3", "Cite textual evidence to support an analysis.",           "AL", "state_course_of_study", [0.80, 0.30, 0.05]),
    ("ELA:11:R4", "Describe the structure of a photosynthesis reaction.",    "AL", "state_course_of_study", [0.05, 0.99, 0.10]),
    ("ELA:11:E.CSE.301", "Determine the meaning of a word in context.",      "National", "act_standards", [0.98, 0.05, 0.03]),
    ("ELA:11:E.TOD.401", "Delete material that is irrelevant to an essay.",  "National", "act_standards", [0.90, 0.20, 0.04]),
    ("ELA:11:E.ORG.601", "Use transitions between paragraphs in an essay.",  "National", "act_standards", [0.70, 0.40, 0.06]),
]

PROBE = [1.0, 0.0, 0.0]


@pytest.fixture()
def cur():
    try:
        conn = psycopg2.connect(DSN)
    except psycopg2.OperationalError as exc:
        pytest.skip(f"no Postgres at {DSN}: {exc}")
    conn.autocommit = True
    with conn.cursor() as c:
        c.execute("DROP SCHEMA IF EXISTS routing_test CASCADE")
        c.execute("CREATE SCHEMA routing_test")
        c.execute("SET search_path TO routing_test")
        c.execute(PGVECTOR_STANDIN)

        for table in ("chunks_combined", "chunks_al", "chunks_national"):
            _create_corpus(c, table)
        for chunk_id, document, state, source_type, vec in ROWS:
            target = "chunks_al" if state == "AL" else "chunks_national"
            for table in ("chunks_combined", target):
                c.execute(
                    f"INSERT INTO {table} (id, document, metadata, embedding) "
                    f"VALUES (%s, %s, %s::jsonb, %s)",
                    (chunk_id, document,
                     f'{{"state": "{state}", "source_type": "{source_type}", '
                     f'"course": "ELA", "grade": 11}}',
                     vec),
                )
        try:
            yield c
        finally:
            c.execute("DROP SCHEMA IF EXISTS routing_test CASCADE")
            conn.close()


def _run(cur, tables, where_clause, where_params, n, query="rhetorical choices in an essay"):
    sql = _hybrid_search_sql(tables, where_clause)
    params = _hybrid_search_params(tables, query, PROBE, list(where_params), n)
    cur.execute("SET search_path TO routing_test")
    cur.execute(sql, params)
    return [(r[0], round(float(r[3]), 12)) for r in cur.fetchall()]


@pytest.mark.parametrize("n", [1, 2, 3, 5, 7, 20])
def test_split_corpora_return_exactly_what_one_table_returned(cur, n):
    """The partition argument, executed rather than asserted."""
    combined = _run(cur, ("chunks_combined",), "1=1", [], n)
    split = _run(cur, ("chunks_al", "chunks_national"), "1=1", [], n)
    assert split == combined, f"split ranking diverged from combined at n={n}"


def test_identical_with_a_real_where_clause(cur):
    """The same equivalence must hold once the usual metadata filters apply."""
    where = "1=1 AND metadata->>'course' = ANY(%s) AND (metadata->>'grade')::int = %s"
    args = [["ELA"], 11]
    combined = _run(cur, ("chunks_combined",), where, args, 4)
    split = _run(cur, ("chunks_al", "chunks_national"), where, args, 4)
    assert split == combined
    assert combined, "fixture should return rows, otherwise this proves nothing"


def test_reading_one_corpus_cannot_see_the_other(cur):
    """Structural isolation: the rows are not filtered out, they are not there."""
    only_al = _run(cur, ("chunks_al",), "1=1", [], 20)
    ids = {chunk_id for chunk_id, _ in only_al}
    assert ids and all(i.startswith("ELA:11:R") for i in ids)
    assert not any("CSE" in i or "TOD" in i or "ORG" in i for i in ids)

    only_national = _run(cur, ("chunks_national",), "1=1", [], 20)
    national_ids = {chunk_id for chunk_id, _ in only_national}
    assert national_ids and ids.isdisjoint(national_ids)


@pytest.mark.parametrize("tables", [
    ("chunks_al",),
    ("chunks_al", "chunks_national"),
    ("chunks_ga", "chunks_national"),
])
@pytest.mark.parametrize("where,count", [
    ("1=1", 0),
    ("1=1 AND metadata->>'course' = ANY(%s) AND (metadata->>'grade')::int = %s", 2),
])
def test_hybrid_search_params_match_placeholders(tables, where, count):
    """A bind list off by one is a wrong search, not an error — pin the count."""
    sql = _hybrid_search_sql(tables, where)
    params = _hybrid_search_params(tables, "q", [0.1], [None] * count, 5)
    assert sql.count("%s") == len(params)
