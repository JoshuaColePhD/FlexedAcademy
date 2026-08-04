"""Retrieval with a relevance floor, plus a post-generation grounding audit.

KNOWN_GAPS.md sets the contract: "the pipeline never fabricates coverage it does
not have... A query about Unit 8 or 9 content should retrieve nothing from
ap_skills and the generator should say so." The old retrieve() always returned
the nearest top_k regardless of distance, so that path was unreachable.

A distance floor alone does NOT satisfy that contract, and it's worth being
precise about why. Measured against the live 164-chunk collection:

    in-domain queries .................... 0.24 - 0.61
    in-domain, jargon-heavy .............. 0.71 - 0.73
        ("Week 3 SPACE CAT analysis of Letter from Birmingham Jail")
    KNOWN-GAP queries .................... 0.52 - 0.68
        ("Unit 8 skills on style", "ACT Reading CLR 501")
    off-domain ........................... 0.82 - 0.91
        (chemistry, algebra, gibberish)

So a floor at 0.78 cleanly rejects off-domain but the known-gap queries land
*inside* it — asking for Unit 8 returns real, in-domain, wrong-for-the-question
standards at 0.52. No single threshold separates "nothing exists" from
"something adjacent exists". Hence three layers:

  1. this module's distance floor      -> kills off-domain
  2. KNOWN_GAPS in the prompt          -> kills the Unit 8 / CLR case
  3. audit_grounding() after the fact  -> catches whatever slipped through

Layer 3 is the only one that's actually verifiable rather than trusted.
"""
from __future__ import annotations

import functools
import json
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.retrieval")

COLLECTION_NAME = "ap_lang_standards"
EMBED_MODEL = "all-MiniLM-L6-v2"

# Families that appear in our sources.
GROUNDED_FAMILIES = ("TOD", "ORG", "KLA", "SST", "USG", "PUN")
# Families cited by the curriculum reference but present in NO source document
# we hold — see KNOWN_GAPS.md "ACT Reading-specific codes not included".
UNGROUNDABLE_FAMILIES = ("CLR", "IKI")

_CODE_RE = re.compile(
    r"\b("
    r"\d\.[A-C]"  # AP Lang skill, e.g. 2.A
    r"|Grade\d{1,2}-\d{1,2}[a-c]?"  # ALCOS, e.g. Grade11-22a
    r"|R\d{1,2}"  # ACT recurring, e.g. R4
    r"|(?:TOD|ORG|KLA|SST|USG|PUN|CLR|IKI)\s?\d{3}"  # ACT English/Writing + ungroundable
    r")\b"
)


def _norm_code(code: str) -> str:
    return re.sub(r"\s+", " ", code).strip().upper()


# ---------------------------------------------------------------------------
# Scope guard
#
# The corpus is Grade 11 ALCOS + AP Lang Units 1-7 + ACT English/Writing. A
# query naming a different grade is NOT catchable by distance: "Grade 9 ELA
# standards" scores 0.411 against this corpus — nearer than most genuinely
# in-domain queries — precisely because it IS ELA standards, just the wrong
# grade's. KNOWN_GAPS.md spells out why that's the dangerous case rather than a
# harmless one: "each grade re-uses standard numbers 1-30, so grade must always
# be part of a chunk's identity, never the bare number." So Grade 9 standard 14
# would silently answer with Grade 11's standard 14.
#
# Deterministic guard, not a threshold.
# ---------------------------------------------------------------------------

CORPUS_GRADE = 11

_GRADE_RE = re.compile(
    r"\bgrade\s*(\d{1,2})\b|\b(\d{1,2})\s*(?:st|nd|rd|th)\s+grade\b", re.IGNORECASE
)


def out_of_scope_grades(query: str) -> list[int]:
    """Grades named in the query that this corpus cannot answer for."""
    found = set()
    for a, b in _GRADE_RE.findall(query):
        raw = a or b
        if raw and raw.isdigit():
            found.add(int(raw))
    return sorted(g for g in found if g != CORPUS_GRADE)


def scope_error(query: str, grades: list[int]) -> AppError:
    listed = ", ".join(str(g) for g in grades)
    return AppError(
        "out_of_scope_grade",
        f"This corpus only covers Grade {CORPUS_GRADE}; the request names Grade {listed}.",
        status=422,
        hint=(
            f"Only Grade {CORPUS_GRADE} ALCOS standards were parsed (alcos_ela.pdf pp. 133-138). "
            f"Because every grade re-uses standard numbers 1-30, answering from Grade "
            f"{CORPUS_GRADE} would look right and be wrong. Drop the grade from the "
            f"request, or add that grade to source_docs and re-run scripts/01-02."
        ),
        extra={"named_grades": grades, "corpus_grade": CORPUS_GRADE},
    )


# ---------------------------------------------------------------------------
# Chroma access
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def get_collection():
    import chromadb
    from chromadb.utils import embedding_functions

    db_path = Path(settings.chroma_path)
    if not db_path.exists():
        raise AppError(
            "vector_store_missing",
            "The standards vector store has not been built.",
            hint=f"Run: python scripts/02_embed_store.py (expected at {db_path})",
        )
    client = chromadb.PersistentClient(path=str(db_path))
    emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
    return client.get_collection(name=COLLECTION_NAME, embedding_function=emb_fn)


@functools.lru_cache(maxsize=1)
def load_chunks() -> list[dict]:
    """The full chunk records, straight from chunks.json.

    Richer than Chroma's metadata (which flattens lists to ' | '-joined strings
    and drops Nones), 190KB, and needs no embedding model — which is what makes
    the Standards browser instant.
    """
    path = Path(settings.chunks_path)
    if not path.is_file():
        raise AppError(
            "chunks_missing",
            "chunks.json was not found.",
            hint="Run: python scripts/01_parse_chunks.py",
        )
    with open(path, encoding="utf-8") as f:
        return json.load(f)


@functools.lru_cache(maxsize=1)
def chunks_by_code() -> dict[str, dict]:
    return {_norm_code(c["code"]): c for c in load_chunks()}


# ---------------------------------------------------------------------------
# Grounded retrieval
# ---------------------------------------------------------------------------


@dataclass
class RetrievalResult:
    chunks: list[dict] = field(default_factory=list)
    rejected: list[dict] = field(default_factory=list)
    floor: float = 0.0

    @property
    def empty(self) -> bool:
        return not self.chunks

    @property
    def thin(self) -> bool:
        return 0 < len(self.chunks) < settings.retrieval_thin_threshold

    @property
    def codes(self) -> set[str]:
        return {_norm_code(c["id"]) for c in self.chunks}

    def closest_rejected(self) -> dict | None:
        return self.rejected[0] if self.rejected else None


def retrieve_raw(query: str, n: int, where: dict | None = None) -> list[dict]:
    res = get_collection().query(
        query_texts=[query],
        n_results=n,
        where=where,
        include=["documents", "metadatas", "distances"],
    )
    out = []
    for i in range(len(res["ids"][0])):
        out.append(
            {
                "id": res["ids"][0][i],
                "document": res["documents"][0][i],
                "metadata": res["metadatas"][0][i],
                "distance": float(res["distances"][0][i]),
            }
        )
    return out


# A lesson plan needs a course standard, an ACT alignment, and an AP skill — the
# district template has a row for each. A single top-k ranking routinely returned
# five ALCOS chunks and no AP skills at all, and the model then filled the AP row
# from memory (one run invented "2.C", a code 01_parse_chunks.py notes does not
# exist). Retrieving per source type means the codes it needs are actually on the
# table, which prevents the fabrication rather than just flagging it afterwards.
STRATA = ("ap_skills", "state_course_of_study", "act_standards", "act_recurring")


def retrieve_grounded(
    query: str,
    top_k: int | None = None,
    max_distance: float | None = None,
    extra_queries: list[str] | None = None,
) -> RetrievalResult:
    top_k = top_k or settings.retrieval_top_k
    floor = settings.retrieval_max_distance if max_distance is None else max_distance

    # Search the teacher's own words plus any skill-register rephrasings (see
    # llm.expand_query). Each chunk keeps its BEST distance across all queries, so
    # a rephrasing can rescue a standard the raw wording missed without loosening
    # the floor for anything else.
    searches = [query, *(extra_queries or [])]
    best: dict[str, dict] = {}

    def consider(hits: list[dict]) -> None:
        for c in hits:
            prev = best.get(c["id"])
            if prev is None or c["distance"] < prev["distance"]:
                best[c["id"]] = c

    for q in searches:
        # Over-fetch then filter, so near-misses don't cost us real hits.
        consider(retrieve_raw(q, n=max(top_k * 3, top_k)))
        # Then per stratum, so each source type gets a fair look — the district
        # template has a row for a course standard, an ACT code, and an AP skill.
        for source_type in STRATA:
            try:
                consider(retrieve_raw(q, n=top_k, where={"source_type": source_type}))
            except Exception as e:  # noqa: BLE001 — a filter failing must not break retrieval
                log.warning("stratified retrieval failed for %s: %s", source_type, e)

    raw = sorted(best.values(), key=lambda c: c["distance"])

    survivors = [c for c in raw if c["distance"] <= floor]
    # Keep the best top_k overall, plus the best survivor from each stratum, so a
    # relevant AP skill isn't crowded out by five close ALCOS matches.
    keep = survivors[:top_k]
    kept_ids = {c["id"] for c in keep}
    for source_type in STRATA:
        best = next(
            (c for c in survivors if (c.get("metadata") or {}).get("source_type") == source_type),
            None,
        )
        if best and best["id"] not in kept_ids:
            keep.append(best)
            kept_ids.add(best["id"])
    keep.sort(key=lambda c: c["distance"])

    drop = [{"id": c["id"], "distance": c["distance"]} for c in raw if c["distance"] > floor][:3]

    log.info(
        "retrieval query_len=%d kept=%d floor=%.2f best=%.3f",
        len(query),
        len(keep),
        floor,
        raw[0]["distance"] if raw else -1,
    )
    return RetrievalResult(chunks=keep, rejected=drop, floor=floor)


def format_context(result: RetrievalResult) -> str:
    parts = []
    for i, c in enumerate(result.chunks, 1):
        meta = c.get("metadata") or {}
        meta_str = " | ".join(f"{k}: {v}" for k, v in meta.items() if v not in (None, ""))
        parts.append(
            f"Standard {i} [{c['id']}] (distance {c['distance']:.3f}):\n"
            f"Text: {c['document']}\nMetadata: {meta_str}\n"
        )
    return "\n".join(parts)


def no_grounded_standards_error(query: str, result: RetrievalResult) -> AppError:
    closest = result.closest_rejected()
    if closest:
        hint = (
            f"Closest match was {closest['id']} at distance {closest['distance']:.2f}, "
            f"above the {result.floor:.2f} relevance floor. Try naming the skill — "
            f'e.g. "rhetorical situation", "line of reasoning", "synthesis", "tone".'
        )
    else:
        hint = "The standards index returned nothing at all. Has scripts/02_embed_store.py been run?"
    return AppError(
        "no_grounded_standards",
        "No standard in the source documents is relevant enough to ground this request.",
        status=422,
        hint=hint,
        extra={"rejected": result.rejected, "floor": result.floor},
    )


# ---------------------------------------------------------------------------
# Layer 3 — post-generation grounding audit
# ---------------------------------------------------------------------------


def audit_grounding(plan: dict, allowed: set[str]) -> list[str]:
    """Flag every standard code the plan cites that retrieval didn't supply.

    Warnings, not errors: the canonical example-week.json itself cites CLR 501,
    and a teacher may legitimately reference something by hand. But an
    ungroundable family gets called out by name, because that's a fabrication
    the docs explicitly predict.
    """
    warnings: list[str] = []
    known = chunks_by_code()

    for day in plan.get("days", []):
        if day.get("no_school"):
            continue
        name = day.get("name", "?")
        cited: list[str] = []
        for fld in ("standards", "act_alignment"):
            cited += _CODE_RE.findall(str(day.get(fld, "")))

        for raw_code in dict.fromkeys(cited):  # de-dupe, keep order
            code = _norm_code(raw_code)
            family = code.split()[0] if " " in code else code
            if family in UNGROUNDABLE_FAMILIES:
                warnings.append(
                    f"{name} cites {raw_code}, which is not in any source document we hold. "
                    f"The {family} family is ACT Reading; our ACT source covers "
                    f"English/Writing only (see Known Gaps)."
                )
            elif code not in allowed and code not in known:
                warnings.append(
                    f"{name} cites {raw_code}, which does not appear in the standards corpus at all."
                )
            elif code not in allowed:
                warnings.append(
                    f"{name} cites {raw_code}, which exists in the corpus but was not "
                    f"among the standards retrieved for this request."
                )
    return warnings
