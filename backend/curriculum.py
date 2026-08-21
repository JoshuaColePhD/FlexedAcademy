"""Curriculum map / pacing guide: persistent upload, chunk+embed, and a
structured week-by-week schedule parsed out for progress tracking.

Kept in its own table (`curriculum_chunks`), separate from the `chunks` standards
corpus. Mixing the two would feed pacing-guide prose into retrieve_grounded()'s
stratified standards search and its audit_grounding() code-citation checks,
neither of which is meaningful for a document containing no standard codes of its
own.

This used to be a Chroma collection embedded with all-MiniLM-L6-v2, and it never
worked: settings.chroma_path was read but never declared, so every upload raised
AttributeError behind a bare `except` and reported chunks_embedded: 0. It is now
pgvector in the same 384-dim space as the standards corpus, which also means one
embedding model serves both and chromadb is no longer a dependency.
"""
from __future__ import annotations

import functools
import json
import logging
import re
import uuid

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

CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150


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
    """(Re-)embeds one map's chunks into pgvector. Returns the chunk count.

    `subject` is no longer stored on the chunk: retrieval is by map_id alone, and
    a subject column here only ever invited the cross-teacher leak the old
    where-clause allowed.
    """
    from . import db
    from .embeddings import embed_texts

    chunks = chunk_text(text)
    if not chunks:
        return 0
    vectors = embed_texts(chunks)
    return db.replace_curriculum_chunks(map_id, user_id, list(zip(chunks, vectors)))


def delete_map_embeddings(map_id: str) -> None:
    from . import db

    try:
        db.delete_curriculum_chunks(map_id)
    except Exception as e:  # noqa: BLE001 — deleting a derived index must never block the row delete
        log.warning("could not delete curriculum chunks for map %s: %s", map_id, e)


def retrieve_map_context(
    map_id: str,
    query: str,
    top_k: int = 4,
    query_vector: list[float] | None = None,
) -> str:
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
    from . import db
    from .embeddings import embed_query

    try:
        vector = query_vector if query_vector is not None else embed_query(query)
        docs = db.search_curriculum_chunks(map_id, vector, top_k)
    except Exception as e:  # noqa: BLE001
        log.warning("curriculum map retrieval failed: %s", e)
        return ""
    return "\n\n".join(docs)


def unit_for_calendar_week(user_id: str, subject: str, week: dict) -> dict | None:
    """Cross-references a resolved SCHOOL CALENDAR week (a schoolcal.school_weeks()
    row — needs its `week`/`start`/`end`) against the teacher's own uploaded
    pacing guide's parsed schedule, so a chat about to build that week can be
    told which unit THEIR OWN document says it covers.

    Deliberately separate from units.unit_for_week(): that one is a hardcoded
    9-unit map for AP Lang only, and just echoes back "Week N" for every other
    subject — fine for labeling a plan that already exists, useless for
    telling a model what's coming up in a subject with no hardcoded map. This
    works for whatever the teacher actually uploaded, for any subject.

    Tries two matches, in that order, because parse_curriculum_progress emits
    either shape depending on how the source document reads:
      1. By week NUMBER — parsing each row's free-text week_label with
         units.week_number(), the same parse db.curriculum_status() already
         trusts to match a plan to a progress row.
      2. By DATE OVERLAP against target_start/target_end, for a document
         organized by unit rather than by week, whose week_label is the
         unit's own name with no number in it for (1) to find at all.

    None if there's no active map, no parsed progress, or nothing in it names
    this week with a non-empty unit — never a guess at what the unit might be.
    """
    from . import db, units

    rows = db.list_curriculum_progress(user_id, subject)

    def _unit(row: dict) -> dict | None:
        unit = (row.get("unit") or "").strip()
        return {"unit": unit, "week_label": row.get("week_label") or ""} if unit else None

    for row in rows:
        if units.week_number(row.get("week_label") or "") == week["week"]:
            hit = _unit(row)
            if hit:
                return hit

    for row in rows:
        start, end = row.get("target_start"), row.get("target_end")
        if start and end and start <= week["end"] and end >= week["start"]:
            hit = _unit(row)
            if hit:
                return hit

    return None


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
