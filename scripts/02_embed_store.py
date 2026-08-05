#!/usr/bin/env python3
"""
Step 2 — Embed and store the parsed standards in a local vector database.

Local ChromaDB + sentence-transformers, so nothing leaves the machine and a
rebuild costs no API credit. Metadata is preserved so retrieval can filter by
course/grade/source_type.

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
import json
import re
import sys
from collections import Counter
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
DB_PATH = PROJECT_ROOT / "data" / "db" / "chroma_db"
COLLECTION_NAME = "ap_lang_standards"
# Kept as a label for the printout; the authoritative values live in
# backend/embeddings.py, which is what actually does the work.
from backend.embeddings import EMBED_DIMS, EMBED_MODEL  # noqa: E402

# Chroma's own ceiling on a single add/upsert call.
BATCH_SIZE = 5000


def chunk_id(chunk: dict) -> str:
    """Deterministic, human-readable, unique per (course, grade, code)."""
    course = chunk.get("course") or "?"
    grade = chunk.get("grade")
    grade_s = "K" if grade == 0 else ("na" if grade is None else str(grade))
    code = re.sub(r"\s+", " ", str(chunk.get("code") or "?")).strip()
    return f"{course}:{grade_s}:{code}"


def flatten(chunk: dict) -> dict:
    """Chroma metadata accepts str/int/float/bool only. Lists join, Nones drop.

    `code` is kept in the metadata deliberately: retrieval reads the citable code
    from here rather than from the Chroma id, so the id is free to carry the
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
        notes.append(f"  {path.name}: {len(loaded)} chunks")
        chunks.extend(loaded)
    return chunks, notes


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--upsert", action="store_true",
                    help="add to the existing collection instead of rebuilding it")
    ap.add_argument("--dry-run", action="store_true",
                    help="report what would be embedded, then stop")
    args = ap.parse_args()

    chunks, notes = load_all_chunks()
    if not chunks:
        print("Error: no *chunks.json found. Run the step-1 parsers first.")
        return 1

    print("Chunk sources:")
    for line in notes:
        print(line)

    # Collapse duplicates deterministically: last file wins for a given id, and
    # the winner is reported so a real collision can't hide.
    by_id: dict[str, dict] = {}
    collisions = Counter()
    for chunk in chunks:
        cid = chunk_id(chunk)
        if cid in by_id and by_id[cid].get("description") != chunk.get("description"):
            collisions[cid] += 1
        by_id[cid] = chunk

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
              f"(last file wins): {list(collisions)[:5]}")
    print("By course:", dict(Counter(m.get("course", "?") for m in metadatas)))
    print("By source_type:", dict(Counter(m.get("source_type", "?") for m in metadatas)))

    if args.dry_run:
        print("\n--dry-run: nothing written.")
        return 0


    print("\\nPostgreSQL Database configured in settings.")
    from backend import db
    from backend.embeddings import embed_texts

    conn = db.connect()
    
    if not args.upsert:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM chunks")
            conn.commit()
            print("Dropped existing chunks.")

    print(f"Embedding {len(ids)} chunks with {EMBED_MODEL} ({EMBED_DIMS} dims)...")
    
    with conn.cursor() as cur:
        for start in range(0, len(ids), BATCH_SIZE):
            end = min(start + BATCH_SIZE, len(ids))
            print(f"  {start}-{end}")
            
            batch_ids = ids[start:end]
            batch_docs = documents[start:end]
            batch_metas = metadatas[start:end]
            
            # One API call per sub-batch, retried inside embed_texts.
            batch_embs = embed_texts(batch_docs)
            
            from psycopg2.extras import execute_values
            import json
            
            # Use execute_values for fast insert
            values = []
            for i, d, m, e in zip(batch_ids, batch_docs, batch_metas, batch_embs):
                values.append((i, d, json.dumps(m), e))
                
            execute_values(
                cur,
                "INSERT INTO chunks (id, document, metadata, embedding) VALUES %s ON CONFLICT (id) DO UPDATE SET document = EXCLUDED.document, metadata = EXCLUDED.metadata, embedding = EXCLUDED.embedding",
                values
            )
            conn.commit()
            
        cur.execute("SELECT COUNT(*) FROM chunks")
        final = cur.fetchone()["count"]
        
    print(f"\\nStored {final} chunks in PostgreSQL 'chunks' table.")

    # Spot check
    with conn.cursor() as cur:
        cur.execute("SELECT id, metadata FROM chunks LIMIT 1")
        sample = cur.fetchone()
        
    if sample:
        meta = sample["metadata"]
        print("Spot-check:", sample["id"],
              f"-> course={meta.get('course')} grade={meta.get('grade')} "
              f"code={meta.get('code')} verbatim_ok={meta.get('verbatim_ok')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
