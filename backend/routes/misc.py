"""Settings, chats, health, and file intake."""
from __future__ import annotations

import logging
import subprocess
import tempfile
from pathlib import Path

from collections import Counter

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from .. import db, docx_build, llm, retrieval, service
from ..config import settings
from ..deps import get_current_user, get_current_user_optional
from ..errors import AppError

log = logging.getLogger("aplang.misc")
router = APIRouter(prefix="/api", tags=["misc"])

TEXT_EXTS = {".txt", ".md", ".csv"}


# ---------------------------------------------------------------------------
# Health — makes every misconfiguration in the app diagnosable in one curl.
#
# TWO payloads, because it was serving one and it was the detailed one, to
# ANYONE. There is no auth dependency on this route, so a stranger could read
# the model, the on-disk paths of the plans directory and the builder, the
# retrieval thresholds, the corpus size and the length of DATABASE_URL. None of
# that is a credential, but none of it is a stranger's business either, and
# filesystem paths are the first thing anyone probing a host wants.
#
# Liveness has to stay public — Render's health check and any uptime monitor
# call it with no cookie, and a 401 there reads as "the service is down". So
# the public answer is reduced to exactly that: is it up.
# ---------------------------------------------------------------------------


@router.get("/health")
def health(user_id: str | None = Depends(get_current_user_optional)):
    # Unauthenticated: liveness only. Enough for a monitor, useless to a prober.
    if not user_id:
        return {"ok": True}

    out: dict = {
        "ok": True,
        "model": settings.openai_model,
        "api_key_set": settings.has_api_key,
        "database": "PostgreSQL",
        "plans_dir": str(settings.plans_dir),
        "retrieval_floor": settings.retrieval_max_distance,
        "retrieval_top_k": settings.retrieval_top_k,
        # The two settings whose value cannot be inferred from the app's
        # behaviour without either being logged in or trying to break in.
        #
        # require_login=False means every unauthenticated request resolves to
        # 'default_user' — i.e. anyone who loads the site is signed in as the
        # first teacher. That shipped to production once already, and the only
        # way we caught it was noticing /api/chats answered 200 to a stranger.
        # Reporting it turns "is auth on?" from an inference into a fact.
        #
        # Neither is a secret: one is a boolean, the other says whether the
        # session cookie is marked Secure. Knowing them helps a defender far
        # more than an attacker, who can determine both by trying anyway.
        "require_login": settings.require_login,
        # Derived per-request now (see routes/auth.py). Reported as the
        # OVERRIDE flag only — "false" here means "auto", not "insecure".
        "cookie_secure_forced": settings.cookie_secure,
        # Length only, never the value. Every deploy failure so far has been a
        # malformed DATABASE_URL, and each one cost a round trip through the
        # logs to identify. 110 is correct; 160 means the host is in there twice.
        "database_url_len": len(settings.database_url or ""),
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
        out["chunks"] = db._row("SELECT COUNT(*) AS n FROM chunks")["n"]
    except Exception as e:
        out["ok"] = False
        out["pg_error"] = str(e)
    return out


# ---------------------------------------------------------------------------
# Settings — one AP Lang class. Singleton by DB constraint, no profile switcher.
# ---------------------------------------------------------------------------

# Display names for the course codes the ingest scripts write. These ids are what
# the Subject Framework dropdown saves into settings.subject, and what retrieval
# filters on — so this map and scripts/01d_ingest_alcos_case.py FRAMEWORKS have to
# agree. The year is part of the label because Alabama has several live editions
# and a plan citing "Social Studies" is ambiguous without it.
SUBJECT_LABELS = {
    "AP_Lang": "AP Language & Composition",
    "ELA": "English Language Arts (2021)",
    "Math": "Mathematics (2019)",
    "Math_AWF": "Mathematics: Algebra with Finance (2015)",
    "Science": "Science (2023)",
    "Social_Studies": "Social Studies (2024)",
    "Arts": "Arts Education (2024)",
    "DLCS": "Digital Literacy & Computer Science (2025)",
    "Health": "Health Education (2019)",
    "PE": "Physical Education (2019)",
    "World_Languages": "World Languages (2017)",
    "Counseling": "Comprehensive School Counseling (2024-2026)",
}

# AP Lang first: it is the course this app exists for and the default settings row.
_FRAMEWORK_PRIORITY = ("AP_Lang", "ELA")


@router.get("/frameworks")
def get_frameworks():
    """What the Subject Framework and Grade Level dropdowns are built from.

    Derived from the chunks, so a framework is offered only while it is actually
    ingested — the UI can't present a subject retrieval would fail to ground.
    """
    grades: dict[str, set[int]] = {}
    counts: Counter = Counter()
    verbatim: Counter = Counter()

    for c in retrieval.load_chunks():
        course = c.get("course")
        if not course:
            continue
        counts[course] += 1
        if c.get("verbatim_ok"):
            verbatim[course] += 1
        if course.startswith("AP"):
            grades.setdefault(course, set()).update([9, 10, 11, 12])
        else:
            grade = c.get("grade")
            # `if course and grade` was the old test, which dropped every
            # Kindergarten chunk: grade 0 is falsy. It also admitted 99, a
            # "grade unknown" sentinel from an earlier ingest that no teacher can
            # select and that matches nothing when used as a filter.
            if isinstance(grade, int) and 0 <= grade <= 12:
                grades.setdefault(course, set()).add(grade)

    result = [
        {
            "id": course,
            "label": SUBJECT_LABELS.get(course, course.replace("_", " ")),
            "grades": sorted(grades.get(course, set())),
            "chunks": counts[course],
            "verbatim_ok": verbatim[course],
        }
        for course in counts
    ]
    result.sort(key=lambda f: (
        _FRAMEWORK_PRIORITY.index(f["id"]) if f["id"] in _FRAMEWORK_PRIORITY
        else len(_FRAMEWORK_PRIORITY),
        f["label"],
    ))
    return result

class SettingsBody(BaseModel):
    teacher: str = Field(min_length=1, max_length=120)
    course: str = Field(min_length=1, max_length=160)
    period: str = Field(min_length=1, max_length=80)
    subject: str = Field(default="AP Language & Composition", max_length=120)
    grade: str = Field(default="11", max_length=20)


@router.get("/settings")
def get_settings_route(subject: str = None, user_id: str = Depends(get_current_user)):
    """The settings row, with `subject` resolved to a live course code.

    Normalised on the way out rather than migrated in place, so a row written
    before the frameworks were renamed still drives the UI correctly: the Grade
    Level dropdown is built by looking `subject` up in /api/frameworks, and an
    id that no longer exists there left it stuck on a single hardcoded option.
    The next save persists the resolved value.
    """
    row = dict(db.get_settings_row(user_id, subject))
    row["subject"] = service.subject_code(row.get("subject", ""))
    return row


@router.put("/settings")
def put_settings(body: SettingsBody, user_id: str = Depends(get_current_user)):
    return db.update_settings(
        user_id,
        body.teacher.strip(),
        body.course.strip(),
        body.period.strip(),
        body.subject.strip(),
        body.grade.strip()
    )


# ---------------------------------------------------------------------------
# Chats
# ---------------------------------------------------------------------------


class ChatBody(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    # Optional so an older client still creates a working (unscoped) chat.
    class_id: str | None = Field(default=None, max_length=64)


class TitleRequest(BaseModel):
    message: str = Field(min_length=1, max_length=4000)


@router.post("/chats/title")
def suggest_chat_title(body: TitleRequest, user_id: str = Depends(get_current_user)):
    """A short descriptive title generated from a chat's first message.

    Called after the chat is already created with a truncated placeholder
    title, so a slow or failed title suggestion never blocks sending the
    first message. Requires login like every other route here, even though
    it doesn't touch the requester's data — an anonymous caller shouldn't be
    able to spend the shared OpenAI budget.
    """
    return {"title": llm.generate_chat_title(user_id, body.message)}


@router.get("/chats")
def list_chats(class_id: str | None = None, user_id: str = Depends(get_current_user)):
    """Scoped to one prep when class_id is given. Omitting it returns
    everything, which is what /api/chats meant before and what any caller
    without a class in hand still wants."""
    return db.list_chats(user_id, class_id=class_id)


@router.post("/chats")
def create_chat(body: ChatBody, user_id: str = Depends(get_current_user)):
    return db.create_chat(user_id, body.title, class_id=body.class_id)


@router.get("/chats/{chat_id}")
def get_chat(chat_id: str, user_id: str = Depends(get_current_user)):
    chat = db.get_chat(user_id, chat_id, with_messages=True)
    if not chat:
        raise AppError("chat_not_found", "No such chat.", status=404)
    return chat


@router.patch("/chats/{chat_id}")
def rename_chat(chat_id: str, body: ChatBody, user_id: str = Depends(get_current_user)):
    chat = db.rename_chat(user_id, chat_id, body.title)
    if not chat:
        raise AppError("chat_not_found", "No such chat.", status=404)
    return chat


@router.delete("/chats/{chat_id}", status_code=204)
def delete_chat(chat_id: str, user_id: str = Depends(get_current_user)):
    if not db.delete_chat(user_id, chat_id):
        raise AppError("chat_not_found", "No such chat.", status=404)
    return None


@router.post("/chats/import")
def import_chats(payload: list[dict], user_id: str = Depends(get_current_user)):
    """One-time migration of the old localStorage['lesson_chats'] array."""
    return db.import_chats(user_id, payload)


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
async def transcribe(audio: UploadFile = File(...), user_id: str = Depends(get_current_user)):
    """Was unauthenticated — every other OpenAI-backed route here requires
    login (see /tts's own comment), but this one didn't, which made it a free
    relay for anyone who found it: no account to attribute the cost to, and
    nothing for entitlement.py's cap to apply against."""
    suffix = Path(audio.filename or "recording.webm").suffix or ".webm"
    path = _spool(audio, suffix, settings.max_audio_bytes)
    try:
        return {"text": llm.transcribe(user_id, str(path))}
    finally:
        path.unlink(missing_ok=True)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=settings.max_tts_chars)


@router.post("/tts")
def synthesize_speech(req: TTSRequest, user_id: str = Depends(get_current_user)):
    """The assistant's chat replies, spoken aloud. Authenticated like every
    other OpenAI-backed route — this bills the same API key transcribe()
    already does, and a public speech-synthesis endpoint is a free relay for
    anyone who finds it."""
    audio = llm.synthesize_speech(user_id, req.text)
    return Response(content=audio, media_type="audio/mpeg")


def read_text_from_path(path: Path, ext: str) -> str:
    """Shared by /extract_text and curriculum-map ingestion, so PDF/docx handling
    lives in exactly one place."""
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
        return out.stdout
    if ext == ".docx":
        import docx as _docx

        d = _docx.Document(str(path))
        parts = [p.text for p in d.paragraphs if p.text.strip()]
        for table in d.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    parts.append(" | ".join(cells))
        return "\n".join(parts)
    return path.read_text(encoding="utf-8", errors="ignore")


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
        text = read_text_from_path(path, ext)
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
