"""Persistent curriculum map / pacing guide: upload, replace, delete, and the
structured progress schedule parsed out of it.

The original file lives outside the repo (settings.curriculum_maps_dir, next to
app.db) — see config.py for why. Only the DB row and the derived Chroma chunks
live in the Drive-synced tree, and both are rebuildable from the original.
"""
from __future__ import annotations

import logging
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, UploadFile

from .. import curriculum, db
from ..config import settings
from ..deps import get_current_user
from ..errors import AppError
from .misc import _spool, read_text_from_path

log = logging.getLogger("aplang.curriculum_routes")
router = APIRouter(prefix="/api", tags=["curriculum"])

SUPPORTED_EXTS = {".pdf", ".docx", ".txt", ".md", ".csv"}


def _map_out(row: dict) -> dict:
    return {
        "id": row["id"],
        "subject": row["subject"],
        "original_name": row["original_name"],
        "chars": row["chars"],
        "uploaded_at": row["uploaded_at"],
    }


@router.get("/curriculum_map")
def get_curriculum_map(subject: str, user_id: str = Depends(get_current_user)):
    row = db.get_active_curriculum_map(user_id, subject)
    return _map_out(row) if row else None


@router.post("/curriculum_map")
async def upload_curriculum_map(
    subject: str = Form(...),
    file: UploadFile = File(...),
    # Both optional and both additive, so the pre-existing subject-scoped call
    # keeps working. With a class_id the row is written against the CLASS, which
    # is what GET /classes/{id}/documents reads — without it, every upload from
    # My Classes landed with class_id NULL, the list could never match it, and
    # the teacher got a success toast for a document that had vanished.
    class_id: str | None = Form(default=None),
    kind: str = Form(default="pacing_guide"),
    user_id: str = Depends(get_current_user),
):
    if class_id and not db.get_class(user_id, class_id):
        raise AppError("not_found", "That class doesn't exist.", status=404)
    if kind not in db.DOCUMENT_KINDS:
        raise AppError(
            "bad_document_kind",
            f"{kind!r} is not a document type.",
            status=400,
            hint=f"Expected one of: {', '.join(db.DOCUMENT_KINDS)}.",
        )

    original = Path(file.filename or "curriculum_map")
    ext = original.suffix.lower()
    if ext not in SUPPORTED_EXTS:
        raise AppError(
            "unsupported_file_type",
            f"Can't read {ext or 'that file type'}.",
            status=400,
            hint=f"Supported: {', '.join(sorted(SUPPORTED_EXTS))}",
        )

    spooled = _spool(file, ext, settings.max_doc_bytes)
    try:
        text = read_text_from_path(spooled, ext)
        if not text.strip():
            raise AppError(
                "empty_document",
                "No text could be read from that file.",
                status=422,
            )

        map_id = curriculum.new_map_id()
        store_dir = Path(settings.curriculum_maps_dir)
        store_dir.mkdir(parents=True, exist_ok=True)
        stored_path = store_dir / f"{map_id}{ext}"
        # The ORIGINAL bytes, not the extracted text, so a later download or
        # re-embed reflects exactly what the teacher uploaded.
        stored_path.write_bytes(spooled.read_bytes())
    finally:
        spooled.unlink(missing_ok=True)

    # Scoped to the class when we have one. create_class_document deactivates
    # only the previous document of the SAME kind for the SAME class, where
    # create_curriculum_map deactivates every map for the subject — so under the
    # old path uploading a syllabus silently retired the pacing guide, and two
    # sections of one course clobbered each other.
    if class_id:
        row = db.create_class_document(
            map_id=map_id,
            user_id=user_id,
            class_id=class_id,
            subject=subject,
            kind=kind,
            original_name=original.name,
            stored_path=str(stored_path),
            chars=len(text),
        )
    else:
        row = db.create_curriculum_map(
            map_id=map_id,
            user_id=user_id,
            subject=subject,
            original_name=original.name,
            stored_path=str(stored_path),
            chars=len(text),
        )

    try:
        chunk_count = curriculum.embed_map(map_id, user_id, subject, text)
    except Exception as e:  # noqa: BLE001 — the DB row is the record of truth; embedding can be retried
        log.warning("embedding failed for map %s: %s", map_id, e)
        chunk_count = 0

    try:
        weeks = curriculum.parse_curriculum_progress(text, subject)
        db.replace_curriculum_progress(user_id, map_id, subject, weeks)
    except Exception as e:  # noqa: BLE001 — same: upload succeeds even if the LLM parse fails
        log.warning("progress parse failed for map %s: %s", map_id, e)
        weeks = []

    out = _map_out(row)
    out["chunks_embedded"] = chunk_count
    out["weeks_parsed"] = len(weeks)
    return out


@router.delete("/curriculum_map/{map_id}", status_code=204)
def delete_curriculum_map(map_id: str, user_id: str = Depends(get_current_user)):
    row = db.delete_curriculum_map(user_id, map_id)
    if not row:
        raise AppError("map_not_found", "No such curriculum map.", status=404)
    curriculum.delete_map_embeddings(map_id)
    Path(row["stored_path"]).unlink(missing_ok=True)
    return None


@router.get("/curriculum_progress")
def get_curriculum_progress(subject: str, user_id: str = Depends(get_current_user)):
    return db.curriculum_status(user_id, subject)
