"""The Plans library: every week ever generated, re-downloadable and rebuildable."""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import db, docx_build, schema, service, units
from ..config import settings
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


def _require_id(plan_id: str) -> None:
    if not _ID_RE.match(plan_id):
        raise AppError("bad_id", "That is not a valid plan id.", status=400)


def _require_plan(plan_id: str) -> dict:
    _require_id(plan_id)
    row = db.get_plan(plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)
    return row


@router.get("")
def list_plans(
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    q: str | None = Query(None, max_length=200),
):
    return db.list_plans(limit=limit, offset=offset, q=q)


@router.get("/{plan_id}")
def get_plan(plan_id: str):
    return _require_plan(plan_id)


@router.patch("/{plan_id}")
def patch_plan(plan_id: str, body: PatchPlan):
    """Edit a plan. Re-validates and rebuilds the .docx so the file never drifts."""
    row = _require_plan(plan_id)
    fields: dict = {}

    if body.plan_json is not None:
        plan, warnings = schema.validate_plan(body.plan_json)
        s = db.get_settings_row()
        plan = schema.with_identity(
            plan, teacher=s["teacher"], course=s["course"], period=s["period"]
        )
        out_path = docx_build.plan_output_path(plan, plan_id)
        docx_build.build_docx(plan, out_path)
        fields.update(
            plan_json=plan,
            docx_path=str(out_path),
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
    return db.update_plan(plan_id, **fields)


@router.post("/{plan_id}/rebuild")
def rebuild_plan(plan_id: str):
    _require_id(plan_id)
    return service.rebuild(plan_id)


@router.delete("/{plan_id}", status_code=204)
def delete_plan(plan_id: str):
    row = _require_plan(plan_id)
    path_str = row.get("docx_path")
    if path_str:
        p = Path(path_str).resolve()
        # Only ever unlink inside PLANS_DIR, whatever the DB happens to hold.
        if p.is_file() and p.is_relative_to(Path(settings.plans_dir).resolve()):
            p.unlink()
    db.delete_plan(plan_id)
    return None


@router.get("/{plan_id}/download")
def download_plan(plan_id: str):
    row = _require_plan(plan_id)
    path_str = row.get("docx_path")
    if not path_str:
        raise AppError(
            "docx_missing",
            "This plan has no document on disk.",
            status=404,
            hint="Rebuild it from the stored plan.",
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
