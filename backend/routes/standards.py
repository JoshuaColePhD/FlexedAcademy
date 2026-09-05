"""The Standards browser — makes the corpus visible and its limits checkable.

This exists because retrieval has no way to prove a negative on its own (see
retrieval.py). Surfacing what the 164 chunks actually cover, and what
KNOWN_GAPS.md says they don't, turns a hidden hallucination risk into something
the teacher can look up.
"""
from __future__ import annotations

import re
from collections import Counter

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import BaseModel, Field
from pypdf import PdfReader

from .. import db, llm, retrieval
from ..config import settings
from ..deps import get_current_user
from ..errors import AppError
from ..prompts import known_gaps

router = APIRouter(prefix="/api/standards", tags=["standards"])

# Fields returned in list view — the full record is available per-code.
_LIST_FIELDS = (
    "code",
    "description",
    "source_type",
    "strand",
    "domain",
    "reporting_category",
    "source_document",
    "source_page_or_section",
    "frequency",
    "grade",
    "verbatim_ok",
    "parent_code",
    "parent_text",
)


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=1000)
    top_k: int = Field(default=10, ge=1, le=50)
    # retrieve_raw filters on chunk metadata course + grade, and both are
    # required positionals. This endpoint passed neither, so every call raised
    # TypeError — the floor-inspection tool was unreachable. Defaults are the
    # calibrated corpus: AP Lang, grade 11.
    subject: str = Field(default="AP_Lang", max_length=120)
    grade: int = Field(default=11, ge=0, le=12)
    state: str = Field(default="AL", max_length=2)


def _slim(chunk: dict) -> dict:
    return {k: chunk.get(k) for k in _LIST_FIELDS}


@router.get("")
def list_standards(
    source_type: str | None = Query(None, max_length=60),
    strand: str | None = Query(None, max_length=120),
    q: str | None = Query(None, max_length=200),
    subject: str | None = Query(None, max_length=120),
    grade: int | None = Query(None),
    state: str = Query("AL", max_length=2),
    limit: int = Query(200, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    # Without this, the Standards browser would list two states' "Mathematics
    # (2019)" interleaved with no way to tell them apart the moment a second
    # state's corpus exists — same reasoning as every other endpoint here.
    # Defaults to 'AL' for backward compatibility with classes predating
    # multi-state support.
    items = [c for c in retrieval.load_chunks() if c.get("state") == state.upper()]

    if subject:
        items = [c for c in items if c.get("course") == subject]
    if grade is not None:
        items = [c for c in items if c.get("grade") == grade]

    if source_type:
        items = [c for c in items if c.get("source_type") == source_type]
    if strand:
        items = [c for c in items if (c.get("strand") or "") == strand]
    if q:
        needle = q.lower()
        items = [
            c
            for c in items
            if needle in str(c.get("code", "")).lower()
            or needle in str(c.get("description", "")).lower()
            or needle in str(c.get("notes") or "").lower()
        ]

    total = len(items)
    page = items[offset : offset + limit]
    return {"items": [_slim(c) for c in page], "total": total}


@router.get("/global")
def get_global_standards(
    state: str,
    subject: str,
    grade: str,
    user_id: str = Depends(get_current_user)
):
    """Fetch global standards for a state, subject, and grade."""
    standards = db.get_global_standards(state.strip(), subject.strip(), grade.strip())
    return {"standards": standards}


@router.post("/global/upload")
def upload_global_standards(
    state: str = Form(...),
    subject: str = Form(...),
    grade: str = Form(...),
    file: UploadFile = File(...),
    user_id: str = Depends(get_current_user)
):
    """
    Upload a standards PDF, parse it using the LLM, and save it to the global database.

    Deliberately `def`, not `async def`. Nothing in here is awaitable — it
    reads file.file (the plain SpooledTemporaryFile), parses the PDF, and makes
    a synchronous LLM call that can run 30-120s on a large document. As
    `async def` all of that ran ON the event loop, and the app is deployed with
    `--workers 1` (Dockerfile), so one standards upload froze every other
    request in flight — including SSE streams mid-generation. A plain `def`
    endpoint gets run in FastAPI's threadpool instead, which is exactly what
    this wants.
    """
    if not file.filename.endswith(".pdf"):
        raise AppError("invalid_file", "Standards document must be a PDF.", status=400)

    try:
        pdf = PdfReader(file.file)
        text_pages = []
        for page in pdf.pages:
            text = page.extract_text()
            if text:
                text_pages.append(text)
        full_text = "\n".join(text_pages)
        if not full_text.strip():
            raise ValueError("No text could be extracted from this PDF.")
    except Exception:  # noqa: BLE001 — translated into an AppError for the route to return
        raise AppError("pdf_parse_error", "Failed to extract text from the provided PDF.", status=400)

    try:
        extracted_standards = llm.extract_standards_from_text(full_text)
    except AppError:
        raise
    except Exception:  # noqa: BLE001 — translated into an AppError for the route to return
        raise AppError("llm_extraction_error", "Failed to extract standards using AI.", status=500)

    if not extracted_standards:
        raise AppError("no_standards_found", "The AI could not find any standards in this document.", status=400)

    try:
        db.insert_global_standards(user_id, state.strip(), subject.strip(), grade.strip(), extracted_standards)
    except Exception:  # noqa: BLE001 — translated into an AppError for the route to return
        raise AppError("db_save_error", "Failed to save standards to the database.", status=500)

    return {"message": "Standards processed successfully", "count": len(extracted_standards), "standards": extracted_standards}


@router.get("/stats")
def stats(
    subject: str | None = Query(None, max_length=120),
    grade: int | None = Query(None)
):
    items = retrieval.load_chunks()
    
    if subject:
        items = [c for c in items if c.get("course") == subject]
    if grade is not None:
        items = [c for c in items if c.get("grade") == grade]
        
    return {
        "total": len(items),
        "by_source_type": dict(Counter(c.get("source_type") or "?" for c in items)),
        "by_source_document": dict(Counter(c.get("source_document") or "?" for c in items)),
        "by_strand": dict(Counter(c.get("strand") or "—" for c in items)),
        "verbatim_ok": sum(1 for c in items if c.get("verbatim_ok")),
        "retrieval_floor": settings.retrieval_max_distance,
    }


@router.get("/gaps")
def gaps():
    """KNOWN_GAPS.md, parsed into sections. The markdown stays the source of truth."""
    md = known_gaps()
    sections = []
    for block in re.split(r"^## ", md, flags=re.MULTILINE)[1:]:
        lines = block.strip().split("\n", 1)
        sections.append(
            {"title": lines[0].strip(), "body_md": (lines[1] if len(lines) > 1 else "").strip()}
        )
    return {
        "sections": sections,
        "intro_md": re.split(r"^## ", md, flags=re.MULTILINE)[0].lstrip("# ").strip(),
        "ungroundable_families": list(retrieval.UNGROUNDABLE_FAMILIES),
    }


@router.get("/active-states")
def active_states():
    """Postal codes whose standards are actually live for grounding — drives
    frontend/src/lib/states.js's isStandardsReady instead of a hardcoded set
    that can drift from the real ingest manifest."""
    return {"states": db.active_standards_states()}


@router.post("/search")
def search(req: SearchRequest):
    """Semantic search that SHOWS what the floor rejected, rather than hiding it.

    The point is that the relevance floor is inspectable — a teacher can see
    "your query's nearest standard was 0.83, above the 0.78 cutoff" instead of
    being handed five confident-looking irrelevant results.
    """
    raw = retrieval.retrieve_raw(req.query, n=req.top_k, course=req.subject, grade=req.grade, state=req.state)
    raw.sort(key=lambda c: c["distance"])
    floor = settings.retrieval_max_distance
    return {
        "floor": floor,
        "results": [
            {
                "code": c["id"],
                "description": (c.get("metadata") or {}).get("description") or c["document"],
                "distance": round(c["distance"], 4),
                "below_floor": c["distance"] <= floor,
            }
            for c in raw
        ],
    }


@router.get("/batch")
def get_standards_batch(codes: str = Query(..., max_length=4000), subject: str | None = Query(None), state: str = Query("AL", max_length=2)):
    """The same lookup as GET /{code}, for every code a plan cites at once.

    The Standards rail panel used to call GET /{code} once per cited code —
    a plan citing a dozen standards fired a dozen separate requests, all
    competing for the same connection pool and (on a cold process) the same
    first, slow chunks.json parse. One request here does the same lookups
    server-side, where they're free once the *chunks.json files are loaded.

    A comma-separated query param, not a JSON body, so this stays a GET —
    cacheable and bookmarkable like every other read here, and simple enough
    that a querystring doesn't need the ceremony of a request model.
    """
    requested = [c.strip() for c in codes.split(",") if c.strip()]
    return {code: retrieval.chunk_for_code(code, subject_code=subject, state=state) for code in requested}

@router.get("/coverage")
def get_coverage(class_id: str = Query(...), user_id: str = Depends(get_current_user)):
    """Returns a mapping of standard code to citation count for the caller's class.

    `class_id` is a browser-visible identifier, not an authorization proof. The
    ownership check has to happen before the class-scoped query so a teacher
    cannot use the coverage endpoint as a cross-account oracle.
    """
    if not db.get_class(user_id, class_id):
        raise AppError("class_not_found", "That class doesn't exist.", status=404)
    return db.get_standards_coverage(class_id)


@router.get("/{code:path}/lessons")
def get_standard_lessons(
    code: str, class_id: str = Query(...), user_id: str = Depends(get_current_user)
):
    """Returns past lessons where this standard was cited in the caller's class."""
    if not db.get_class(user_id, class_id):
        raise AppError("class_not_found", "That class doesn't exist.", status=404)
    return db.get_standard_lessons(class_id, code)


@router.get("/{code:path}/deconstruct")
def deconstruct_standard(code: str, subject: str | None = Query(None), state: str = Query("AL", max_length=2), user_id: str = Depends(get_current_user)):
    """Uses LLM to simplify a dense standard into an 'I can' statement."""
    chunk = retrieval.chunk_for_code(code, subject_code=subject, state=state)
    if not chunk:
        raise AppError("standard_not_found", f"No standard with code {code!r}.", status=404)
        
    description = (chunk.get("metadata") or {}).get("description") or chunk.get("document", "")
    simplified = llm.deconstruct_standard(user_id, code, description)
    return {"simplified": simplified}


@router.get("/{code:path}")
def get_standard(code: str, subject: str | None = Query(None), state: str = Query("AL", max_length=2)):
    """A code alone is not a safe key across the whole corpus — see
    chunk_for_code()'s own docstring. `subject` is optional only because the
    Standards browser has no one course in mind; every plan-facing caller
    (a chat citation, the rail's Standards panel) has a course and MUST send
    it, or a cross-course collision renders as this plan's own standard.
    `state` defaults to 'AL' for the same backward-compatibility reason
    every other standards endpoint does."""
    chunk = retrieval.chunk_for_code(code, subject_code=subject, state=state)
    if not chunk:
        raise AppError("standard_not_found", f"No standard with code {code!r}.", status=404)
    return chunk
