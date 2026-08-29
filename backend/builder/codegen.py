"""The builder-codegen attempt loop: generate a declarative layout spec,
render it against a synthetic fixture, verify it visually against the real
uploaded template, and retry with feedback up to a hard cap. A layout reaches
teachers only after both visual judges pass it.

`schools.builder_status` reaches 'verified' one of three ways, all
only after the evidence below supports it:

1. **Clean auto-verify** (run_codegen_job's main loop) — an attempt passes
   both independent vision judges within the attempt cap. This used to ALSO
   require the template's own separate content analysis to have cleared its
   own strict bar (school_templates.auto_activated) — loosened so a school
   starts generating real documents against its own AI-drafted format as
   soon as the layout itself checks out, rather than waiting on that
   separate, slower review too. That content review is NOT skipped:
   template_status still only reaches 'active' through
   template_intake._maybe_auto_activate or an explicit admin approve, and
   docx_build.bulk_builder_readiness reports 'ready_unverified' (not
   'ready') for exactly this window, so the UI keeps saying that review
   hasn't finished even while the document being generated already
   reflects it.
2. **Manual approve** (db.approve_builder_codegen_job / the
   POST /admin/builder-codegen/{job_id}/approve route) — still there for an
   admin who wants to intervene directly (e.g. a job that failed outright
   with no usable spec at all).

Rejected attempts remain in the admin queue for inspection and retry; they do
not produce a usable renderer.

Entry point: run_codegen_job(job_id), called by the worker loop
(backend/server.py's startup hook polling db.claim_next_builder_codegen_job).
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from .. import db, llm, storage
from ..config import settings
from . import rasterize
from .fixtures import fixture_expectations, synthetic_week_fixture
from .generic_renderer import SpecRenderError
from .generic_renderer import render as render_spec
from .spec_validate import validate_spec_against_analysis

log = logging.getLogger("flexedacademy.builder.codegen")

_ATTEMPT_ARTIFACT_DIR = Path("uploads/builder_codegen")


def _judge_verdict_passed(verdict: dict) -> bool:
    return bool(verdict.get("pass")) and isinstance(verdict.get("confidence"), (int, float)) and verdict["confidence"] >= 0.7


def _run_one_attempt(
    *,
    job: dict,
    attempt_number: int,
    user_id: str,
    structure_summary: str,
    analysis: dict,
    original_images_b64: list[str],
    fixture: dict,
    expectations: list[str],
    prior_feedback: str | None,
) -> tuple[bool, dict]:
    """Returns (passed, attempt_row). Never raises — any failure at any step
    becomes a failed, persisted attempt with an explanatory feedback string
    for the next attempt's prompt, same "turn a crash into a finding, not a
    500" contract template_intake.py's own stages already follow."""
    spec = llm.generate_layout_spec(
        user_id, structure_summary, analysis.get("sections") or [], prior_feedback=prior_feedback
    )

    validation_findings = validate_spec_against_analysis(spec, analysis)
    if validation_findings:
        feedback = "The spec was rejected before rendering: " + "; ".join(validation_findings)
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    artifact_dir = _ATTEMPT_ARTIFACT_DIR / job["id"]
    artifact_dir.mkdir(parents=True, exist_ok=True)
    sample_docx = artifact_dir / f"attempt_{attempt_number}.docx"

    try:
        render_spec(spec, fixture, str(sample_docx))
    except SpecRenderError as e:
        feedback = f"The spec failed to render: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}
    except Exception as e:  # noqa: BLE001 — any renderer crash is a finding, not a job-ending exception
        feedback = f"The spec caused an unexpected rendering error: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=None, judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    try:
        generated_images_b64 = rasterize.docx_to_images(sample_docx)
        generated_images_b64 = rasterize.images_to_b64_png(generated_images_b64)
    except Exception as e:  # noqa: BLE001
        feedback = f"The rendered sample could not be rasterized for review: {e}"
        attempt = db.record_builder_codegen_attempt(
            job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
            render_image_path=str(sample_docx), judge1_json=None, judge2_json=None, passed=False,
        )
        return False, {**attempt, "_feedback": feedback}

    judge1 = llm.judge_builder_render(
        user_id, original_images_b64=original_images_b64, generated_images_b64=generated_images_b64,
        layout_spec=spec, fixture_expectations=expectations,
    )
    judge2 = llm.judge_builder_render(
        user_id, original_images_b64=original_images_b64, generated_images_b64=generated_images_b64,
        layout_spec=spec, fixture_expectations=expectations,
    )
    passed = _judge_verdict_passed(judge1) and _judge_verdict_passed(judge2)

    attempt = db.record_builder_codegen_attempt(
        job["id"], attempt_number=attempt_number, layout_spec_json=json.dumps(spec),
        render_image_path=str(sample_docx), judge1_json=json.dumps(judge1), judge2_json=json.dumps(judge2),
        passed=passed,
    )
    if passed:
        return True, {**attempt, "_spec": spec}

    feedback = (
        f"Judge 1: pass={judge1.get('pass')}, defects={judge1.get('visual_defects')}, "
        f"field issues={[c for c in judge1.get('per_field_checks', []) if not c.get('correct_cell')]}, "
        f"reasoning: {judge1.get('reasoning')}\n"
        f"Judge 2: pass={judge2.get('pass')}, defects={judge2.get('visual_defects')}, "
        f"field issues={[c for c in judge2.get('per_field_checks', []) if not c.get('correct_cell')]}, "
        f"reasoning: {judge2.get('reasoning')}"
    )
    return False, {**attempt, "_feedback": feedback}


def _meets_auto_verify_bar(template: dict) -> bool:
    """True whenever this job's own quality bar was cleared — an attempt
    that passed BOTH independent vision judges (_judge_verdict_passed on
    judge1 and judge2, above; this is only ever checked after
    db.mark_builder_codegen_job_succeeded, which itself only fires on that
    same pass). That bar alone is what makes the generated builder USABLE
    (see docx_build.builder()'s builder_status=='verified' branch, entered
    even while the template's own template_status is still 'pending') — a
    deliberate choice to let a school start generating documents against
    its own AI-drafted format right away rather than sit on Florence's
    layout until a human has separately reviewed the upload, since the
    vision-judge pass is itself a real (if imperfect) correctness check.

    Previously this also required school_templates.auto_activated (the
    template's own strictest content bar: zero findings, confidence>=0.9,
    model-recommended) — decoupled so a clean codegen result doesn't sit
    idle behind an unrelated, stricter review. That review is untouched:
    template_status still only reaches 'active' through
    template_intake._maybe_auto_activate or an explicit admin approve, and
    docx_build.bulk_builder_readiness reports this state as
    'ready_unverified' (not 'ready') precisely so the UI keeps saying that
    review hasn't finished, even though the document being generated right
    now already reflects the school's own format."""
    return True


def run_codegen_job(job_id: str) -> None:
    """Runs one job to completion (succeeded or failed_needs_human) — the
    worker loop calls this once per claimed job, synchronously; a job is
    expected to take on the order of minutes (multiple LLM calls + LibreOffice
    renders), which is exactly why this lives behind a durable queue instead
    of a request handler or fire-and-forget BackgroundTasks."""
    job = db.get_builder_codegen_job(job_id)
    if not job:
        log.warning("run_codegen_job: job %s no longer exists", job_id)
        return

    template = db.get_school_template(job["template_id"])
    if not template or not template.get("structure_json") or not template.get("analysis_summary"):
        db.mark_builder_codegen_job_failed(job_id, "The template's analysis is missing or incomplete — cannot generate a spec from it.")
        return

    structure = json.loads(template["structure_json"])
    analysis = json.loads(template["analysis_summary"])

    from ..template_intake import (
        _summarize_for_llm,  # local import: avoid a hard import cycle at module load
    )
    structure_summary = _summarize_for_llm(structure)

    original_path = Path(template["file_path"])
    # A school's uploaded template is only ever WRITTEN by the instance that
    # handled the upload (routes/school_calendars.py's upload endpoint) —
    # Render containers are ephemeral, so on any OTHER instance (a redeploy,
    # a restart, a second replica) that local file simply doesn't exist,
    # even though the row referencing it is right there in Postgres. This
    # produced a very confusing LibreOffice error ("source file could not
    # be loaded") that looked like an environment problem but was really a
    # missing-file problem. storage.mirror_file backs up every upload to
    # Supabase Storage already (see the upload endpoint); ensure_local is
    # the same self-heal retrieval.load_chunks() and db.py's QTI restore
    # already use — a no-op if the file's already there.
    storage.ensure_local(original_path)
    try:
        original_images_b64 = rasterize.file_to_b64_png(original_path)
    except Exception as e:  # noqa: BLE001
        db.mark_builder_codegen_job_failed(job_id, f"Could not rasterize the original uploaded template for comparison: {e}")
        return

    fixture = synthetic_week_fixture(analysis)
    expectations = fixture_expectations(fixture)
    user_id = template.get("uploaded_by") or ""

    prior_feedback: str | None = None
    attempts_seen: list[dict] = []
    for attempt_number in range(1, settings.builder_codegen_max_attempts + 1):
        passed, attempt = _run_one_attempt(
            job=job, attempt_number=attempt_number, user_id=user_id,
            structure_summary=structure_summary, analysis=analysis,
            original_images_b64=original_images_b64, fixture=fixture, expectations=expectations,
            prior_feedback=prior_feedback,
        )
        attempts_seen.append(attempt)
        if passed:
            db.mark_builder_codegen_job_succeeded(job_id, json.dumps(attempt["_spec"]))
            log.info("builder codegen job %s succeeded on attempt %d", job_id, attempt_number)
            if _meets_auto_verify_bar(template):
                db.mark_builder_codegen_job_auto_verified(job_id)
                log.info(
                    "builder codegen job %s auto-verified for school %s "
                    "(both vision judges passed; template's own content review "
                    "still runs independently)",
                    job_id, job["school_id"],
                )
            return
        prior_feedback = attempt.get("_feedback")
        log.info("builder codegen job %s attempt %d failed: %s", job_id, attempt_number, prior_feedback)

    _fail_after_exhausted_attempts(job_id, attempts_seen)


def _fail_after_exhausted_attempts(job_id: str, attempts: list[dict]) -> None:
    """Keep every rejected layout out of production.

    A visually wrong district form is not a recoverable approximation. The
    attempt history remains available for admin inspection and retry, but no
    rejected spec may mark a school verified or become its active renderer.
    """
    db.mark_builder_codegen_job_failed(
        job_id,
        f"No attempt passed both visual judges within {len(attempts)} attempts. "
        "The generated specs remain available for review, but none was activated.",
    )
