import re

with open("backend/retrieval.py", "r") as f:
    code = f.read()

# Remove chromadb get_collection
code = re.sub(r'@functools\.lru_cache\(maxsize=1\)\ndef get_collection\(\):.*?\n\n', '', code, flags=re.DOTALL)

# Add get_embedding_model
embed_new = """@functools.lru_cache(maxsize=1)
def get_embedding_model():
    from sentence_transformers import SentenceTransformer
    log.info("Loading SentenceTransformer (%s)...", EMBED_MODEL)
    return SentenceTransformer(EMBED_MODEL)

def embed_query(query: str) -> list[float]:
    return get_embedding_model().encode(query).tolist()
"""
code = code.replace("def load_chunks() -> list[dict]:", embed_new + "\ndef load_chunks() -> list[dict]:")

# Replace retrieve_raw
retrieve_raw_new = """def retrieve_raw(query: str, n: int, course: str, grade: int, source_type: str | None = None) -> list[dict]:
    query_vector = embed_query(query)
    from . import db
    
    sql = "SELECT id, document, metadata, embedding <=> %s::vector AS distance FROM chunks WHERE 1=1"
    params = [query_vector]
    
    if source_type in ("act_standards", "act_recurring"):
        sql += " AND metadata->>'source_type' = %s"
        params.append(source_type)
    else:
        sql += " AND metadata->>'course' = %s"
        params.append(course)
        
        # The OR condition
        sql += " AND ((metadata->>'grade')::int = %s OR metadata->>'source_type' IN ('college_board', 'ap_skills'))"
        params.append(grade)
        
        if source_type:
            sql += " AND metadata->>'source_type' = %s"
            params.append(source_type)
            
    sql += " ORDER BY embedding <=> %s::vector LIMIT %s"
    params.extend([query_vector, n])
    
    rows = db._rows(sql, tuple(params))
    
    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "document": r["document"],
            "metadata": r["metadata"],
            "distance": float(r["distance"])
        })
    return out
"""
code = re.sub(r'def retrieve_raw\(query: str, n: int, where: dict \| None = None\) -> list\[dict\]:.*?return out\n', retrieve_raw_new, code, flags=re.DOTALL)

# Update retrieve_grounded to call new retrieve_raw
retrieve_grounded_new = """def retrieve_grounded(
    query: str,
    subject_code: str = "AP_Lang",
    grade: int = 11,
    top_k: int | None = None,
    max_distance: float | None = None,
    extra_queries: list[str] | None = None,
) -> RetrievalResult:
    top_k = top_k or settings.retrieval_top_k
    floor = settings.floor_for(subject_code) if max_distance is None else max_distance

    searches = [query, *(extra_queries or [])]
    best: dict[str, dict] = {}

    def consider(hits: list[dict]) -> None:
        for c in hits:
            prev = best.get(c["id"])
            if prev is None or c["distance"] < prev["distance"]:
                best[c["id"]] = c

    for q in searches:
        # Over-fetch then filter
        consider(retrieve_raw(q, n=max(top_k * 3, top_k), course=subject_code, grade=grade, source_type=None))
        # Then per stratum
        for source_type in STRATA:
            try:
                consider(retrieve_raw(q, n=top_k, course=subject_code, grade=grade, source_type=source_type))
            except Exception as e:
                log.warning("stratified retrieval failed for %s: %s", source_type, e)

    raw = sorted(best.values(), key=lambda c: c["distance"])

    survivors = [c for c in raw if c["distance"] <= floor]
    
    if survivors:
        try:
            reranker = get_reranker()
            pairs = [[query, c["document"]] for c in survivors]
            scores = reranker.predict(pairs)
            for c, s in zip(survivors, scores):
                c["rerank_score"] = float(s)
            survivors = sorted(survivors, key=lambda c: c["rerank_score"], reverse=True)
            log.info("Reranked %d candidates using CrossEncoder.", len(survivors))
        except Exception as e:
            log.warning("CrossEncoder reranking failed, falling back to embedding distance: %s", e)

    keep = survivors[:top_k]
    kept_ids = {c["id"] for c in keep}
    for source_type in STRATA:
        best_stratum = next(
            (c for c in survivors if (c.get("metadata") or {}).get("source_type") == source_type),
            None,
        )
        if best_stratum and best_stratum["id"] not in kept_ids:
            keep.append(best_stratum)
            kept_ids.add(best_stratum["id"])
    keep.sort(key=lambda c: -c.get("rerank_score", -c["distance"]))

    drop = [{"id": c["id"], "distance": c["distance"]} for c in raw if c["distance"] > floor][:3]

    log.info(
        "retrieval query_len=%d kept=%d floor=%.2f best=%.3f",
        len(query),
        len(keep),
        floor,
        raw[0]["distance"] if raw else -1,
    )
    return RetrievalResult(chunks=keep, rejected=drop, floor=floor)
"""
code = re.sub(r'def retrieve_grounded\(.*?\) -> RetrievalResult:.*?return RetrievalResult\(chunks=keep, rejected=drop, floor=floor\)\n', retrieve_grounded_new, code, flags=re.DOTALL)

with open("backend/retrieval_pg.py", "w") as f:
    f.write(code)

import os
os.replace("backend/retrieval_pg.py", "backend/retrieval.py")
