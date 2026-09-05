"""
Step 2 — Embed and store the parsed standards in Supabase Postgres.

OpenAI embeddings are staged in Supabase Postgres/pgvector. The local SQLite
cache avoids re-embedding unchanged text, while metadata is preserved so
retrieval can filter by course/grade/source_type and audit source provenance.

Two properties this script is responsible for:

**Reproducibility.** Every chunk in the store must come from a `*chunks.json` in
the repo. It used to `upsert` into whatever was already there, which meant the
store accumulated rows from earlier runs whose chunk files had since been
overwritten — the live collection held 12,085 chunks that no file in the repo
could account for, including two hand-written placeholder standards. Deleting the
directory would have silently dropped thousands of standards. So the default is
now a full rebuild: drop the collection, re-embed from the files on disk.
`--upsert` restores the old add-to-existing behaviour when you know you want it.

**Stable ids.** Ids are `{course}:{grade}:{code}`, derived from the chunk, so the
same chunk always lands on the same id and a rebuild is idempotent. The previous
`{source_document}_{code}` scheme collided as soon as one standard covered
several grades (a standard tagged 9-12 is one chunk per grade) and disambiguated
with an arbitrary `_1`, `_2` suffix whose assignment depended on dict ordering.

Usage:
    python scripts/02_embed_store.py              # full rebuild (default)
    python scripts/02_embed_store.py --upsert     # add to the existing collection
    python scripts/02_embed_store.py --dry-run    # report what would be embedded
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import struct
import sys
from collections import Counter, defaultdict
from datetime import UTC, datetime
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "db" / "chroma_db"
COLLECTION_NAME = "flexed_academy_standards"
# Kept as a label for the printout; the authoritative values live in
# backend/embeddings.py, which is what actually does the work.
from backend.embeddings import EMBED_DIMS, EMBED_MODEL

# The Supabase pooler has intermittently corrupted COPY and multi-row INSERT
# payloads over TLS. One-row writes are slower, but they are the proven-safe
# release path; the local content-addressed embedding cache makes retries and
# incremental rebuilds cheap by avoiding repeat API work.
BATCH_SIZE = 1000
EMBED_CACHE_PATH = PROJECT_ROOT / ".cache" / "standards_embeddings.sqlite3"


def chunk_id(chunk: dict) -> str:
    """Deterministic, human-readable, unique per (course, grade, code)."""
    course = chunk.get("course") or "?"
    grade = chunk.get("grade")
    grade_s = "K" if grade == 0 else ("na" if grade is None else str(grade))
    code = re.sub(r"\s+", " ", str(chunk.get("code") or "?")).strip()
    return f"{course}:{grade_s}:{code}"


def flatten(chunk: dict) -> dict:
    """Postgres JSONB metadata keeps the source fields queryable. Lists join,
    Nones drop.

    `code` is kept in the metadata deliberately: retrieval reads the citable code
    from here rather than from the vector id, so the id is free to carry the
    course/grade disambiguation without corrupting the grounding audit.
    """
    meta = {}
    for k, v in chunk.items():
        if k == "embed_text" or v is None:
            continue
        if isinstance(v, (list, tuple)):
            if not v:
                continue
            meta[k] = " | ".join(str(i) for i in v)
        elif isinstance(v, (str, int, float, bool)):
            meta[k] = v
        else:
            meta[k] = str(v)
    return meta


def load_all_chunks() -> tuple[list[dict], list[str]]:
    files = sorted((PROJECT_ROOT / "data" / "processed").glob("*chunks.json"))
    chunks, notes = [], []
    for path in files:
        with open(path, encoding="utf-8") as f:
            loaded = json.load(f)
        snapshot = hashlib.sha256(path.read_bytes()).hexdigest()
        # Keep this provenance on the records that are embedded, not only in a
        # console line. The live corpus can then be audited back to the exact
        # processed input file without trusting a filename alone.
        loaded = [
            {
                **chunk,
                "source_snapshot_sha256": chunk.get("source_snapshot_sha256") or snapshot,
                "embedding_model": EMBED_MODEL,
                "embedding_dimensions": EMBED_DIMS,
            }
            for chunk in loaded
        ]
        notes.append(f"  {path.name}: {len(loaded)} chunks")
        chunks.extend(loaded)
    return chunks, notes


def _cache_key(document: str) -> str:
    """Stable cache key for one document in one embedding configuration."""
    payload = f"{EMBED_MODEL}\0{EMBED_DIMS}\0{document}".encode()
    return hashlib.sha256(payload).hexdigest()


def _open_embedding_cache() -> sqlite3.Connection:
    """Open the local, rebuildable embedding cache."""
    EMBED_CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(EMBED_CACHE_PATH)
    conn.execute(
        "CREATE TABLE IF NOT EXISTS embeddings ("
        "cache_key TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL, "
        "vector BLOB NOT NULL)"
    )
    return conn


def embed_documents_cached(documents: list[str]) -> tuple[list[list[float]], int]:
    """Embed documents, reusing vectors for unchanged text when possible.

    The cache is intentionally local and rebuildable. It is not a source of
    truth and is never uploaded; the text/model/dimension hash makes reuse safe
    across interrupted rebuilds and future corpus changes.
    """
    keys = [_cache_key(document) for document in documents]
    conn = _open_embedding_cache()
    try:
        cached: dict[str, list[float]] = {}
        for start in range(0, len(keys), 500):
            wanted = keys[start : start + 500]
            placeholders = ",".join("?" for _ in wanted)
            rows = conn.execute(
                f"SELECT cache_key, vector FROM embeddings WHERE cache_key IN ({placeholders})",
                wanted,
            )
            for cache_key, blob in rows:
                try:
                    vector = list(struct.unpack(f"<{EMBED_DIMS}f", blob))
                except struct.error:
                    continue
                if len(vector) == EMBED_DIMS:
                    cached[cache_key] = vector

        reused_count = sum(key in cached for key in keys)
        missing_keys = list(dict.fromkeys(key for key in keys if key not in cached))
        if missing_keys:
            from backend.embeddings import embed_texts

            document_by_key = dict(zip(keys, documents))
            missing_documents = [document_by_key[key] for key in missing_keys]
            embedded = embed_texts(missing_documents)
            if any(len(vector) != EMBED_DIMS for vector in embedded):
                raise RuntimeError("embedding API returned a vector with the wrong dimensions")
            conn.executemany(
                "INSERT OR REPLACE INTO embeddings(cache_key, model, dims, vector) "
                "VALUES (?, ?, ?, ?)",
                [
                    (key, EMBED_MODEL, EMBED_DIMS,
                     struct.pack(f"<{EMBED_DIMS}f", *vector))
                    for key, vector in zip(missing_keys, embedded)
                ],
            )
            conn.commit()
            cached.update(zip(missing_keys, embedded))

        return [cached[key] for key in keys], reused_count
    finally:
        conn.close()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upsert", action="store_true",
                    help="add to the existing collection instead of rebuilding it")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be embedded, then stop")
    ap.add_argument("--state", default=None, metavar="CODE",
                    help="build ONE corpus: a two-letter state code, or NATIONAL "
                         "for the shared AP/College Board/ACT rows. Required now "
                         "that each state has its own table.")
    args = ap.parse_args()

    if not args.state:
        print("Error: --state is required. Each state now has its own corpus table\n"
              "       (migration 77), so a rebuild has to say which one it is "
              "rebuilding.\n"
              "       e.g. --state AL, --state GA, --state NATIONAL")
        return 1
    state = args.state.strip().upper()
    if not re.fullmatch(r"[A-Z]{2}|NATIONAL", state):
        print(f"Error: --state {args.state!r} is not a two-letter code or NATIONAL.")
        return 1
    target_table = "chunks_national" if state == "NATIONAL" else f"chunks_{state.lower()}"

    chunks, notes = load_all_chunks()
    # Select by the chunk's OWN state, not by which file it came from. That is
    # the same rule migration 77 split the live table with, so a rebuild lands
    # each row exactly where the migration put it.
    wanted = {"AP", "National"} if state == "NATIONAL" else {state}
    before = len(chunks)
    chunks = [c for c in chunks if (c.get("state") or "") in wanted]
    notes.append(f"  --state {state}: kept {len(chunks)} of {before} chunks")
    if not chunks:
        print("Error: no *chunks.json found. Run the step-1 parsers first.")
        return 1

    print("Chunk sources:")
    for line in notes:
        print(line)

    # Group by the naive (course, grade, code) id first. Two chunks that land
    # on the same naive id with the SAME description are the same standard
    # (dedup, keep one) — but two with DIFFERENT descriptions are two real,
    # distinct standards that happen to share a short code, which is the norm
    # for the 2026-08-22 AP CED re-ingest: bare sub-skill codes like "1.A" or
    # "2.B" repeat across every unit in a course, not just once. The old
    # last-write-wins behavior treated the second case exactly like the
    # first and silently discarded every standard but the last at each id —
    # 2,756 of 5,468 fresh AP standards (50%) on the first real run of the
    # new pipeline, with only a same-sized "collisions" counter printed to
    # suggest anything was wrong. Every DISTINCT description now gets its own
    # id (a numeric suffix beyond the first), so nothing is dropped; a
    # genuine re-run of unchanged data still collapses to the same ids.
    groups: dict[str, list[dict]] = defaultdict(list)
    for chunk in chunks:
        groups[chunk_id(chunk)].append(chunk)

    by_id: dict[str, dict] = {}
    collisions = Counter()
    for cid, group in groups.items():
        seen_descriptions: dict[str, str] = {}  # description -> assigned id
        for chunk in group:
            desc = chunk.get("description")
            if desc in seen_descriptions:
                by_id[seen_descriptions[desc]] = chunk  # later file/batch wins the content, same id
                continue
            assigned_id = cid if not seen_descriptions else f"{cid}:{len(seen_descriptions) + 1}"
            if seen_descriptions:
                collisions[cid] += 1
            seen_descriptions[desc] = assigned_id
            by_id[assigned_id] = chunk

    ids = list(by_id)
    documents = [by_id[i].get("embed_text") or by_id[i].get("description") or "" for i in ids]
    metadatas = [flatten(by_id[i]) for i in ids]

    missing_text = [i for i, d in zip(ids, documents) if not d.strip()]
    if missing_text:
        print(f"Error: {len(missing_text)} chunks have no text to embed, "
              f"e.g. {missing_text[:3]}")
        return 1

    print(f"\n{len(chunks)} chunks -> {len(ids)} unique ids")
    if collisions:
        print(f"WARNING: {len(collisions)} ids collided with DIFFERING text "
              f"(distinct descriptions receive suffix IDs): {list(collisions)[:5]}")
    print("By course:", dict(Counter(m.get("course", "?") for m in metadatas)))
    print("By source_type:", dict(Counter(m.get("source_type", "?") for m in metadatas)))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0


    print("\\nPostgreSQL Database configured in settings.")
    from backend import db
    db.connect()
    # A real `with`, not ctx.__enter__(). borrow() takes a pool slot and a
    # semaphore permit; entering without exiting leaks both. Harmless in a
    # script that exits immediately, wrong everywhere else, and this file is
    # the example someone copies.
    # A unique run suffix prevents the next staging table from colliding with
    # indexes left on the live table by a prior successful swap. Indexes are
    # normalized to stable names after the old table is removed at cutover.
    run_token = f"{datetime.now(UTC):%Y%m%d%H%M%S}_{os.getpid()}"
    staging_table = f"{target_table}__rebuild_staging_{run_token}"
    if not args.upsert:
        # Build beside the live table. A transient API or database failure must
        # not leave the live site with a partial corpus.
        with db.borrow() as conn, conn.cursor() as cur:
            # Clean up the old fixed-name staging attempt from pre-suffix
            # versions. New runs use a unique name and therefore need no
            # broad catalog scan or destructive wildcard cleanup.
            cur.execute(f"DROP TABLE IF EXISTS {staging_table}")
            cur.execute(f"""
                    CREATE TABLE {staging_table} (
                        id TEXT PRIMARY KEY,
                        document TEXT NOT NULL,
                        metadata JSONB,
                        embedding vector(384),
                        document_tsvector tsvector
                            GENERATED ALWAYS AS (to_tsvector('english', document)) STORED
                    )
                """)
            cur.execute(f"ALTER TABLE {staging_table} ENABLE ROW LEVEL SECURITY")
            conn.commit()
        print("Created isolated staging table; live chunks remain untouched.")
    else:
        print("Upsert mode: writing directly to the live chunks table.")

    print(f"Embedding {len(ids)} chunks with {EMBED_MODEL} ({EMBED_DIMS} dims)...")
    for start in range(0, len(ids), BATCH_SIZE):
        end = min(start + BATCH_SIZE, len(ids))
        print(f"  {start}-{end}")

        batch_ids = ids[start:end]
        batch_docs = documents[start:end]
        batch_metas = metadatas[start:end]

        # Do not hold a pooled database connection open while waiting on the
        # embeddings API; Supabase can expire an idle TLS connection mid-batch.
        batch_embs, cached_count = embed_documents_cached(batch_docs)
        if cached_count:
            print(f"    reused {cached_count}/{len(batch_docs)} cached vectors")
        values = [
            (i, d, json.dumps(m), e)
            for i, d, m, e in zip(batch_ids, batch_docs, batch_metas, batch_embs)
        ]
        table = target_table if args.upsert else staging_table
        with db.borrow() as conn:
            with conn.cursor() as cur:
                for value in values:
                    cur.execute(
                        f"INSERT INTO {table} (id, document, metadata, embedding) "
                        "VALUES (%s, %s, %s::jsonb, %s) "
                        "ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, "
                        "metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding",
                        value,
                    )
                conn.commit()
            # Supabase's pooler has intermittently returned a connection with
            # a broken TLS record on the following large write. Do not return
            # this batch connection to the pool for reuse; the next borrow will
            # replace it with a fresh physical connection.
            conn.close()

    if not args.upsert:
        # Build indexes after loading. Maintaining HNSW for every inserted row
        # is substantially slower than one set-based build, and the staging
        # table remains private until both indexes finish successfully.
        print("Building staging vector and full-text indexes...")
        with db.borrow() as conn, conn.cursor() as cur:
            cur.execute(
                f"CREATE INDEX {staging_table}_embedding_idx ON {staging_table} "
                "USING hnsw (embedding vector_cosine_ops)"
            )
            cur.execute(
                f"CREATE INDEX {staging_table}_tsvector_idx ON {staging_table} "
                "USING gin (document_tsvector)"
            )
            conn.commit()

    with db.borrow() as conn, conn.cursor() as cur:
        table = target_table if args.upsert else staging_table
        cur.execute(f"SELECT COUNT(*) FROM {table}")
        final = cur.fetchone()["count"]

        if not args.upsert:
            if final != len(ids):
                raise RuntimeError(
                    f"staging row count {final} does not match expected {len(ids)}"
                )
            # Brief atomic cutover. Any exception before commit leaves the
            # original chunks table in place.
            # Only THIS state's table is touched. Every other corpus keeps its
            # rows and its indexes throughout — which is the point of the split:
            # rebuilding Georgia must not be able to disturb Alabama.
            cur.execute(f"LOCK TABLE {target_table} IN ACCESS EXCLUSIVE MODE")
            cur.execute(f"ALTER TABLE {target_table} RENAME TO {target_table}__rebuild_previous")
            cur.execute(f"ALTER TABLE {staging_table} RENAME TO {target_table}")
            cur.execute(f"DROP TABLE {target_table}__rebuild_previous")
            cur.execute(
                f"ALTER INDEX {staging_table}_embedding_idx "
                f"RENAME TO idx_{target_table}_embedding"
            )
            cur.execute(
                f"ALTER INDEX {staging_table}_tsvector_idx "
                f"RENAME TO idx_{target_table}_tsvector"
            )
            cur.execute(f"ALTER TABLE {target_table} ENABLE ROW LEVEL SECURITY")
            conn.commit()
            print(f"Atomically swapped the validated staging corpus into {target_table}.")

        # The registry is how retrieval finds this table at all, and how the
        # post-cutover checks confirm every corpus shares one embedding model.
        cur.execute(
            "INSERT INTO standards_corpora "
            "  (state_code, table_name, row_count, embedding_model, embedding_dims, ingested_at) "
            "VALUES (%s, %s, %s, %s, %s, %s) "
            "ON CONFLICT (state_code) DO UPDATE SET "
            "  table_name = EXCLUDED.table_name, row_count = EXCLUDED.row_count, "
            "  embedding_model = EXCLUDED.embedding_model, "
            "  embedding_dims = EXCLUDED.embedding_dims, "
            "  ingested_at = EXCLUDED.ingested_at",
            (state, target_table, final, EMBED_MODEL, EMBED_DIMS,
             datetime.now(UTC).isoformat(timespec="seconds")),
        )
        conn.commit()

        print(f"\\nStored {final} chunks in PostgreSQL {target_table!r}.")

        cur.execute(f"SELECT id, metadata FROM {target_table} LIMIT 1")
        sample = cur.fetchone()

        if sample:
            meta = sample["metadata"]
            print("Spot-check:", sample["id"],
                  f"-> course={meta.get('course')} grade={meta.get('grade')} "
                  f"code={meta.get('code')} verbatim_ok={meta.get('verbatim_ok')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
