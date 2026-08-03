"""Settings, chats, health, and file intake."""
from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from fastapi import APIRouter, File, UploadFile
from pydantic import BaseModel, Field

from .. import db, docx_build, llm, retrieval
from ..config import settings
from ..errors import AppError

log = logging.getLogger("aplang.misc")
router = APIRouter(prefix="/api", tags=["misc"])

TEXT_EXTS = {".txt", ".md", ".csv"}


# ---------------------------------------------------------------------------
# Health — makes every misconfiguration in the app diagnosable in one curl.
# ---------------------------------------------------------------------------


@router.get("/health")
def health():
    out: dict = {
        "ok": True,
        "model": settings.openai_model,
        "api_key_set": settings.has_api_key,
        "db_path": str(settings.app_db_path),
        "plans_dir": str(settings.plans_dir),
        "retrieval_floor": settings.retrieval_max_distance,
        "retrieval_top_k": settings.retrieval_top_k,
    }
    try:
        out["builder_found"] = True
        out["builder_template"] = docx_build.builder_template()
        out["builder_path"] = str(settings.builder_path)
    except AppError as e:
        out["ok"] = False
        out["builder_found"] = False
        out["builder_error"] = e.message
    try:
        out["chunks"] = len(retrieval.load_chunks())
    except AppError as e:
        out["ok"] = False
        out["chunks_error"] = e.message
    try:
        out["chroma_count"] = retrieval.get_collection().count()
    except Exception as e:  # noqa: BLE001 — health must never itself 500
        out["ok"] = False
        out["chroma_error"] = str(e)[:200]
    return out


# ---------------------------------------------------------------------------
# Settings — one AP Lang class. Singleton by DB constraint, no profile switcher.
# ---------------------------------------------------------------------------


class SettingsBody(BaseModel):
    teacher: str = Field(min_length=1, max_length=120)
    course: str = Field(min_length=1, max_length=160)
    period: str = Field(min_length=1, max_length=80)


@router.get("/settings")
def get_settings_route():
    return db.get_settings_row()


@router.put("/settings")
def put_settings(body: SettingsBody):
    return db.update_settings(body.teacher.strip(), body.course.strip(), body.period.strip())


# ---------------------------------------------------------------------------
# Chats
# ---------------------------------------------------------------------------


class ChatBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)


@router.get("/chats")
def list_chats():
    return db.list_chats()


@router.post("/chats")
def create_chat(body: ChatBody):
    return db.create_chat(body.title)


@router.get("/chats/{chat_id}")
def get_chat(chat_id: str):
    chat = db.get_chat(chat_id, with_messages=True)
    if not chat:
        raise AppError("chat_not_found", "No such chat.", status=404)
    return chat


@router.patch("/chats/{chat_id}")
def rename_chat(chat_id: str, body: ChatBody):
    chat = db.rename_chat(chat_id, body.title)
    if not chat:
        raise AppError("chat_not_found", "No such chat.", status=404)
    return chat


@router.delete("/chats/{chat_id}", status_code=204)
def delete_chat(chat_id: str):
    if not db.delete_chat(chat_id):
        raise AppError("chat_not_found", "No such chat.", status=404)
    return None


@router.post("/chats/import")
def import_chats(payload: list[dict]):
    """One-time migration of the old localStorage['lesson_chats'] array."""
    return db.import_chats(payload)


# ---------------------------------------------------------------------------
# File intake
# ---------------------------------------------------------------------------


def _spool(upload: UploadFile, suffix: str, max_bytes: int) -> Path:
    """Stream to a temp file, aborting past the cap.

    Enforced while reading rather than from content-length (spoofable) — and the
    old code did `await audio.read()`, buffering an unbounded upload in RAM. The
    filename is generated, never taken from upload.filename, which was
    previously interpolated straight into a path.
    """
    total = 0
    fd = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    try:
        while chunk := upload.file.read(1 << 20):
            total += len(chunk)
            if total > max_bytes:
                raise AppError(
                    "file_too_large",
                    f"That file is larger than the {max_bytes // (1024 * 1024)}MB limit.",
                    status=413,
                )
            fd.write(chunk)
        fd.flush()
        return Path(fd.name)
    except Exception:
        Path(fd.name).unlink(missing_ok=True)
        raise
    finally:
        fd.close()


@router.post("/transcribe")
async def transcribe(audio: UploadFile = File(...)):
    suffix = Path(audio.filename or "recording.webm").suffix or ".webm"
    path = _spool(audio, suffix, settings.max_audio_bytes)
    try:
        return {"text": llm.transcribe(str(path))}
    finally:
        path.unlink(missing_ok=True)


@router.post("/extract_text")
async def extract_text(file: UploadFile = File(...)):
    original = Path(file.filename or "upload")
    ext = original.suffix.lower()
    if ext != ".pdf" and ext not in TEXT_EXTS:
        raise AppError(
            "unsupported_file_type",
            f"Can't read {ext or 'that file type'}.",
            status=400,
            hint="Supported: .pdf, .txt, .md, .csv",
        )

    path = _spool(file, ext, settings.max_doc_bytes)
    try:
        if ext == ".pdf":
            try:
                out = subprocess.run(
                    ["pdftotext", "-layout", str(path), "-"],
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=False,
                )
            except FileNotFoundError as e:
                raise AppError(
                    "pdftotext_missing",
                    "The pdftotext tool isn't installed.",
                    hint="Install poppler: brew install poppler",
                ) from e
            except subprocess.TimeoutExpired as e:
                raise AppError("pdf_timeout", "That PDF took too long to read.", status=422) from e
            if out.returncode != 0:
                raise AppError(
                    "pdf_unreadable",
                    "Could not extract text from that PDF.",
                    status=422,
                    hint=(out.stderr or "").strip()[:200] or None,
                )
            text = out.stdout
        else:
            text = path.read_text(encoding="utf-8", errors="ignore")
        # Keep the ORIGINAL name for display; it never touched the filesystem.
        return {"filename": original.name, "text": text, "chars": len(text)}
    finally:
        path.unlink(missing_ok=True)


def purge_legacy_temp() -> None:
    """temp/ is no longer a store. Clear the intermediates it used to accumulate.

    Generated .docx files in there are left alone — they may be the only copy of
    a real week, and they predate the plans/ directory and the database.
    """
    temp_dir = Path(settings.plans_dir).parent / "temp"
    if not temp_dir.is_dir():
        return
    removed = 0
    for pattern in ("temp_*.json", "upload_*"):
        for p in temp_dir.glob(pattern):
            try:
                p.unlink()
                removed += 1
            except OSError as e:
                log.warning("could not remove %s: %s", p, e)
    leftovers = sorted(temp_dir.glob("LessonPlan_*.docx"))
    if removed:
        log.info("purged %d legacy temp intermediates", removed)
    if leftovers:
        log.info(
            "left %d pre-existing .docx in temp/ untouched (not in the plans library): %s",
            len(leftovers),
            ", ".join(p.name for p in leftovers),
        )
