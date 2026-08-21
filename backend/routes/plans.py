"""The Plans library: every week ever generated, re-downloadable and rebuildable."""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, EmailStr, Field

from .. import db, docx_build, google_drive, llm, qti_build, schema, service, storage, units
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError
from .drive import get_valid_access_token

log = logging.getLogger("aplang.routes.plans")

router = APIRouter(prefix="/api/plans", tags=["plans"])

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

# Plan ids are uuid4().hex. Validating the shape means user input never reaches
# a filesystem path at all — the old endpoint interpolated it straight into
# temp/LessonPlan_{file_id}.docx, so ../ segments resolved.
_ID_RE = re.compile(r"^[0-9a-f]{32}$")


class PatchPlan(BaseModel):
    plan_json: dict | None = None
    week_label: str | None = Field(default=None, max_length=200)
    unit: str | None = Field(default=None, max_length=200)


class PlanFeedback(BaseModel):
    is_good: bool
    notes: str | None = None


class QuizRequest(BaseModel):
    question_types: list[str] = Field(min_length=1, max_length=len(schema.QUESTION_TYPES))
    num_questions: int = Field(default=10, ge=1, le=40)


class DayUpdateRequest(BaseModel):
    field: str
    content: str

@router.put("/{plan_id}/days/{day_index}")
def update_day(
    plan_id: str, day_index: int, body: DayUpdateRequest, user_id: str = Depends(get_current_user)
):
    plan = db.get_plan(user_id, plan_id)
    if not plan:
        raise AppError("plan_not_found", "Plan not found", status=404)
    if day_index < 0 or day_index >= len(plan["days"]):
        raise AppError("bad_index", "Invalid day index", status=400)
        
    plan["days"][day_index][body.field] = body.content
    
    # Needs to write back to db
    db.update_plan(user_id, plan_id, days=plan["days"])
    return plan

class QuizUpdateRequest(BaseModel):
    quiz_json: dict


class QuizReviseBody(BaseModel):
    # The teacher's own message that triggered this — see ChatPage.jsx's own
    # comment on why the chat flow passes it straight through rather than
    # trying to summarize or structure it first.
    feedback: str = Field(min_length=1, max_length=4000)


class SharePlan(BaseModel):
    email: EmailStr | None = None
    # "reader" by default — a co-teacher gets to actually see the week
    # before they get to change it, and role is exactly the choice Drive's
    # own share dialog would offer.
    role: Literal["reader", "writer"] = "reader"


def _require_id(plan_id: str) -> None:
    if not _ID_RE.match(plan_id):
        raise AppError("bad_id", "That is not a valid plan id.", status=400)


def _require_plan(user_id: str, plan_id: str) -> dict:
    _require_id(plan_id)
    row = db.get_plan(user_id, plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)
    return row


@router.get("")
def list_plans(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, max_length=200),
    # Which plan did THIS conversation produce?
    #
    # The UI answers that by scanning the chat's messages for one carrying a
    # plan_id — and for every chat created before the assistant message was
    # persisted, there is no such message. The plan itself is fine and has
    # carried chat_id all along; it was only unreachable. This is the lookup
    # that recovers those.
    chat_id: str | None = Query(None, max_length=64),
    # The sidebar's "My plans" is scoped to whichever class is open, same as
    # every other list on that screen (chats, the calendar) — db.list_plans
    # has supported this filter since class_id landed on the plans table, it
    # was just never wired to a query param.
    class_id: str | None = Query(None, max_length=64),
    user_id: str = Depends(get_current_user),
):
    return db.list_plans(user_id, limit=limit, offset=offset, q=q, chat_id=chat_id, class_id=class_id)


# Registered ahead of GET /{plan_id} below — that path param would otherwise
# swallow "weeks" as a (invalid) plan id, since FastAPI matches in
# registration order and "weeks" matches {plan_id} just fine syntactically.
@router.get("/weeks")
def list_plan_weeks(class_id: str = Query(..., max_length=64), user_id: str = Depends(get_current_user)):
    """The Library, grouped: one card per calendar week instead of one row per
    raw generation. See db.list_plan_weeks for why (regenerating a week used
    to just add another row, so the same week appeared over and over)."""
    return db.list_plan_weeks(user_id, class_id)


@router.get("/{plan_id}")
def get_plan(plan_id: str, user_id: str = Depends(get_current_user)):
    return _require_plan(user_id, plan_id)


@router.get("/public/{plan_id}")
def get_public_plan(plan_id: str):
    _require_id(plan_id)
    plan = db.get_public_plan(plan_id)
    if not plan:
        # Same 404 for "no such plan" and "that plan is not shared", on purpose:
        # distinguishing them would turn this endpoint into an oracle for which
        # plan ids exist.
        raise AppError(
            "plan_not_found",
            "This plan isn’t shared, or the link has been turned off.",
            status=404,
        )
    # Don't return the docx path or other sensitive info, just the plan structure
    return {
        "id": plan["id"],
        "plan_json": plan["plan_json"],
        "course": plan["course"],
        "week_label": plan["week_label"],
        "unit": plan["unit"],
    }


class PublicLinkBody(BaseModel):
    public: bool = True


@router.post("/{plan_id}/public_link")
def set_plan_public_link(plan_id: str, body: PublicLinkBody, user_id: str = Depends(get_current_user)) -> dict:
    """Turn the read-only /shared/{plan_id} link on or off for one of my plans.

    The link itself already existed — several places copy
    `${origin}/shared/${planId}` to the clipboard — but nothing ever recorded
    that a teacher had chosen to share, so GET /public/{plan_id} served every
    plan in the database whether or not anyone had asked it to. This is the
    missing consent step, and the off switch: flipping `public` back to false
    kills every copy of the link that is already out there.
    """
    _require_id(plan_id)
    # Ownership first — _require_plan is scoped to user_id and 404s otherwise,
    # so this cannot be used to publish somebody else's plan by guessing an id.
    _require_plan(user_id, plan_id)
    row = db.set_plan_public(user_id, plan_id, body.public)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)
    return {"id": row["id"], "is_public": bool(row["is_public"]), "shared_at": row["shared_at"]}


class ForkPlanBody(BaseModel):
    class_id: str | None = None


@router.post("/{plan_id}/fork")
def fork_plan(plan_id: str, body: ForkPlanBody, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Duplicates a plan to the user's account."""
    import uuid
    _require_id(plan_id)
    
    # Only a plan whose owner published it (migration 39). get_public_plan now
    # filters on is_public, so this stopped being "any signed-in account can
    # copy any plan whose id it knows" the moment that filter landed.
    plan = db.get_public_plan(plan_id)
    if not plan:
        raise AppError(
            "plan_not_found",
            "This plan isn’t shared, or the link has been turned off.",
            status=404,
        )

    new_id = uuid.uuid4().hex
    # Create the plan for the new user.
    # Note: It won't have a chat_id initially, so they can't chat to edit it, 
    # but they can click cells to tweak it, or we could create a new chat for it.
    # Let's just copy the plan row.
    new_plan = db.create_plan(
        plan_id=new_id,
        user_id=user_id,
        course=plan["course"],
        week_label=plan["week_label"],
        unit=plan["unit"],
        query="Forked plan",
        plan_json=plan["plan_json"],
        docx_path=None,
        retrieved_ids=[],
        warnings=[],
        chat_id=None,
        template=plan.get("template", "default"),
        class_id=body.class_id,
        week_number=None,
    )
    
    # Trigger docx build for the new plan
    cls = db.get_class(user_id, body.class_id) if body.class_id else None
    identity = service.identity_for(user_id, cls)
    plan_data = schema.with_identity(
        plan["plan_json"], teacher=identity["teacher"], course=identity["course"], period=identity["period"]
    )
    out_path = docx_build.plan_output_path(plan_data, new_id)
    bg_tasks.add_task(service._build_docx_bg, user_id, plan_data, out_path, new_id)

    return new_plan


@router.patch("/{plan_id}")
def patch_plan(plan_id: str, body: PatchPlan, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Edit a plan. Re-validates and rebuilds the .docx so the file never drifts."""
    row = _require_plan(user_id, plan_id)
    fields: dict = {}

    if body.plan_json is not None:
        plan, warnings = schema.validate_plan(body.plan_json)
        # The plan's OWN class, not get_settings_row(user_id)'s account-wide
        # "most recently touched" row — same cross-class leak service.finalize
        # had (see service.identity_for).
        cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
        identity = service.identity_for(user_id, cls)
        plan = schema.with_identity(
            plan, teacher=identity["teacher"], course=identity["course"], period=identity["period"]
        )
        out_path = docx_build.plan_output_path(plan, plan_id)
        bg_tasks.add_task(service._build_docx_bg, user_id, plan, out_path, plan_id)

        fields.update(
            plan_json=plan,
            docx_path=None,
            week_label=plan["week_of"],
            unit=units.unit_for_week(plan["week_of"]),
            warnings=warnings,
            course=plan["course"],
        )

    if body.week_label is not None:
        fields["week_label"] = body.week_label
        fields.setdefault("unit", units.unit_for_week(body.week_label))
    if body.unit is not None:
        fields["unit"] = body.unit

    if not fields:
        return row
    return db.update_plan(user_id, plan_id, **fields)


@router.post("/{plan_id}/rebuild")
def rebuild_plan(plan_id: str, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    _require_id(plan_id)
    return service.rebuild(user_id, plan_id, bg_tasks=bg_tasks)


class ReviseBody(BaseModel):
    # Optional: with no feedback this stays the autonomous self-critique it was.
    # With feedback it is the chat's iteration loop — "make Thursday a Socratic
    # seminar" — which previously had nowhere to go but a per-day revise.
    feedback: str | None = Field(default=None, max_length=4000)


@router.post("/{plan_id}/revise")
def revise_whole_plan(
    plan_id: str,
    bg_tasks: BackgroundTasks,
    body: ReviseBody | None = None,
    user_id: str = Depends(get_current_user),
):
    """Revise the whole plan, on the teacher's instruction or by self-critique."""
    from .. import llm, retrieval

    require_entitlement(user_id)
    row = _require_plan(user_id, plan_id)
    retrieved_ids = row.get("retrieved_ids") or []
    if not retrieved_ids:
        raise AppError("no_context", "Cannot revise without retrieved standards.", status=400)
    
    # plans.retrieved_ids holds standard CODES — service.finalize writes
    # `sorted(result.codes)`, which reads metadata["code"]. This used to filter
    # load_chunks() on c["id"], and chunk ids are "{course}:{grade}:{code}", so
    # nothing ever matched: every revise ran with an empty context and the model
    # re-invented the standards it was supposed to be held to.
    by_code = retrieval.chunks_by_code()
    wanted = {retrieval._norm_code(c) for c in retrieved_ids}
    chunks = [by_code[c] for c in wanted if c in by_code]
    if not chunks:
        raise AppError(
            "no_context",
            "None of this plan's standards could be found in the corpus.",
            status=409,
            hint=(
                "The plan cites codes the current corpus doesn't contain — it was "
                "probably built against a different framework or before a re-ingest. "
                "Rebuild the plan rather than revising it."
            ),
            extra={"codes": sorted(wanted)},
        )

    # chunks.json records carry `code` and `description`; they have no `id` and
    # no `text` — those are the pgvector row's shape, not the source file's.
    res = retrieval.RetrievalResult(
        chunks=[
            {
                "id": c.get("code"),
                "document": c.get("description", ""),
                "metadata": c,
                "distance": 0.0,
            }
            for c in chunks
        ]
    )
    context = retrieval.format_context(res)
    
    # Generate critique and revised plan
    new_plan_json = llm.critique_and_revise(
        user_id, row["plan_json"], context, feedback=(body.feedback if body else None)
    )
    
    # Validate and save
    plan, warnings = schema.validate_plan(new_plan_json)
    cls = db.get_class(user_id, row["class_id"]) if row.get("class_id") else None
    identity = service.identity_for(user_id, cls)
    plan = schema.with_identity(
        plan, teacher=identity["teacher"], course=identity["course"], period=identity["period"]
    )
    
    out_path = docx_build.plan_output_path(plan, plan_id)
    bg_tasks.add_task(service._build_docx_bg, user_id, plan, out_path, plan_id)
    
    db.update_plan(
        user_id, 
        plan_id, 
        plan_json=plan,
        docx_path=None,
        week_label=plan.get("week_of", row["week_label"]),
        unit=units.unit_for_week(plan.get("week_of", row["week_label"])),
        warnings=warnings,
        course=plan.get("course", row["course"]),
    )
    
    return db.get_plan(user_id, plan_id)


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: str, user_id: str = Depends(get_current_user)):
    row = _require_plan(user_id, plan_id)
    path_str = row.get("docx_path")
    if path_str:
        p = Path(path_str).resolve()
        # Only ever unlink inside PLANS_DIR, whatever the DB happens to hold.
        if p.is_relative_to(Path(settings.plans_dir).resolve()):
            storage.remove_file(p)
    db.delete_plan(user_id, plan_id)


@router.post("/{plan_id}/feedback")
def post_plan_feedback(plan_id: str, body: PlanFeedback, user_id: str = Depends(get_current_user)):
    if not db.add_plan_feedback(user_id, plan_id, body.is_good, body.notes):
        raise AppError("plan_not_found", "No such plan.", status=404)
    return {"status": "ok"}


def _require_docx_path(row: dict) -> Path:
    """The same three checks download_plan and the share endpoint below both
    need before touching the file on disk: has a build even finished, did it
    fail outright, and is the path it left behind still real. Shared so the
    two only disagree if someone edits one and forgets the other."""
    path_str = row.get("docx_path")
    if not path_str:
        # "No docx yet" has two very different causes and they used to be
        # reported identically — so a build that had already failed told the
        # teacher to wait, indefinitely.
        if service.DOCX_FAILED in (row.get("warnings") or []):
            raise AppError(
                "docx_failed",
                "The document couldn't be built from this plan.",
                status=409,
                hint="Rebuild it — the plan itself is safe in the database.",
            )
        raise AppError(
            "docx_pending",
            "This plan's document is still generating in the background.",
            status=409,
            hint="Please wait a moment and try again.",
        )
    p = Path(path_str).resolve()
    if not p.is_relative_to(Path(settings.plans_dir).resolve()) or not storage.ensure_local(p):
        raise AppError(
            "docx_missing",
            "The document for this plan is missing.",
            status=404,
            hint="Rebuild it from the stored plan — the content is safe in the database.",
        )
    return p


@router.get("/{plan_id}/download")
def download_plan(plan_id: str, user_id: str = Depends(get_current_user)):
    row = _require_plan(user_id, plan_id)
    p = _require_docx_path(row)
    return FileResponse(
        path=str(p),
        filename=f"{docx_build.safe_filename(row['week_label'])}.docx",
        media_type=DOCX_MIME,
    )


@router.post("/{plan_id}/share")
def share_plan(plan_id: str, body: SharePlan, user_id: str = Depends(get_current_user)) -> dict:
    """Shares this plan's .docx as a Google Doc with `body.email`, creating
    that Doc the first time (see docstring on google_drive.upload_as_google_doc
    for why it's a real Doc and not a Drive-hosted copy of the .docx bytes).

    Every share after the first reuses the same Doc — drive_file_id is set
    once and never overwritten — rather than minting a fresh copy on every
    click, which would leave a trail of near-duplicate Docs for one plan.
    """
    if not settings.drive_share_enabled:
        raise AppError(
            "drive_unconfigured",
            "Google Drive sharing isn't set up yet.",
            status=503,
        )
    row = _require_plan(user_id, plan_id)
    access_token = get_valid_access_token(user_id)

    if not row.get("drive_file_id"):
        p = _require_docx_path(row)
        result = google_drive.upload_as_google_doc(
            access_token,
            filename=docx_build.safe_filename(row["week_label"]),
            content=p.read_bytes(),
            source_mime=DOCX_MIME,
        )
        db.set_plan_drive_file(user_id, plan_id, file_id=result["id"], web_link=result["webViewLink"])
        row = _require_plan(user_id, plan_id)

    if body.email:
        google_drive.share_file(access_token, row["drive_file_id"], email=body.email, role=body.role)
        db.add_plan_share(plan_id, email=body.email, role=body.role)
    return {"web_link": row["drive_web_link"], "shares": db.list_plan_shares(plan_id)}


@router.get("/{plan_id}/shares")
def get_plan_shares(plan_id: str, user_id: str = Depends(get_current_user)) -> dict:
    row = _require_plan(user_id, plan_id)
    return {"web_link": row.get("drive_web_link"), "shares": db.list_plan_shares(plan_id)}


@router.get("/{plan_id}/quizzes")
def list_quizzes(plan_id: str, user_id: str = Depends(get_current_user)) -> list[dict]:
    _require_plan(user_id, plan_id)
    return db.list_quizzes_for_plan(user_id, plan_id)


@router.post("/{plan_id}/quiz", status_code=201)
def create_quiz(
    plan_id: str, body: QuizRequest, user_id: str = Depends(get_current_user)
) -> dict:
    """Write, validate, and save a quiz over an ALREADY-BUILT plan.

    Gated the same as building the plan itself (require_entitlement) — this
    is a real model call and spends real tokens, same reasoning as
    revise_day's own gate.

    Synchronous, unlike the plan's own docx build (which backgrounds):
    generate_quiz is one non-streamed completion and build_qti_zip is a
    local zip write with no external I/O, so there is nothing here slow
    enough to justify the polling BuiltPlanCard's own has_docx dance exists
    for.
    """
    row = _require_plan(user_id, plan_id)
    require_entitlement(user_id)

    unknown = set(body.question_types) - set(schema.QUESTION_TYPES)
    if unknown:
        raise AppError(
            "unknown_question_type",
            f"Unknown question type(s): {', '.join(sorted(unknown))}.",
            status=400,
            hint=f"Valid types: {', '.join(schema.QUESTION_TYPES)}.",
        )

    quiz_raw = llm.generate_quiz(user_id, row["plan_json"], body.question_types, body.num_questions)
    try:
        warnings = schema.validate_quiz(quiz_raw)
    except schema.QuizSchemaError as e:
        raise AppError(
            "quiz_schema_error",
            f"The generated quiz wasn't usable: {e}",
            status=502,
            hint="Try asking for the quiz again — this is a one-sample formatting slip, not a structural problem.",
        ) from e

    quiz_id = db.new_id()
    out_path = qti_build.quiz_output_path(row["plan_json"], quiz_id)
    try:
        qti_build.build_qti_zip(quiz_raw, out_path)
        storage.mirror_file(out_path)
        qti_path = str(out_path)
    except Exception as e:  # noqa: BLE001 - the quiz row is worth saving even if the zip failed
        warnings = [*warnings, f"QTI file could not be built: {e}"]
        qti_path = None

    return db.create_quiz(
        quiz_id=quiz_id,
        user_id=user_id,
        plan_id=plan_id,
        title=quiz_raw.get("title") or f"{row['week_label']} Quiz",
        question_types=body.question_types,
        quiz_json=quiz_raw,
        qti_path=qti_path,
        warnings=warnings,
    )


@router.post("/{plan_id}/quizzes/{quiz_id}/revise")
def revise_quiz_route(
    plan_id: str, quiz_id: str, body: QuizReviseBody, user_id: str = Depends(get_current_user)
) -> dict:
    """Revise an already-built quiz in place, on the teacher's own chat
    follow-up — the chat-driven counterpart to create_quiz above, the same
    way revise_whole_plan is the counterpart to building a plan fresh.

    Gated the same as create_quiz — a real model call, same reasoning.
    """
    row = _require_plan(user_id, plan_id)
    require_entitlement(user_id)
    quiz_row = db.get_quiz(user_id, quiz_id)
    if not quiz_row:
        raise AppError("quiz_not_found", "No such quiz.", status=404)

    quiz_raw = llm.revise_quiz(user_id, row["plan_json"], quiz_row["quiz_json"], body.feedback)
    try:
        warnings = schema.validate_quiz(quiz_raw)
    except schema.QuizSchemaError as e:
        raise AppError(
            "quiz_schema_error",
            f"The revised quiz wasn't usable: {e}",
            status=502,
            hint="Try asking for the revision again — this is a one-sample formatting slip, not a structural problem.",
        ) from e

    out_path = qti_build.quiz_output_path(row["plan_json"], quiz_id)
    try:
        qti_build.build_qti_zip(quiz_raw, out_path)
        storage.mirror_file(out_path)
        qti_path = str(out_path)
    except Exception as e:  # noqa: BLE001 - the quiz row is worth saving even if the zip failed
        warnings = [*warnings, f"QTI file could not be built: {e}"]
        qti_path = None

    return db.update_quiz(
        user_id=user_id,
        quiz_id=quiz_id,
        quiz_json=quiz_raw,
        qti_path=qti_path,
        warnings=warnings,
    )


@router.put("/{plan_id}/quizzes/{quiz_id}")
def update_quiz(
    plan_id: str, quiz_id: str, body: QuizUpdateRequest, user_id: str = Depends(get_current_user)
) -> dict:
    row = _require_plan(user_id, plan_id)
    quiz_row = db.get_quiz(user_id, quiz_id)
    if not quiz_row:
        raise AppError("quiz_not_found", "No such quiz.", status=404)

    out_path = qti_build.quiz_output_path(row["plan_json"], quiz_id)
    try:
        qti_build.build_qti_zip(body.quiz_json, out_path)
        storage.mirror_file(out_path)
        qti_path = str(out_path)
    except Exception:
        log.warning("could not build QTI zip for quiz_id=%s", quiz_id, exc_info=True)
        qti_path = None

    return db.update_quiz(
        user_id=user_id,
        quiz_id=quiz_id,
        quiz_json=body.quiz_json,
        qti_path=qti_path,
    )

@router.delete("/{plan_id}/quizzes/{quiz_id}", status_code=204)
def delete_quiz(plan_id: str, quiz_id: str, user_id: str = Depends(get_current_user)) -> None:
    _require_plan(user_id, plan_id)
    row = db.get_quiz(user_id, quiz_id)
    if row and row.get("qti_path"):
        p = Path(row["qti_path"]).resolve()
        if p.is_relative_to(Path(settings.plans_dir).resolve()):
            storage.remove_file(p)
    if not db.delete_quiz(user_id, quiz_id):
        raise AppError("quiz_not_found", "No such quiz.", status=404)


@router.get("/{plan_id}/quizzes/{quiz_id}/download")
def download_quiz(plan_id: str, quiz_id: str, user_id: str = Depends(get_current_user)):
    _require_plan(user_id, plan_id)
    row = db.get_quiz(user_id, quiz_id)
    if not row:
        raise AppError("quiz_not_found", "No such quiz.", status=404)
    path_str = row.get("qti_path")
    if not path_str:
        raise AppError(
            "qti_missing",
            "This quiz's QTI file could not be built.",
            status=409,
            hint="See its warnings, or ask for the quiz again — the quiz content is safe in the database.",
        )
    p = Path(path_str).resolve()
    if not p.is_relative_to(Path(settings.plans_dir).resolve()) or not storage.ensure_local(p):
        raise AppError(
            "qti_missing",
            "The QTI file for this quiz is missing.",
            status=404,
            hint="Ask for the quiz again — the content is safe in the database.",
        )
    return FileResponse(
        path=str(p),
        filename=f"{docx_build.safe_filename(row['title'])}.zip",
        media_type=qti_build.QTI_MIME,
    )
