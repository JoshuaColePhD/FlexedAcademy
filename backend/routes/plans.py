"""The Plans library: every week ever generated, re-downloadable and rebuildable."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, BackgroundTasks, Depends, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import db, docx_build, schema, service, units
from ..config import settings
from ..deps import get_current_user
from ..entitlement import require_entitlement
from ..errors import AppError

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


@router.get("/{plan_id}")
def get_plan(plan_id: str, user_id: str = Depends(get_current_user)):
    return _require_plan(user_id, plan_id)


@router.patch("/{plan_id}")
def patch_plan(plan_id: str, body: PatchPlan, bg_tasks: BackgroundTasks, user_id: str = Depends(get_current_user)):
    """Edit a plan. Re-validates and rebuilds the .docx so the file never drifts."""
    row = _require_plan(user_id, plan_id)
    fields: dict = {}

    if body.plan_json is not None:
        plan, warnings = schema.validate_plan(body.plan_json)
        s = db.get_settings_row(user_id)
        plan = schema.with_identity(
            plan, teacher=s["teacher"], course=s["course"], period=s["period"]
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
    s = db.get_settings_row(user_id)
    plan = schema.with_identity(plan, teacher=s["teacher"], course=s["course"], period=s["period"])
    
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
        if p.is_file() and p.is_relative_to(Path(settings.plans_dir).resolve()):
            p.unlink()
    db.delete_plan(user_id, plan_id)
    return None


@router.post("/{plan_id}/feedback")
def post_plan_feedback(plan_id: str, body: PlanFeedback, user_id: str = Depends(get_current_user)):
    if not db.add_plan_feedback(user_id, plan_id, body.is_good, body.notes):
        raise AppError("plan_not_found", "No such plan.", status=404)
    return {"status": "ok"}


@router.get("/{plan_id}/download")
def download_plan(plan_id: str, user_id: str = Depends(get_current_user)):
    row = _require_plan(user_id, plan_id)
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
            hint="Please wait a moment and try downloading again.",
        )
    p = Path(path_str).resolve()
    if not p.is_relative_to(Path(settings.plans_dir).resolve()) or not p.is_file():
        raise AppError(
            "docx_missing",
            "The document for this plan is missing.",
            status=404,
            hint="Rebuild it from the stored plan — the content is safe in the database.",
        )
    return FileResponse(
        path=str(p),
        filename=f"{docx_build.safe_filename(row['week_label'])}.docx",
        media_type=DOCX_MIME,
    )
