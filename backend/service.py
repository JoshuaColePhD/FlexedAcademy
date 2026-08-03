"""The generate -> validate -> stamp -> build -> persist pipeline.

Kept out of the route handlers so the same path is used by the streaming
endpoint, the non-streaming endpoint, the rewrite/rebuild endpoints, and the
eval harness — which is how they stay consistent.
"""
from __future__ import annotations

import logging
import time

from . import db, docx_build, llm, retrieval, schema, units
from .errors import AppError
from .retrieval import RetrievalResult

log = logging.getLogger("aplang.service")


def prepare(query: str) -> RetrievalResult:
    """Retrieve, and refuse to spend a token if the request can't be grounded.

    Two independent refusals, because they fail differently:
      * a named grade outside the corpus — semantically NEAR, so distance can't
        catch it, and answering would be confidently wrong (see retrieval.py)
      * nothing above the relevance floor — genuinely off-domain
    """
    off_scope = retrieval.out_of_scope_grades(query)
    if off_scope:
        raise retrieval.scope_error(query, off_scope)

    result = retrieval.retrieve_grounded(query)
    if result.empty:
        raise retrieval.no_grounded_standards_error(query, result)
    return result


def finalize(
    *,
    plan_raw: dict,
    query: str,
    result: RetrievalResult,
    chat_id: str | None = None,
) -> dict:
    """Validate, stamp identity, build the .docx, persist. Returns the plan row."""
    started = time.monotonic()
    plan, warnings = schema.validate_plan(plan_raw)

    s = db.get_settings_row()
    plan = schema.with_identity(
        plan, teacher=s["teacher"], course=s["course"], period=s["period"]
    )

    warnings += retrieval.audit_grounding(plan, result.codes)

    plan_id = db.new_id()
    out_path = docx_build.plan_output_path(plan, plan_id)
    docx_build.build_docx(plan, out_path)

    row = db.create_plan(
        plan_id=plan_id,
        course=plan["course"],
        week_label=plan["week_of"],
        unit=units.unit_for_week(plan["week_of"]),
        query=query,
        plan_json=plan,
        docx_path=str(out_path),
        retrieved_ids=sorted(result.codes),
        warnings=warnings,
        chat_id=chat_id,
        template=docx_build.builder_template(),
    )
    log.info(
        "plan built id=%s week=%r warnings=%d elapsed_ms=%d",
        plan_id,
        plan["week_of"],
        len(warnings),
        int((time.monotonic() - started) * 1000),
    )
    return row


def generate(query: str, chat_id: str | None = None) -> dict:
    result = prepare(query)
    return finalize(
        plan_raw=llm.generate_plan(query, result), query=query, result=result, chat_id=chat_id
    )


def rebuild(plan_id: str) -> dict:
    """Re-emit the .docx from stored plan_json.

    Because the plan is in the database, a lost or deleted document is always
    recoverable — which is what makes the download endpoint's 404 actionable.
    """
    row = db.get_plan(plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)
    plan = row["plan_json"]
    if not plan:
        raise AppError("plan_json_missing", "This plan has no stored content to rebuild from.")
    out_path = docx_build.plan_output_path(plan, plan_id)
    docx_build.build_docx(plan, out_path)
    return db.update_plan(plan_id, docx_path=str(out_path))  # type: ignore[return-value]


def revise_day(plan_id: str, day_index: int, feedback: str) -> dict:
    """Rewrite one day, then REBUILD the document.

    The old flow updated React state only, so the already-built .docx went stale
    and the file the teacher downloaded no longer matched the plan on screen.
    """
    row = db.get_plan(plan_id)
    if not row:
        raise AppError("plan_not_found", "No such plan.", status=404)

    plan = row["plan_json"]
    days = plan.get("days", [])
    if not 0 <= day_index < len(days):
        raise AppError(
            "day_out_of_range",
            f"Day index {day_index} is outside this plan's {len(days)} days.",
            status=400,
        )

    original = days[day_index]
    # Re-retrieve against the feedback so a revision can cite a standard the
    # original week didn't need, while still being grounded.
    result = retrieval.retrieve_grounded(f"{feedback} {original.get('learning_targets', '')}")
    if result.empty:
        # A revision is allowed to proceed ungrounded — it inherits the week's
        # standards — but it must not invent new codes, and the audit will flag
        # it if it does.
        result = RetrievalResult(chunks=[], rejected=result.rejected, floor=result.floor)

    import json as _json

    updated_raw = llm.rewrite_day(original, feedback, _json.dumps(plan, indent=2), result)
    updated, warnings = schema.validate_day(updated_raw, path=f"days[{day_index}]")

    if updated["name"] != original.get("name"):
        # Don't let a revision silently move a day to a different weekday.
        updated["name"] = original["name"]
        warnings.append(
            f"The revision tried to rename the day; kept it as {original['name']}."
        )

    new_days = list(days)
    new_days[day_index] = updated
    new_plan = {**plan, "days": new_days}

    allowed = set(row.get("retrieved_ids") or []) | result.codes
    warnings += retrieval.audit_grounding(new_plan, allowed)

    out_path = docx_build.plan_output_path(new_plan, plan_id)
    docx_build.build_docx(new_plan, out_path)

    return db.update_plan(
        plan_id,
        plan_json=new_plan,
        docx_path=str(out_path),
        warnings=(row.get("warnings") or []) + warnings,
    )  # type: ignore[return-value]
