"""Curriculum map / pacing guide: persistent upload, chunk+embed, and a
structured week-by-week schedule parsed out for progress tracking.

Kept in its own Chroma collection ("curriculum_maps"), separate from
COLLECTION_NAME in retrieval.py. Mixing the two would have fed pacing-guide
prose into retrieve_grounded()'s stratified standards search and its
audit_grounding() code-citation checks, neither of which are meaningful for a
document that contains no standard codes of its own.
"""
from __future__ import annotations

import functools
import json
import logging
import re
import uuid
from pathlib import Path

from .config import settings
from .errors import AppError

log = logging.getLogger("aplang.curriculum")

# Not imported from llm.py: llm.py imports this module (to pull curriculum-map
# context into the plan prompt), so importing back would cycle. The OpenAI
# call here is small enough that a second copy of client()/_response_format is
# cheaper than untangling the module graph for it.


@functools.lru_cache(maxsize=1)
def _client():
    from openai import OpenAI

    if not settings.has_api_key:
        raise AppError(
            "no_api_key",
            "OPENAI_API_KEY is not set.",
            hint="Add it to the .env file at the project root (see .env.example).",
        )
    return OpenAI(api_key=settings.openai_api_key)

CURRICULUM_COLLECTION = "curriculum_maps"
EMBED_MODEL = "all-MiniLM-L6-v2"

CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150


@functools.lru_cache(maxsize=1)
def get_curriculum_collection():
    import chromadb
    from chromadb.utils import embedding_functions

    db_path = Path(settings.chroma_path)
    db_path.mkdir(parents=True, exist_ok=True)
    chroma_client = chromadb.PersistentClient(path=str(db_path))
    emb_fn = embedding_functions.SentenceTransformerEmbeddingFunction(model_name=EMBED_MODEL)
    return chroma_client.get_or_create_collection(name=CURRICULUM_COLLECTION, embedding_function=emb_fn)


def chunk_text(text: str, size: int = CHUNK_CHARS, overlap: int = CHUNK_OVERLAP) -> list[str]:
    """Fixed-size chunks on paragraph boundaries where possible.

    The pacing guide has no standard-code structure to chunk around (unlike
    01_parse_chunks.py's per-standard chunking), so this just keeps chunks
    small enough to embed meaningfully and overlaps them so a week's row that
    spans a chunk boundary isn't cut in half everywhere it's read.
    """
    paras = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paras:
        if buf and len(buf) + len(p) + 1 > size:
            chunks.append(buf)
            buf = buf[-overlap:] + "\n" + p if overlap else p
        else:
            buf = f"{buf}\n{p}" if buf else p
    if buf:
        chunks.append(buf)
    return chunks or ([text] if text.strip() else [])


def embed_map(map_id: str, user_id: str, subject: str, text: str) -> int:
    """(Re-)embeds one map's chunks. Returns the chunk count."""
    chunks = chunk_text(text)
    if not chunks:
        return 0
    collection = get_curriculum_collection()
    collection.add(
        ids=[f"{map_id}:{i}" for i in range(len(chunks))],
        documents=chunks,
        metadatas=[{"map_id": map_id, "user_id": user_id, "subject": subject} for _ in chunks],
    )
    return len(chunks)


def delete_map_embeddings(map_id: str) -> None:
    try:
        get_curriculum_collection().delete(where={"map_id": map_id})
    except Exception as e:  # noqa: BLE001 — deletion of a derived index must never block the DB delete
        log.warning("could not delete chroma chunks for map %s: %s", map_id, e)


def retrieve_map_context(map_id: str, query: str, top_k: int = 4) -> str:
    """Best-effort snippets from ONE specific curriculum map, for the plan prompt.

    Takes a map_id, not a subject: filtering by subject alone mixed in every
    teacher's map for that subject name (two "AP Language & Composition"
    teachers would read each other's pacing guide) AND every earlier,
    superseded upload for the same subject, since replacing an upload
    deactivates the old DB row but never deletes its embeddings. The caller
    resolves the caller's own active map_id first (db.get_active_curriculum_map)
    so this only ever touches that one document.

    Returns "" (never raises) if no map_id is given or nothing is embedded for
    it — the curriculum map is a supplement to grounded standards retrieval,
    not a dependency it can fail on.
    """
    if not map_id:
        return ""
    try:
        res = get_curriculum_collection().query(
            query_texts=[query],
            n_results=top_k,
            where={"map_id": map_id},
            include=["documents"],
        )
    except Exception as e:  # noqa: BLE001
        log.warning("curriculum map retrieval failed: %s", e)
        return ""
    docs = (res.get("documents") or [[]])[0]
    return "\n\n".join(docs)


# ---------------------------------------------------------------------------
# Structured week-by-week parse, for the progress table.
# ---------------------------------------------------------------------------

CURRICULUM_PARSE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "weeks": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "properties": {
                    "week_label": {
                        "type": "string",
                        "description": "e.g. 'Week 3' or 'Week 3 — Sept 8-12'. Verbatim from the source where possible.",
                    },
                    "unit": {"type": "string", "description": "Unit/module name this week belongs to, or ''."},
                    "target_start": {
                        "type": "string",
                        "description": (
                            "This week's start date as ISO 8601 YYYY-MM-DD, ONLY if a specific "
                            "calendar date can be determined (inferring the year from other dated "
                            "rows or a header if the row itself omits it). '' if no real date is "
                            "determinable — never a guess, a month alone, or a date range string."
                        ),
                    },
                    "target_end": {
                        "type": "string",
                        "description": "This week's end date, same YYYY-MM-DD rule as target_start. '' if not determinable.",
                    },
                    "standards": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Standard codes or topic labels named for this week in the source. Empty array if none given.",
                    },
                    "notes": {"type": "string", "description": "Anything else worth keeping — texts, assessments, milestones. '' if nothing."},
                },
                "required": ["week_label", "unit", "target_start", "target_end", "standards", "notes"],
            },
        }
    },
    "required": ["weeks"],
}

_PARSE_PROMPT = """You are extracting a structured week-by-week (or unit-by-unit) schedule
from a teacher's curriculum map or pacing guide.

Read the document below and produce one entry per week or pacing row it defines,
in the order they appear. Do not invent weeks that aren't in the source. Do not
guess at dates or standards that aren't written down — leave those fields empty
rather than filling them from general knowledge of the subject.

If the document is organized by unit rather than by week, still emit one entry
per week if week numbers/dates are given; otherwise emit one entry per unit and
leave week_label as the unit's own label.

Dates: only write target_start/target_end as YYYY-MM-DD when a real calendar
date is determinable (the row's own date, or one inferred from a header/other
row's year). Leave them '' otherwise — an empty date is honest; a guessed one
is not."""


def parse_curriculum_progress(text: str, subject: str) -> list[dict]:
    """LLM structured-output parse of the map's schedule.

    Truncated to a generous but bounded window — a full-year pacing guide is a
    few thousand words, well inside context, but this must not silently accept
    an arbitrarily large upload.
    """
    resp = _client().chat.completions.create(
        model=settings.openai_model,
        temperature=0,
        max_tokens=4000,
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "curriculum_schedule", "strict": True, "schema": CURRICULUM_PARSE_SCHEMA},
        },
        messages=[
            {"role": "system", "content": _PARSE_PROMPT},
            {"role": "user", "content": f"Subject: {subject}\n\n{text[:40000]}"},
        ],
    )
    msg = resp.choices[0].message
    refusal = getattr(msg, "refusal", None)
    if refusal:
        raise AppError("model_refusal", f"The model declined this request: {refusal}", status=422)
    data = json.loads(msg.content or "{}")
    return data.get("weeks", [])


def new_map_id() -> str:
    return uuid.uuid4().hex
